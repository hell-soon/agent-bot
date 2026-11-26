import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { findDocDrift, isDocument } from './docDrift.mjs'

const PAGE_SIZE = 100
const OVERLAP = 5 * 60 * 1000

export function createDocReview({ stateFile, settings, github, baseTree, updated = () => {}, now = Date.now }) {
  function loadState() {
    try {
      const data = JSON.parse(readFileSync(stateFile, 'utf8'))
      return data && typeof data === 'object' && !Array.isArray(data)
        ? data
        : null
    }
    catch (error) {
      return error.code === 'ENOENT'
        ? {}
        : null
    }
  }
  let state = loadState()
  const scans = new Set()
  const errors = new Set()
  const publishing = new Map()
  const entry = repo => state?.[repo] || {}

  function save(repo, next) {
    const data = { ...state, [repo]: next }
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(data), { mode: 0o600 })
    renameSync(`${stateFile}.tmp`, stateFile)
    state = data
  }

  function status(repo) {
    const { results = {}, issues = {} } = entry(repo)
    const enabled = Boolean(settings(repo).docReviewSince)
    const findings = Object.values(results).sort((a, b) => b.pr.mergedAt.localeCompare(a.pr.mergedAt)).flatMap(({ pr, findings }) => findings.map(finding => ({ ...finding, pr, issue: issues[finding.id]?.issue })))
    return {
      enabled,
      checking: enabled && scans.has(repo),
      error: enabled && (!state || errors.has(repo)),
      findings,
    }
  }

  async function* pages(repo, endpoint) {
    for (let page = 1; ; page++) {
      const rows = await github(repo, endpoint, { page, perPage: PAGE_SIZE })
      if (!Array.isArray(rows))
        throw new TypeError('Expected a GitHub list')
      yield* rows
      if (rows.length < PAGE_SIZE)
        return
    }
  }

  async function scan(repo) {
    const { docReviewSince: since, base: configuredBase } = settings(repo)
    if (!since || scans.has(repo))
      return
    const isCurrent = () => {
      const current = settings(repo)
      return current.docReviewSince === since && current.base === configuredBase
    }
    scans.add(repo)
    updated(repo)
    try {
      state ??= loadState()
      if (!state)
        throw new Error('Could not load documentation review state')
      const base = configuredBase || (await github(repo, '')).default_branch
      const scanAt = now()
      const saved = entry(repo).checkpoint
      const cutoff = saved?.since === since && saved.base === base
        ? Math.max(since, saved.at - OVERLAP)
        : since
      const pulls = new Map()
      for await (const pr of pages(repo, `pulls?state=closed&sort=updated&direction=desc&base=${encodeURIComponent(base)}`)) {
        if (!isCurrent())
          return
        if (Date.parse(pr.updated_at) < cutoff)
          break
        if (pr.merged_at && Date.parse(pr.merged_at) >= since && pr.base.ref === base && !entry(repo).results?.[pr.number])
          pulls.set(pr.number, pr)
      }

      let failed = false
      if (pulls.size && isCurrent()) {
        const tree = await baseTree(repo, base)
        const documents = new Map()
        for (const file of (await tree.list()).filter(isDocument))
          documents.set(file, await tree.read(file))

        for (const pr of [
          ...pulls.values(),
        ].sort((a, b) => a.merged_at.localeCompare(b.merged_at))) {
          if (!isCurrent())
            return
          try {
            const files = []
            for await (const file of pages(repo, `pulls/${pr.number}/files`))
              files.push(file)
            const findings = await findDocDrift(files, tree, documents, pr.merge_commit_sha)
            if (!isCurrent())
              return
            const result = {
              pr: {
                number: pr.number,
                title: pr.title,
                url: pr.html_url,
                mergedAt: pr.merged_at,
              },
              findings: findings.map(finding => ({
                ...finding,
                id: createHash('sha256').update(JSON.stringify([pr.number, finding])).digest('hex'),
              })),
            }
            const current = entry(repo)
            save(repo, {
              ...current,
              results: { ...current.results, [pr.number]: result },
            })
          }
          catch {
            failed = true
          }
        }
      }
      if (!isCurrent())
        return
      if (failed) {
        errors.add(repo)
      }
      else {
        save(repo, {
          ...entry(repo),
          checkpoint: { since, base, at: scanAt },
        })
        errors.delete(repo)
      }
    }
    catch {
      if (isCurrent())
        errors.add(repo)
    }
    finally {
      scans.delete(repo)
      updated(repo)
    }
  }

  function publish(repo, id) {
    const key = `${repo}:${id}`
    if (!publishing.has(key))
      publishing.set(key, createIssue(repo, id).finally(() => publishing.delete(key)))
    return publishing.get(key)
  }

  async function createIssue(repo, id) {
    const finding = status(repo).findings.find(f => f.id === id)
    if (!finding || finding.issue)
      return finding?.issue
    const previous = entry(repo).issues?.[id]
    const marker = `<!-- agent-bot:doc-review:${id} -->`
    const startedAt = previous?.startedAt ?? now()
    const keep = (issue) => {
      const current = entry(repo)
      save(repo, {
        ...current,
        issues: {
          ...current.issues,
          [id]: { startedAt, issue },
        },
      })
      updated(repo)
      return issue
    }
    const link = issue => ({ number: issue.number, url: issue.html_url })
    if (previous) {
      // GitHub may have created the issue before the client lost the response.
      const since = new Date(startedAt - OVERLAP).toISOString()
      for await (const issue of pages(repo, `issues?state=all&since=${encodeURIComponent(since)}`)) {
        if (!issue.pull_request && issue.body?.split('\n').includes(marker))
          return keep(link(issue))
      }
    }
    else {
      keep()
    }
    const { pr, file, line, fragment, suggestion } = finding
    const issue = await github(repo, 'issues', {
      body: {
        title: `Обновить документацию после PR #${pr.number}: ${file}`.slice(0, 240),
        body: [
          marker,
          `PR #${pr.number} (${pr.url})`,
          `Файл и строка: ${file}:${line}`,
          '',
          'Устаревший фрагмент',
          '',
          `    ${fragment}`,
          '',
          'Предложение по правке',
          '',
          `    ${suggestion}`,
        ].join('\n'),
      },
    })
    if (!issue.number || !issue.html_url)
      throw new Error('GitHub did not return the created issue')
    return keep(link(issue))
  }

  return { status, scan, publish }
}
