import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Use Node's built-in runner.
import { test } from 'node:test'
import { createDependencySchedule, dependencySettings } from './dependencySchedule.mjs'
import { updateDependencies } from './dependencyUpdates.mjs'

const repo = 'owner/project'

test('startup coalesces missed weeks into one run and persists its result', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dependency-schedule-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const now = new Date(2026, 10, 24, 12).getTime()
  const dependencyUpdates = dependencySettings({
    packages: ['one', 'two'],
    day: 1,
    time: '09:00',
    mode: 'patch',
  }, undefined, new Date(2026, 10, 1).getTime())
  const url = 'https://github.com/owner/project/pull/10'
  let calls = 0
  const start = () => createDependencySchedule({
    stateFile: path.join(dir, 'checks.json'),
    settings: () => ({ dependencyUpdates }),
    async update() {
      calls++
      return { url }
    },
    now: () => now,
  })

  const schedule = start()
  await Promise.all([
    schedule.tick(repo),
    schedule.tick(repo),
  ])
  const restarted = start()
  await restarted.tick(repo)

  assert.equal(calls, 1)
  assert.deepEqual(restarted.status(repo), {
    nextAt: new Date(2026, 10, 30, 9).getTime(),
    last: {
      at: now,
      result: 'created',
      url,
    },
  })
})

function updateFixture(t) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'dependency-project-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const versions = {
    one: [
      '1.2.0',
      '1.2.1',
      '1.3.0',
      '2.0.0',
      '1.2.2-beta.0',
    ],
    two: ['1.2.0', '1.2.3', '1.4.0', '3.0.0'],
  }
  const effects = []
  return {
    effects,
    versions,
    async command(cmd, args, cwd) {
      if (cmd === 'git') {
        if (args.includes('clone')) {
          execFileSync('git', ['init', '--initial-branch=main', cwd], { stdio: 'ignore' })
          writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
            dependencies: { one: '^1.2.0' },
            devDependencies: { two: '~1.2.0' },
            scripts: { test: 'node --test' },
          }, null, 2))
          writeFileSync(path.join(cwd, 'package-lock.json'), 'locked')
          writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n')
          execFileSync('git', ['add', '.'], { cwd })
          execFileSync('git', [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-m',
            'Base',
          ], { cwd })
          return ''
        }
        if (args.includes('push')) {
          effects.push('push')
          return ''
        }
        return execFileSync('git', args, {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
      if (cmd === 'gh' && args[0] === 'api')
        return '{"default_branch":"main"}'
      if (cmd === 'gh' && args[0] === 'pr') {
        effects.push(args)
        return `https://github.com/${repo}/pull/10\n`
      }
      if (cmd === 'npm' && args[0] === 'view')
        return JSON.stringify(versions[args.at(-2)])
      if (cmd === 'npm' && args[0] === 'install') {
        const { dependencies, devDependencies } = JSON.parse(readFileSync(path.join(cwd, 'package.json')))
        writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({
          ...dependencies,
          ...devDependencies,
        }))
        return ''
      }
      if (cmd === 'npm' && args[0] === 'ci') {
        const lock = readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')
        const installed = lock === 'locked'
          ? { one: '1.2.0', two: '1.2.0' }
          : JSON.parse(lock)
        for (const [name, spec] of Object.entries(installed)) {
          const packageDir = path.join(cwd, 'node_modules', name)
          mkdirSync(packageDir, { recursive: true })
          writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
            name,
            version: spec.replace(/^[~^]/, ''),
          }))
        }
        return ''
      }
      if (cmd === '/bin/sh' || (cmd === 'npm' && args[0] === 'run')) {
        const manifest = JSON.parse(readFileSync(path.join(cwd, 'package.json')))
        effects.push([manifest.dependencies.one, manifest.devDependencies.two])
        if (args.includes('exit 1'))
          throw new Error('код 1')
        return ''
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`)
    },
    dir: project,
  }
}

test('a failed run is visible after restart and is not repeated in the same week', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dependency-schedule-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const enabled = new Date(2026, 10, 22, 12).getTime()
  const due = new Date(2026, 10, 23, 9).getTime()
  let now = enabled
  let calls = 0
  const dependencyUpdates = dependencySettings({
    packages: ['one'],
    day: 1,
    time: '09:00',
  }, undefined, enabled)
  const options = {
    stateFile: path.join(dir, 'checks.json'),
    settings: () => ({ dependencyUpdates }),
    async update() {
      calls++
      throw new Error('npm test: код 1')
    },
    now: () => now,
  }
  const schedule = createDependencySchedule(options)
  await schedule.tick(repo)
  assert.equal(calls, 0)
  assert.equal(schedule.status(repo).nextAt, due)
  now = due
  await schedule.tick(repo)
  const restarted = createDependencySchedule(options)
  await restarted.tick(repo)
  assert.equal(calls, 1)
  assert.deepEqual(restarted.status(repo).last, { at: due, result: 'failed', error: 'npm test: код 1' })
})

function runUpdate(fixture, mode = 'patch', checks = 'npm test', packages = ['one', 'two']) {
  const config = {
    checks,
    dependencyUpdates: { packages, mode },
  }
  return updateDependencies(repo, config, 'agent/dependencies-test', {
    command: fixture.command,
    botName: 'Test',
    botEmail: 'test@example.com',
    tempDir: fixture.dir,
  })
}

test('one draft includes both allowed updates after the checks pass', async (t) => {
  const fixture = updateFixture(t)
  const { url } = await runUpdate(fixture)
  assert.equal(url, `https://github.com/${repo}/pull/10`)
  assert.deepEqual(fixture.effects.slice(0, 2), [
    ['^1.2.1', '~1.2.3'],
    'push',
  ])
  assert.equal(fixture.effects.length, 3)
  assert.ok(fixture.effects[2].includes('--draft'))
  assert.match(fixture.effects[2].at(-1), /one.*1\.2\.1[\s\S]*two.*1\.2\.3/)
})

test('minor mode allows the highest stable version within the same major', async (t) => {
  const fixture = updateFixture(t)
  await runUpdate(fixture, 'minor', '')
  assert.deepEqual(fixture.effects[0], ['^1.3.0', '~1.4.0'])
})

test('a failed check leaves the cause and prevents a push or PR', async (t) => {
  const fixture = updateFixture(t)
  await assert.rejects(runUpdate(fixture, 'patch', 'exit 1'), /exit 1: код 1/)
  assert.deepEqual(fixture.effects, [
    ['^1.2.1', '~1.2.3'],
  ])
})

test('no compatible updates means no checks or publication', async (t) => {
  const fixture = updateFixture(t)
  fixture.versions.one = ['1.2.0', '1.3.0', '2.0.0']
  fixture.versions.two = ['1.2.0', '1.2.1-beta.0', '3.0.0']
  assert.deepEqual(await runUpdate(fixture), { skipped: [] })
  assert.deepEqual(fixture.effects, [])
})

test('quoted commas stay inside configured checks and unsupported names are reported', async (t) => {
  const fixture = updateFixture(t)
  const { skipped } = await runUpdate(fixture, 'patch', 'node -e \'console.log(1, 2)\', npm test', ['one', 'missing'])
  assert.deepEqual(skipped, ['missing'])
  assert.equal(fixture.effects.length, 4)
  assert.match(fixture.effects[3].at(-1), /Пропущены.*missing/)
})
