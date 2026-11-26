import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const MANAGERS = {
  'package-lock.json': {
    name: 'npm',
    resolve: [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    install: ['ci', '--no-audit', '--no-fund'],
  },
  'pnpm-lock.yaml': {
    name: 'pnpm',
    resolve: [
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--no-frozen-lockfile',
    ],
    install: ['install', '--frozen-lockfile'],
  },
  'bun.lock': {
    name: 'bun',
    resolve: ['install', '--lockfile-only', '--ignore-scripts'],
    install: ['install', '--frozen-lockfile'],
  },
}
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']
const CHECKS = ['typecheck', 'lint', 'test', 'build']
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function splitChecks(input = '') {
  const checks = []
  let start = 0
  let quote
  const commaList = !input.trim().includes('\n')
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (character === '\\' && quote !== '\'') {
      index++
    }
    else if (quote) {
      if (character === quote)
        quote = undefined
    }
    else if (character === '\'' || character === '"' || character === '`') {
      quote = character
    }
    else if (character === '\n' || (commaList && character === ',' && /\s/.test(input[index + 1] || ''))) {
      checks.push(input.slice(start, index).trim())
      start = index + 1
    }
  }
  checks.push(input.slice(start).trim())
  return checks.filter(Boolean)
}

function versionOf(value) {
  const version = typeof value === 'string' && STABLE.exec(value)?.slice(1).map(Number)
  return version && version.every(Number.isSafeInteger)
    ? version
    : null
}

function targetVersion(current, versions, mode) {
  const [major, minor, patch] = versionOf(current)
  let target = current
  let bestMinor = minor
  let bestPatch = patch
  for (const item of versions) {
    const candidate = versionOf(item)
    if (!candidate)
      continue
    const [nextMajor, nextMinor, nextPatch] = candidate
    if (nextMajor === major && (mode === 'minor' || nextMinor === minor)
      && (nextMinor > bestMinor || (nextMinor === bestMinor && nextPatch > bestPatch))) {
      target = item
      bestMinor = nextMinor
      bestPatch = nextPatch
    }
  }
  return target
}

function projectsIn(root, tracked, packages) {
  const projects = new Map()
  const files = new Set(tracked.split('\0').filter(Boolean))
  for (const lock of files) {
    const lockName = path.posix.basename(lock)
    if (!Object.hasOwn(MANAGERS, lockName))
      continue
    const manager = MANAGERS[lockName]
    const dir = path.posix.dirname(lock)
    const manifest = path.posix.join(dir, 'package.json')
    if (!files.has(manifest))
      continue
    const cwd = path.join(root, dir)
    const manifestPath = path.join(root, manifest)
    if (!lstatSync(manifestPath).isFile() || !lstatSync(path.join(root, lock)).isFile())
      continue
    const raw = readFileSync(manifestPath, 'utf8')
    const data = JSON.parse(raw)
    const declared = typeof data.packageManager === 'string' && data.packageManager.split('@')[0]
    if (declared && declared !== manager.name)
      continue
    const entries = packages.flatMap((name) => {
      const specs = SECTIONS.flatMap((section) => {
        const spec = data[section]?.[name]
        return typeof spec === 'string'
          ? [
              { section, spec },
            ]
          : []
      })
      return specs.length && specs.every(({ spec }) => versionOf(spec.replace(/^[~^]/, '')))
        ? [
            { name, specs },
          ]
        : []
    })
    if (!entries.length)
      continue
    if (projects.has(dir))
      throw new Error(`В ${dir} несколько lock-файлов. Укажите packageManager в package.json`)
    projects.set(dir, {
      cwd,
      manifest,
      lock,
      manager,
      raw,
      data,
      entries,
    })
  }
  return [
    ...projects.values(),
  ]
}

function installedVersion(cwd, name) {
  try {
    const installed = JSON.parse(readFileSync(path.join(cwd, 'node_modules', name, 'package.json'), 'utf8'))
    return installed.name === name && versionOf(installed.version)
      ? installed.version
      : null
  }
  catch (error) {
    if (error.code !== 'ENOENT')
      throw error
    return null
  }
}

function writeManifest(project) {
  const { cwd, raw, data } = project
  const indent = raw.match(/\n([\t ]+)"/)?.[1] || ''
  const newline = raw.includes('\r\n')
    ? '\r\n'
    : '\n'
  const finalNewline = raw.endsWith('\n')
    ? newline
    : ''
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(data, null, indent).replaceAll('\n', newline) + finalNewline)
}

async function prepareProject(project, mode, run) {
  const { cwd, manager, data, entries } = project
  const frozenInstall = [...manager.install, '--ignore-scripts']
  await run(manager.name, frozenInstall, cwd)
  const updates = []
  for (const { name, specs } of entries) {
    const current = installedVersion(cwd, name)
    if (!current) {
      if (specs.every(({ section }) => section === 'optionalDependencies'))
        continue
      throw new Error(`Не удалось определить стабильную версию ${name} после установки`)
    }
    const available = JSON.parse(await run('npm', [
      'view',
      '--json',
      '--',
      name,
      'versions',
    ], cwd))
    const target = targetVersion(current, Array.isArray(available)
      ? available
      : [available], mode)
    if (target !== current)
      updates.push({ name, specs, current, target })
  }
  if (!updates.length)
    return []

  // Resolve exact targets first, then restore the project's original range operators.
  for (const { name, specs, target } of updates) {
    for (const { section } of specs)
      data[section][name] = target
  }
  writeManifest(project)
  await run(manager.name, manager.resolve, cwd)
  let restoredRanges = false
  for (const { name, specs, target } of updates) {
    for (const { section, spec } of specs) {
      const prefix = spec.match(/^[~^]/)?.[0]
      if (prefix) {
        data[section][name] = prefix + target
        restoredRanges = true
      }
    }
  }
  if (restoredRanges) {
    writeManifest(project)
    await run(manager.name, manager.resolve, cwd)
  }
  const paths = [
    path.join(cwd, 'package.json'),
    path.join(cwd, path.posix.basename(project.lock)),
  ]
  const prepared = paths.map(file => readFileSync(file))
  // Validate a clean install of the versions pinned by the updated lockfile.
  rmSync(path.join(cwd, 'node_modules'), { recursive: true, force: true })
  await run(manager.name, frozenInstall, cwd)
  if (paths.some((file, index) => !readFileSync(file).equals(prepared[index])))
    throw new Error('Установка изменила подготовленные файлы обновления')
  for (const { name, target } of updates) {
    if (installedVersion(cwd, name) !== target)
      throw new Error(`Lock-файл не зафиксировал ${name}@${target}`)
  }
  return updates
}

export async function recoverDependencyPull(repo, branch, command) {
  const head = encodeURIComponent(`${repo.split('/')[0]}:${branch}`)
  const rows = JSON.parse(await command('gh', ['api', `repos/${repo}/pulls?state=all&head=${head}`]))
  return rows[0]?.html_url
}

export async function updateDependencies(repo, config, branch, { command, botName, botEmail, tempDir = os.tmpdir(), canPublish = () => true }) {
  const root = mkdtempSync(path.join(tempDir, 'agent-dependencies-'))
  const run = async (cmd, args, cwd = root) => {
    try {
      return await command(cmd, args, cwd)
    }
    catch (error) {
      const operation = cmd === '/bin/sh'
        ? args[1]
        : `${cmd} ${args[0]}`
      const location = path.relative(root, cwd)
      throw new Error(`${operation}${location
        ? ` (${location})`
        : ''}: ${error.message}`, { cause: error })
    }
  }
  const git = args => run('git', args)
  const gitRemote = args => git([
    '-c',
    'credential.helper=',
    '-c',
    'credential.https://github.com.helper=!gh auth git-credential',
    ...args,
  ])
  try {
    const base = config.base || JSON.parse(await run('gh', ['api', `repos/${repo}`])).default_branch
    if (!base || base === branch)
      throw new Error('Не удалось выбрать безопасную базовую ветку')
    await gitRemote([
      'clone',
      '--single-branch',
      '--branch',
      base,
      '--',
      `https://github.com/${repo}.git`,
      root,
    ])
    const { packages, mode } = config.dependencyUpdates
    const projects = projectsIn(root, await git(['ls-files', '-z']), packages)
    const supported = new Set(projects.flatMap(project => project.entries.map(entry => entry.name)))
    const skipped = packages.filter(name => !supported.has(name))

    const changed = []
    const summary = []
    const fallbackChecks = []
    const configuredChecks = splitChecks(config.checks)
    const checkRoots = new Set([root])
    for (const project of projects) {
      const updates = await prepareProject(project, mode, run)
      if (!updates.length)
        continue
      changed.push(project.manifest, project.lock)
      checkRoots.add(project.cwd)
      for (const { name, current, target } of updates)
        summary.push(`- \`${project.manifest}\` · \`${name}\` ${current} → ${target}`)
      for (const script of CHECKS) {
        if (project.data.scripts?.[script]) {
          fallbackChecks.push([
            project.manager.name,
            ['run', script],
            project.cwd,
            `${project.manager.name} run ${script} (${project.manifest})`,
          ])
        }
      }
    }
    if (!changed.length)
      return { skipped }

    if (!configuredChecks.length && [...checkRoots].some(cwd =>
      ['AGENTS.md', 'CLAUDE.md'].some(file => existsSync(path.join(cwd, file))))) {
      throw new Error('Перенесите команды проекта из AGENTS.md или CLAUDE.md в поле «Команды проверки»')
    }

    const specs = changed.map(file => `:(literal)${file}`)
    await git(['add', '--', ...specs])
    const tree = await git(['write-tree'])
    const checks = configuredChecks.length
      ? configuredChecks.map(command => [
          '/bin/sh',
          ['-c', command],
          root,
        ])
      : fallbackChecks
    for (const [cmd, args, cwd] of checks)
      await run(cmd, args, cwd)
    if ((await git(['write-tree'])) !== tree || (await git(['diff', '--name-only', '--', ...specs])).trim())
      throw new Error('Команды проверки изменили подготовленные файлы обновления')
    if (!canPublish())
      throw new Error('Настройки обновления изменились во время проверки')

    await git(['switch', '-c', branch])
    await git([
      '-c',
      `user.name=${botName}`,
      '-c',
      `user.email=${botEmail}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Обновить выбранные зависимости',
    ])
    await gitRemote(['push', 'origin', `HEAD:refs/heads/${branch}`])
    const verification = configuredChecks.length
      ? `Команды из настроек репозитория (${checks.length})`
      : fallbackChecks.map(([, , , label]) => `- \`${label}\``).join('\n') || 'Установка по обновлённым lock-файлам'
    const skippedSummary = skipped.length
      ? `\n\nПропущены пакеты без поддерживаемой записи в package.json · ${skipped.join(', ')}`
      : ''
    const body = `## Обновления\n\n${summary.join('\n')}${skippedSummary}\n\n## Проверено\n\n${verification}`
    try {
      const output = await run('gh', [
        'pr',
        'create',
        '--repo',
        repo,
        '--base',
        base,
        '--head',
        branch,
        '--draft',
        '--title',
        'Обновить выбранные зависимости',
        '--body',
        body,
      ])
      const url = output.trim().split('\n').at(-1) || await recoverDependencyPull(repo, branch, command)
      if (!url)
        throw new Error('GitHub не вернул ссылку на созданный PR')
      return { url, skipped }
    }
    catch (error) {
      const url = await recoverDependencyPull(repo, branch, command).catch(() => null)
      if (url)
        return { url, skipped }
      throw error
    }
  }
  finally {
    try {
      rmSync(root, { recursive: true, force: true })
    }
    catch (error) {
      process.emitWarning(`Не удалось удалить временную копию ${root}: ${error.message}`)
    }
  }
}
