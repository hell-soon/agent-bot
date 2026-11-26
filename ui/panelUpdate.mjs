import { execFile, fork } from 'node:child_process'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const releases = path.join(root, 'logs', 'ui', 'releases')
const activeFile = path.join(releases, 'active')
const remote = 'https://github.com/hell-soon/agent-bot.git'
const branch = 'refs/heads/main'
const revision = /^[a-f0-9]{40}$/

async function command(cwd, program, args, timeout = 30000) {
  const { stdout } = await exec(program, args, { cwd, timeout, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

async function activate(commit) {
  const pending = `${activeFile}.${process.pid}`
  await fs.writeFile(pending, commit)
  await fs.rename(pending, activeFile)
}

async function build(dir) {
  const ui = path.join(dir, 'ui')
  await command(ui, 'bun', ['install', '--frozen-lockfile'], 300000)
  await command(ui, 'bun', ['run', 'build'], 180000)
  const dist = path.join(ui, 'dist')
  const html = await fs.readFile(path.join(dist, 'index.html'), 'utf8')
  const assets = [
    ...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g),
  ]
  if (!assets.length)
    throw new Error('Сборка панели не содержит ресурсов')
  await Promise.all(assets.map(([, asset]) => fs.access(path.join(dist, asset))))
}

async function prepare(commit) {
  const staging = await fs.mkdtemp(path.join(releases, 'build-'))
  try {
    await command(staging, 'git', ['init', '-q'])
    await command(staging, 'git', ['fetch', '--depth=1', remote, commit], 90000)
    await command(staging, 'git', ['checkout', '--detach', 'FETCH_HEAD'])
    await build(staging)
    const target = path.join(releases, commit)
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target)
  }
  finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

let installed
let state
let child
let stopped = false

function publish(patch) {
  state = {
    ...state,
    ...patch,
  }
  if (child?.connected)
    child.send({ type: 'panel-update-state', state }, () => {})
}

function stop(server, signal) {
  if (!server.pid || server.exitCode !== null || server.signalCode !== null)
    return Promise.resolve()
  return new Promise((resolve) => {
    server.once('exit', resolve)
    server.kill(signal)
  })
}

async function start(version) {
  const server = fork(path.join(version.dir, 'ui', 'server.mjs'), [], {
    cwd: root,
    env: { ...process.env, BOT_PANEL_ROOT: root, BOT_PANEL_COMMIT: version.commit },
  })
  child = server
  try {
    await new Promise((resolve, reject) => {
      let timeout
      let onMessage
      let exited
      const finish = (error) => {
        clearTimeout(timeout)
        server.removeListener('message', onMessage)
        server.removeListener('exit', exited)
        server.removeListener('error', finish)
        if (error)
          reject(error)
        else
          resolve()
      }
      exited = () => finish(new Error('Процесс панели завершился при запуске'))
      onMessage = (message) => {
        if (message.type === 'panel-ready')
          finish()
      }
      timeout = setTimeout(() => finish(new Error('Панель не ответила при запуске')), 15000)
      server.on('message', onMessage)
      server.once('exit', exited)
      server.once('error', finish)
    })
  }
  catch (error) {
    await stop(server, 'SIGKILL')
    throw error
  }
  return server
}

function watch(server) {
  if (server.exitCode !== null || server.signalCode !== null)
    process.exit(1)
  server.once('exit', () => {
    if (state.phase !== 'restarting' || stopped)
      process.exit(0)
  })
  server.on('message', (message) => {
    if (message.type === 'panel-update-check')
      void check(false)
    if (message.type === 'panel-update-install')
      void check(true)
    if (message.type === 'panel-update-drained' && state.phase === 'waiting') {
      void switchVersion(server).catch((error) => {
        console.error('Восстановление панели:', error.message)
        process.exit(1)
      })
    }
  })
  publish({})
  server.send({ type: 'panel-activate' })
}

async function check(install) {
  if (!['idle', 'error'].includes(state.phase))
    return
  publish({ phase: 'checking', error: '' })
  try {
    const commit = (await command(root, 'git', [
      'ls-remote',
      '--exit-code',
      remote,
      branch,
    ])).split(/\s+/)[0]
    if (!revision.test(commit))
      throw new Error('Не удалось определить версию main')
    const available = commit === installed.commit
      ? ''
      : commit
    if (!available || !install) {
      publish({ available, phase: 'idle' })
      return
    }
    publish({ available, phase: 'building' })
    await prepare(commit)
    publish({ phase: 'waiting' })
  }
  catch (error) {
    console.error('Обновление панели:', error.message)
    publish({ phase: 'error', error: 'Не удалось проверить или собрать обновление. Подробности в logs/ui.log.' })
  }
}

async function switchVersion(previous) {
  const commit = state.available
  publish({ phase: 'restarting' })
  await new Promise((resolve) => {
    previous.once('exit', resolve)
    previous.send({ type: 'panel-update-shutdown' }, (error) => {
      if (error)
        previous.kill('SIGTERM')
    })
  })
  const candidate = {
    dir: path.join(releases, commit),
    commit,
  }
  let server
  try {
    server = await start(candidate)
    await activate(commit)
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error('Новая панель завершилась до переключения')
  }
  catch (error) {
    console.error('Запуск обновления панели:', error.message)
    if (server)
      await stop(server, 'SIGKILL')
    await activate(installed.dir === root
      ? ''
      : installed.commit)
    state = { ...state, phase: 'error', error: 'Новая версия не запустилась. Возвращена предыдущая версия.' }
    watch(await start(installed))
    return
  }
  installed = candidate
  state = {
    current: commit,
    available: '',
    phase: 'idle',
    error: '',
  }
  watch(server)
}

process.on('SIGTERM', () => {
  stopped = true
  child?.kill('SIGTERM')
})
async function boot() {
  const source = await command(root, 'git', ['rev-parse', 'HEAD']).catch(() => '')
  await fs.mkdir(releases, { recursive: true })
  const lock = path.join(releases, 'supervisor.pid')
  const claim = () => fs.writeFile(lock, String(process.pid), { flag: 'wx' })
  try {
    await claim()
  }
  catch (error) {
    if (error.code !== 'EEXIST')
      throw error
    const owner = Number(await fs.readFile(lock, 'utf8'))
    if (!Number.isSafeInteger(owner) || owner <= 0)
      throw error
    try {
      process.kill(owner, 0)
      return
    }
    catch (error) {
      if (error.code !== 'ESRCH')
        throw error
    }
    await fs.unlink(lock)
    await claim()
  }
  process.once('exit', () => rmSync(lock, { force: true }))

  const active = (await fs.readFile(activeFile, 'utf8').catch(() => '')).trim()
  installed = revision.test(active)
    ? {
        dir: path.join(releases, active),
        commit: active,
      }
    : { dir: root, commit: source }
  state = {
    current: installed.commit,
    available: '',
    phase: 'idle',
    error: '',
  }
  try {
    watch(await start(installed))
  }
  catch (error) {
    if (installed.dir === root)
      throw error
    await activate('')
    installed = { dir: root, commit: source }
    state = {
      current: source,
      available: '',
      phase: 'error',
      error: 'Сохранённая версия не запустилась. Запущена версия из папки установки.',
    }
    watch(await start(installed))
  }
}

boot().catch((error) => {
  console.error('Запуск панели:', error.message)
  process.exitCode = 1
})
