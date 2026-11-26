import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Use Node's built-in runner without adding a dependency.
import { test } from 'node:test'
import { createDocReview } from './docReview.mjs'

const repo = 'owner/project'
const enabledAt = Date.parse('2026-11-01T10:00:00Z')

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-doc-review-'))
  const stateFile = path.join(dir, 'review.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const config = { base: 'release/v2', docReviewSince: enabledAt }
  const documents = new Map([
    ['README.md', 'Run `npm run old-check` before pushing.'],
    ['docs/setup/guide.MD', 'Run `pnpm run old-check` locally.'],
    ['docs/unchanged.md', 'Run `npm run verify` before pushing.'],
  ])
  const merged = (number, mergedAt, base = config.base) => ({
    number,
    title: `Update script #${number}`,
    html_url: `https://github.com/${repo}/pull/${number}`,
    base: { ref: base },
    merged_at: new Date(mergedAt).toISOString(),
    updated_at: new Date(enabledAt + 8000).toISOString(),
  })
  const pulls = [
    merged(5, enabledAt - 1000),
    merged(6, enabledAt),
  ]
  const requestedFiles = []
  const issues = []
  let files = [
    {
      filename: 'package.json',
      status: 'modified',
      patch: '@@ -1,5 +1,5 @@\n   "scripts": {\n-    "old-check": "node check.js",\n     "test": "node test.js",\n+    "verify": "node check.js",\n     "watch": "node watch.js"\n   }',
    },
  ]
  const manifests = new Map([
    [undefined, '{"scripts":{"verify":"node check.js"}}'],
  ])
  let fileError = false
  let loseIssueResponse = false
  const review = () => createDocReview({
    stateFile,
    settings: () => config,
    now: () => enabledAt + 10000,
    async github(_repo, endpoint, { page, body } = {}) {
      if (endpoint.startsWith('pulls?')) {
        assert.match(endpoint, /base=release%2Fv2/)
        return page === 1
          ? pulls
          : []
      }
      if (/^pulls\/\d+\/files$/.test(endpoint)) {
        requestedFiles.push(Number(endpoint.split('/')[1]))
        if (fileError)
          throw new Error('temporary GitHub failure')
        return typeof files === 'function'
          ? files(endpoint)
          : files
      }
      if (endpoint.startsWith('issues?')) {
        return page === 1
          ? issues
          : []
      }
      assert.equal(endpoint, 'issues')
      const issue = { number: 9, html_url: `https://github.com/${repo}/issues/9`, body: body.body }
      issues.push(issue)
      if (loseIssueResponse)
        throw new Error('response lost after creation')
      return issue
    },
    async baseTree() {
      return {
        list: async () => [
          ...documents.keys(),
        ],
        read: async (file, options) => file === 'package.json'
          ? manifests.get(options?.ref)
          : documents.get(file),
      }
    },
  })
  return {
    review,
    stateFile,
    config,
    documents,
    pulls,
    merged,
    manifests,
    issues,
    requestedFiles,
    useFiles: value => files = value,
    failFiles: value => fileError = value,
    loseIssue: () => loseIssueResponse = true,
  }
}

test('a startup scan catches up since activation and persists findings across a restart', async (t) => {
  const { review, requestedFiles } = fixture(t)
  const first = review()
  await first.scan(repo)
  const { findings } = first.status(repo)
  assert.deepEqual(requestedFiles, [6])
  assert.deepEqual(findings.map(f => [
    f.pr.number,
    f.file,
    f.fragment,
    f.suggestion,
  ]), [
    [
      6,
      'README.md',
      'Run `npm run old-check` before pushing.',
      'Run `npm run verify` before pushing.',
    ],
    [
      6,
      'docs/setup/guide.MD',
      'Run `pnpm run old-check` locally.',
      'Run `pnpm run verify` locally.',
    ],
  ])
  const restarted = review()
  await restarted.scan(repo)
  assert.deepEqual(restarted.status(repo).findings, findings)
  assert.deepEqual(requestedFiles, [6])
})

test('a failed GitHub request leaves the merged PR eligible for a retry', async (t) => {
  const { review, failFiles, requestedFiles } = fixture(t)
  const service = review()
  failFiles(true)
  await service.scan(repo)
  assert.equal(service.status(repo).error, true)
  assert.deepEqual(service.status(repo).findings, [])

  failFiles(false)
  await service.scan(repo)
  assert.equal(service.status(repo).error, false)
  assert.equal(service.status(repo).findings.length, 2)
  assert.deepEqual(requestedFiles, [6, 6])
})

test('repeated clicks and a lost response create a single GitHub issue', async (t) => {
  const { review, issues, loseIssue } = fixture(t)
  const service = review()
  await service.scan(repo)
  const [finding] = service.status(repo).findings
  assert.equal(issues.length, 0)
  loseIssue()
  const first = service.publish(repo, finding.id)
  assert.equal(service.publish(repo, finding.id), first)
  await assert.rejects(first, /response lost/)

  const restarted = review()
  const issue = await restarted.publish(repo, finding.id)
  assert.deepEqual(issue, { number: 9, url: `https://github.com/${repo}/issues/9` })
  assert.deepEqual(restarted.status(repo).findings[0].issue, issue)
  assert.equal(issues.length, 1)
  assert.match(issues[0].body, /README\.md:1/)
  assert.ok(issues[0].body.includes(finding.pr.url))
  assert.ok(issues[0].body.includes(finding.fragment))
  assert.ok(issues[0].body.includes(finding.suggestion))
})

test('finds changed shell examples and renamed paths in Markdown', async (t) => {
  const { review, documents, useFiles } = fixture(t)
  documents.clear()
  documents.set('README.md', '~~~sh\n$ bot ui --port 3000\n~~~\n[инструкция](docs/old.md)\n`bot ui --port 30000`')
  documents.set('docs/index.md', '[инструкция](old.md#start) · `bot run --port 3000`')
  documents.set('elsewhere/guide.md', '`bot ui --port 3000`')
  useFiles([
    { filename: 'setup.sh', patch: '@@ -1,2 +1,2 @@\n-echo "bot ui --port 3000"\n-echo "bot run --port 3000"\n+echo "bot ui --port 4545"\n+echo "bot run --port 4545"' },
    { filename: 'docs/new.md', previous_filename: 'docs/old.md', status: 'renamed' },
  ])
  const service = review()
  await service.scan(repo)
  assert.deepEqual(service.status(repo).findings.map(f => f.suggestion), [
    '$ bot ui --port 4545',
    '[инструкция](docs/new.md)',
    '[инструкция](new.md#start) · `bot run --port 4545`',
  ])
})

test('suggests the newest name after two script renames while offline', async (t) => {
  const { review, pulls, merged, manifests, useFiles } = fixture(t)
  pulls[1].merge_commit_sha = 'first'
  pulls.push({
    ...merged(7, enabledAt + 1000),
    merge_commit_sha: 'second',
  })
  manifests.set('first', '{"scripts":{"middle":"node check.js"}}')
  manifests.set('second', '{"scripts":{"verify":"node check.js"}}')
  useFiles(endpoint => [
    {
      filename: 'package.json',
      patch: endpoint === 'pulls/6/files'
        ? '@@ -1 +1 @@\n-"old-check": "node check.js"\n+"middle": "node check.js"'
        : '@@ -1 +1 @@\n-"middle": "node check.js"\n+"verify": "node check.js"',
    },
  ])
  const service = review()
  await service.scan(repo)
  assert.equal(service.status(repo).findings.length, 2)
  assert.ok(service.status(repo).findings.every(f => f.pr.number === 6 && f.suggestion.includes('run verify')))
})

test('leaves damaged review state intact and retries when it becomes readable', async (t) => {
  const { review, stateFile } = fixture(t)
  writeFileSync(stateFile, '{')
  const service = review()
  await service.scan(repo)
  assert.equal(service.status(repo).error, true)
  assert.equal(readFileSync(stateFile, 'utf8'), '{')
  writeFileSync(stateFile, '{}')
  await service.scan(repo)
  assert.equal(service.status(repo).error, false)
  assert.equal(service.status(repo).findings.length, 2)
})
