import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

export function dependencySettings(input, previous, now = Date.now()) {
  if (!Array.isArray(input?.packages) || input.packages.length > 100
    || input.packages.some(name => typeof name !== 'string' || name.length > 214 || !PACKAGE.test(name))) {
    throw new Error('Укажите до 100 имён npm-пакетов')
  }
  const { day, time, mode = 'patch' } = input
  if (!Number.isInteger(day) || day < 0 || day > 6 || typeof time !== 'string'
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !['patch', 'minor'].includes(mode)) {
    throw new Error('Укажите день, время и режим обновления')
  }
  const packages = [
    ...new Set(input.packages),
  ]
  const sameSchedule = previous?.enabledAt && previous.day === day && previous.time === time
  const enabledAt = packages.length
    ? (sameSchedule ? previous.enabledAt : now)
    : null
  return { packages, day, time, mode, enabledAt }
}

function scheduledAt(config, now, dayOffset = 0) {
  const date = new Date(now)
  const [hour, minute] = config.time.split(':').map(Number)
  const daysSince = (date.getDay() - config.day + 7) % 7
  date.setDate(date.getDate() - daysSince + dayOffset)
  return date.setHours(hour, minute, 0, 0)
}

function windowFor(config, now) {
  if (!config?.enabledAt)
    return { due: null, next: null }
  const sameWeek = scheduledAt(config, now)
  return sameWeek > now
    ? {
        due: scheduledAt(config, now, -7),
        next: sameWeek,
      }
    : {
        due: sameWeek,
        next: scheduledAt(config, now, 7),
      }
}

export function createDependencySchedule({ stateFile, settings, update, recover, now = Date.now }) {
  let state = {}
  let readError
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (!state || typeof state !== 'object' || Array.isArray(state))
      throw new Error('неверный формат')
  }
  catch (error) {
    if (error.code !== 'ENOENT')
      readError = `Не удалось загрузить историю: ${error.message}`
  }
  const active = new Set()
  const writeErrors = new Map()

  function save(repo, entry) {
    const next = { ...state, [repo]: entry }
    const temp = `${stateFile}.tmp`
    writeFileSync(temp, JSON.stringify(next, null, 2))
    renameSync(temp, stateFile)
    state = next
    writeErrors.delete(repo)
  }

  function status(repo) {
    const { dependencyUpdates } = settings(repo)
    const { due, next } = windowFor(dependencyUpdates, now())
    const { at, result, url, error, skipped } = state?.[repo] || {}
    const historyError = readError || writeErrors.get(repo)
    return {
      nextAt: due > dependencyUpdates?.enabledAt && due > (state?.[repo]?.slot ?? 0)
        ? due
        : next,
      last: historyError
        ? { at: at ?? now(), result: 'failed', error: historyError }
        : result
          ? {
              at,
              result,
              ...(url && { url }),
              ...(error && { error }),
              ...(skipped?.length && { skipped }),
            }
          : null,
    }
  }

  async function tick(repo) {
    if (active.has(repo) || readError)
      return
    const config = settings(repo)
    let previous = state[repo]
    if (previous?.result !== 'running' && !config.dependencyUpdates?.enabledAt)
      return
    active.add(repo)
    try {
      if (previous?.result === 'running') {
        let url
        let error = 'Проверка прервана при остановке панели'
        try {
          url = await recover(repo, previous.branch)
        }
        catch (cause) {
          error = `${error}. Поиск PR: ${cause.message}`
        }
        previous = {
          ...previous,
          result: url ? 'created' : 'failed',
          ...(url
            ? { url }
            : { error }),
        }
        save(repo, previous)
      }

      const at = now()
      const current = settings(repo)
      const { due } = windowFor(current.dependencyUpdates, at)
      if (!(due > current.dependencyUpdates?.enabledAt && due > (previous?.slot ?? 0)))
        return
      const branch = `agent/dependencies-${due}-${randomUUID().slice(0, 8)}`
      const entry = { at, slot: due, branch }
      save(repo, { ...entry, result: 'running' })
      let outcome
      try {
        const { url, skipped } = await update(repo, current, branch)
        outcome = {
          result: url ? 'created' : 'current',
          url,
          skipped,
        }
      }
      catch (error) {
        outcome = { result: 'failed', error: error.message }
      }
      save(repo, {
        ...entry,
        ...outcome,
      })
    }
    catch (error) {
      writeErrors.set(repo, `Не удалось сохранить историю: ${error.message}`)
    }
    finally {
      active.delete(repo)
    }
  }

  return { status, tick }
}
