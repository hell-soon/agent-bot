import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
// Панель бота: http://127.0.0.1:4545 — запускает ../agent.sh в фоне и показывает ход работы.
// Без зависимостей. Запуск: bot ui
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { FORMAT as ARCH_FORMAT, scan as archScan } from './arch-scan.mjs'
import { codeGraph } from './code-graph.mjs'
import { createDocReview } from './docReview.mjs'
import { impactMarkdown, mapMarkdown, sliceOf } from './project-map.mjs'
import { pickRoutes, shoot, VIEWPORTS } from './screens.mjs'
import * as skills from './skills.mjs'

const PORT = 4545
const BOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// bot.env — личные настройки (создаёт setup.sh)
const BOT_ENV = (() => {
  const o = {}; try {
    for (const l of fs.readFileSync(path.join(BOT, 'bot.env'), 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/); if (m)
        o[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  catch {} return o
})()
const AGENT = path.join(BOT, 'agent.sh')
const DATA = path.join(BOT, 'logs', 'ui')
const STATE = path.join(DATA, 'runs.json')
const DEFAULT_REPO = BOT_ENV.BOT_DEFAULT_REPO || ''
const isRepo = r => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r)
const ENV = { ...process.env, PATH: `${path.join(BOT, 'bin')}:${process.env.PATH}` }
// Какие ИИ установлены: нужен хотя бы один — Claude Code или Codex
function hasCmd(c) {
  try { execFileSync('/bin/sh', ['-c', `command -v ${c}`], { env: ENV, stdio: 'ignore' }); return true }
  catch { return false }
}
const AIS = { claude: hasCmd('claude'), codex: hasCmd('codex') }
const fallbackAi = () => (AIS.claude || !AIS.codex ? 'claude' : 'codex')
fs.mkdirSync(DATA, { recursive: true })
// Вложения из панели (картинки, файлы): uploads/<дата>/<метка>-<имя>; ИИ получает пути
const UPLOADS = path.join(BOT, 'uploads')
const IMG = /\.(?:png|jpe?g|gif|webp)$/i
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const isUpload = p => typeof p === 'string' && path.resolve(p).startsWith(UPLOADS + path.sep) && fs.existsSync(p)
const fileInfo = p => ({ path: p, name: path.basename(p).replace(/^[a-z0-9]{8}-/, ''), image: IMG.test(p) })
// Исходящие файлы бота: uploads/out/<id задачи>; плюс картинки, которые Codex сгенерировал за время хода
const outboxOf = run => path.join(UPLOADS, 'out', run.id)
const CODEX_IMAGES = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images')
function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
      ? listFiles(path.join(dir, e.name))
      : e.isFile() && !e.name.startsWith('.') ? [path.join(dir, e.name)] : [])
  }
  catch { return [] }
}
function collectOut(run, since) {
  const box = outboxOf(run)
  if (run.ai === 'codex' && since) { // забытые генерации — сами кладём в исходящие
    for (const f of listFiles(CODEX_IMAGES)) {
      try {
        if (IMG.test(f) && fs.statSync(f).mtimeMs >= since && !(run.codexImgs || []).includes(f)) {
          fs.mkdirSync(box, { recursive: true })
          fs.copyFileSync(f, path.join(box, `gen-${path.basename(f)}`))
          run.codexImgs = [...(run.codexImgs || []), f]
        }
      }
      catch {}
    }
  }
  const fresh = listFiles(box).filter(f => !(run.outSeen || []).includes(f)).slice(0, 20)
  if (!fresh.length)
    return []
  run.outSeen = [...(run.outSeen || []), ...fresh]
  appendEvent(run, { type: 'bot_files', from: 'bot', files: fresh.map(f => ({ ...fileInfo(f), name: path.basename(f) })), at: Date.now() })
  return fresh
}
// ---------- схема архитектуры: чтение из git базовой ветки (рабочая копия бота может быть на чужой ветке) ----------
const archCache = new Map() // repo → { sha, data }
const codeCache = new Map() // repo → { sha, graph }
const sh = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { env: ENV, maxBuffer: 64 * 1024 * 1024, timeout: 60000, ...opts }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n').pop())) : resolve(out))))
// базовая ветка репозитория в копии бота: клонировать при надобности, освежить, вернуть ref, sha и чтение из git
const fetchedAt = new Map()
async function baseRef(repo, fresh, wantRef, { strict = false } = {}) {
  const W = path.join(BOT, 'work', repo.replace('/', '__'))
  if (!fs.existsSync(path.join(W, '.git')))
    await sh(AGENT, ['_status'], { env: { ...ENV, BOT_REPO: repo } }) // клонирует и настроит доступ
  if (fresh || Date.now() - (fetchedAt.get(repo) || 0) > 600000) {
    const fetch = sh('git', ['-C', W, 'fetch', '-q', 'origin'])
    if (strict)
      await fetch
    else
      await fetch.catch(() => {})
    fetchedAt.set(repo, Date.now())
  }
  const ref = wantRef || (await sh('git', ['-C', W, 'rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => 'origin/main')).trim()
  const sha = (await sh('git', ['-C', W, 'rev-parse', ref])).trim()
  const read = (f) => {
    try { return execFileSync('git', ['-C', W, 'show', `${ref}:${f}`], { env: ENV, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString() }
    catch { return null }
  }
  const list = async () => (await sh('git', ['-C', W, 'ls-tree', '-r', '--name-only', ref])).split('\n').filter(Boolean)
  // git grep -o по базовой ветке: строки «ref:файл:совпадение»
  const grep = async re => (await sh('git', ['-C', W, 'grep', '-I', '-o', '-E', re, ref, '--']).catch(() => '')).split('\n').filter(Boolean).map((l) => {
    const rest = l.slice(ref.length + 1); const i = rest.indexOf(':')
    return { file: rest.slice(0, i), text: rest.slice(i + 1) }
  })
  return { W, ref, sha, read, list, grep }
}
// git grep на macOS понимает только POSIX-классы: [[:space:]] вместо \s, [[:alnum:]_] вместо \w
const IMPORT_RE = String.raw`(from|import|require\(|import\()[[:space:]]*['"][^'"]+['"]|^[[:space:]]*(from[[:space:]]+[.[:alnum:]_]+[[:space:]]+import|import[[:space:]]+[[:alnum:]_.]+)|^[[:space:]]*"[^"]+"[[:space:]]*$`
async function codeData(repo, fresh) {
  const g = await baseRef(repo, fresh)
  const hit = codeCache.get(repo)
  let graph = hit?.sha === g.sha ? hit.graph : null
  if (!graph) {
    const files = await g.list()
    const lines = await g.grep(IMPORT_RE)
    graph = codeGraph({ list: () => files, read: g.read, grep: () => lines })
    codeCache.set(repo, { sha: g.sha, graph })
  }
  const bot = runs.filter(r => r.repo === repo).map(r => ({
    id: r.id,
    title: r.title,
    status: r.status,
    ai: r.ai === 'codex' ? 'codex' : 'claude',
    at: r.endedAt || r.startedAt || r.createdAt,
    files: editedFiles(r).map(f => f.path),
  })).filter(r => r.files.length)
  return { repo, ref: g.ref, sha: g.sha.slice(0, 7), ...graph, bot }
}
async function archData(repo, fresh) {
  const { ref, sha, read, list: ls, grep } = await baseRef(repo, fresh)
  const hit = archCache.get(repo)
  if (hit && hit.sha === sha && !fresh)
    return hit.data
  const list = await ls()
  const urls = (await grep(String.raw`(https?|wss?)://[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)).map(x => ({ file: x.file, url: x.text }))
  const scanned = archScan({ list: () => list, read, urls: () => urls }, repo)
  let saved = null
  const raw = read('docs/architecture.json')
  if (raw) {
    try { saved = JSON.parse(raw) }
    catch { saved = { error: 'docs/architecture.json — не JSON' } }
  }
  const data = { repo, ref, sha: sha.slice(0, 7), saved, scan: scanned }
  archCache.set(repo, { sha, data })
  return data
}

// какие файлы задача правила: из её журнала (Edit/Write), пути — относительно копии репозитория
const editCache = new Map() // id → { mtime, files }
function editedFiles(run) {
  const f = evFile(run.id)
  let st; try { st = fs.statSync(f) }
  catch { return [] }
  const hit = editCache.get(run.id)
  if (hit && hit.mtime === st.mtimeMs)
    return hit.files
  // копия репозитория — work/<owner>__<repo>/ (у старых задач — work/<repo>/)
  const root = new RegExp(`^${path.join(BOT, 'work').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/`)
  const count = new Map()
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"tool_use"'))
      continue
    let ev; try { ev = JSON.parse(line) }
    catch { continue }
    for (const c of ev.message?.content || []) {
      const fp = c.type === 'tool_use' && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(c.name) && (c.input?.file_path || c.input?.notebook_path)
      if (!fp)
        continue
      const rel = root.test(fp) ? fp.replace(root, '') : !fp.startsWith('/') ? fp : null
      if (rel)
        count.set(rel, (count.get(rel) || 0) + 1)
    }
  }
  const files = [...count].map(([p, edits]) => ({ path: p, edits }))
  editCache.set(run.id, { mtime: st.mtimeMs, files })
  return files
}
const pickFiles = list => (Array.isArray(list) ? list : []).filter(isUpload).slice(0, 10)

/** @type {any[]} */
let runs = []
try { runs = JSON.parse(fs.readFileSync(STATE, 'utf8')) }
catch {}
// после перезапуска сервера «работающие» уже не работают
for (const r of runs) {
  if (r.status === 'running')
    r.status = 'stopped'
  // раньше в model попадала подпись «codex · gpt-…» из лога, и «Продолжить» передавал её Codex как имя модели
  if (typeof r.model === 'string' && /\s|·|^codex/.test(r.model)) {
    r.modelUsed = r.model; delete r.model
  }
  // старые задачи без репозитория — из репозитория по умолчанию (история у каждого проекта своя)
  if (!isRepo(r.repo) && DEFAULT_REPO)
    r.repo = DEFAULT_REPO
}
const save = () => fs.writeFileSync(STATE, JSON.stringify(runs, null, 1))
const byId = id => runs.find(r => r.id === id)
const evFile = id => path.join(DATA, `${id}.jsonl`)
let seq = runs.reduce((m, r) => Math.max(m, +r.id || 0), 0)

// Лимиты подписки: Claude Code присылает rate_limit_event (тип окна, заполненность 0..1, время сброса)
const LIMITS = path.join(DATA, 'limits.json')
let limits = {}
try { limits = JSON.parse(fs.readFileSync(LIMITS, 'utf8')) }
catch {}
function onRateLimit(info) {
  if (!info?.rateLimitType)
    return
  const prev = limits[info.rateLimitType] || {}
  limits[info.rateLimitType] = {
    status: info.status,
    utilization: typeof info.utilization === 'number'
      ? info.utilization
      : (prev.resetsAt === info.resetsAt
          ? prev.utilization
          : undefined),
    resetsAt: info.resetsAt
      ? info.resetsAt * 1000
      : prev.resetsAt,
    overage: !!info.isUsingOverage,
    at: Date.now(),
  }
  fs.writeFileSync(LIMITS, JSON.stringify(limits))
}

// Codex: лимиты подписки ChatGPT пишутся в журналы сессий ~/.codex/sessions (rate_limits), модели — в models_cache.json
const CODEX_HOME = path.join(os.homedir(), '.codex')
let codexLimits = null; let codexLimitsAt = 0
function newestCodexSession() {
  let dir = path.join(CODEX_HOME, 'sessions')
  try {
    for (let d = 0; d < 3; d++) { // год / месяц / день
      const sub = fs.readdirSync(dir).filter(n => /^\d+$/.test(n)).sort().pop()
      if (!sub)
        return null
      dir = path.join(dir, sub)
    }
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).map(n => path.join(dir, n))
    return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null
  }
  catch { return null }
}
function readCodexLimits(force) {
  if (!force && Date.now() - codexLimitsAt < 20000)
    return codexLimits
  codexLimitsAt = Date.now()
  const f = newestCodexSession(); if (!f)
    return codexLimits
  try {
    const size = fs.statSync(f).size; const fd = fs.openSync(f, 'r'); const len = Math.min(size, 400000); const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd)
    const lines = buf.toString('utf8').split('\n').reverse()
    for (const l of lines) {
      const i = l.indexOf('"rate_limits"'); if (i < 0)
        continue
      try {
        const rl = JSON.parse(l)?.payload?.rate_limits || JSON.parse(l)?.rate_limits || findKey(JSON.parse(l), 'rate_limits')
        if (!rl)
          continue
        const win = w => w && {
          pct: Math.round(w.used_percent ?? 0),
          windowMin: w.window_minutes,
          resetsAt: w.resets_at
            ? w.resets_at * 1000
            : undefined,
        }
        codexLimits = {
          primary: win(rl.primary),
          secondary: win(rl.secondary),
          at: fs.statSync(f).mtimeMs,
        }
        break
      }
      catch {}
    }
  }
  catch {}
  return codexLimits
}
function findKey(o, k) {
  if (!o || typeof o !== 'object')
    return null; if (k in o)
    return o[k]; for (const v of Object.values(o)) {
    const r = findKey(v, k); if (r)
      return r
  } return null
}
function codexModels() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'models_cache.json'), 'utf8'))
    return (j.models || []).filter(m => m.slug && m.visibility !== 'hide' && m.show_in_picker !== false).map(m => ({
      slug: m.slug,
      name: m.display_name || m.slug,
      desc: m.description || '',
      efforts: (m.supported_reasoning_levels || []).map(e => e.effort || e).filter(Boolean),
      def: m.default_reasoning_level || '',
    }))
  }
  catch { return [] }
}
function codexLogin() {
  return new Promise(resolve => execFile('codex', ['login', 'status'], { timeout: 15000 }, (err, out, errOut) => {
    const t = String(out || errOut || '').trim().split('\n')[0]
    resolve({
      ok: !err && /logged in/i.test(t),
      text: /chatgpt/i.test(t)
        ? 'ChatGPT'
        : /api key/i.test(t)
          ? 'ключ API'
          : t,
    })
  }))
}

const clients = new Set() // SSE: { res, runId | null }
function broadcast(msg, runId) {
  const line = `data: ${JSON.stringify(msg)}\n\n`
  for (const c of clients) {
    if (c.runId === null
      ? !runId
      : c.runId === runId) {
      c.res.write(line)
    }
  }
}
function snapshot() {
  return {
    botDir: BOT,
    botName: BOT_ENV.BOT_NAME || 'bot',
    runs: publicRuns(),
    current: current?.run.id ?? null,
    limits,
    codexLimits: readCodexLimits(),
    today: today(),
    ais: AIS,
  }
}
function pushState() {
  save(); broadcast({
    type: 'state',
    ...snapshot(),
  })
}
function today() { // потрачено с начала суток (по запускам бота)
  const d = new Date(); d.setHours(0, 0, 0, 0)
  let cost = 0; let tin = 0; let tout = 0
  for (const r of runs) {
    if ((r.endedAt || r.startedAt || 0) >= d.getTime()) { cost += r.cost || 0; tin += r.tokIn || 0; tout += r.tokOut || 0 }
  }
  return { cost, tokIn: tin, tokOut: tout }
}
let liveTimer = null // токены идущего хода — не чаще раза в 2 с
function pushLive() {
  if (!liveTimer)
    liveTimer = setTimeout(() => { liveTimer = null; pushState() }, 2000)
}
const publicRuns = () => runs.slice(-80).reverse()

function appendEvent(run, ev) {
  ev.t ??= Date.now() // время каждого шага — для схемы задачи
  fs.appendFileSync(evFile(run.id), `${JSON.stringify(ev)}\n`)
  broadcast({ type: 'event', ev }, run.id)
}

// ---------- запуск ----------
const KINDS = {
  issue: r => [
    '_issue',
    String(r.issue),
    r.base || 'main',
  ],
  pr: r => [
    '_pr',
    String(r.pr),
    ...(r.text
      ? [r.text]
      : []),
  ],
  idea: r => ['_new', `/grill-with-docs ${r.text}`],
  bug: r => ['_new', `/diagnosing-bugs ${r.text}`],
  triage: () => ['_new', '/triage'],
  tickets: () => ['_new', '/to-tickets'],
  task: r => ['_new', r.text],
}
const CHAT = new Set([
  'idea',
  'bug',
  'triage',
  'tickets',
  'task',
])

let current = null // { run, child }

function newRun(fields) {
  const run = {
    id: String(++seq),
    status: 'queued',
    createdAt: Date.now(),
    cost: 0,
    turns: 0,
    ...fields,
  }
  run.repo = repoOf(run.repo)
  runs.push(run)
  return run
}

// ---------- карта проекта перед задачей и «Что может задеть» в PR (из графа импортов, без ИИ) ----------
let mapping = false
const MAP_KINDS = new Set(['issue', 'pr', 'task', 'bug', 'idea'])
async function prepareMap(run) {
  if (readConfig().repos?.[run.repo]?.map === false || !MAP_KINDS.has(run.kind) || !isRepo(run.repo))
    return
  let text = `${run.title || ''}\n${run.text || ''}`
  let extra = []
  if (run.kind === 'issue') {
    const i = await gh(['issue', 'view', String(run.issue), '-R', run.repo, '--json', 'title,body'])
    text += `\n${i?.title || ''}\n${i?.body || ''}`
  }
  if (run.kind === 'pr') {
    const files = await gh(['api', `repos/${run.repo}/pulls/${run.pr}/files?per_page=100`])
    extra = (Array.isArray(files) ? files : []).map(f => f.filename)
  }
  const g = await codeData(run.repo)
  if (!g.files?.length)
    return
  const { md, relevant } = mapMarkdown(g, text, extra)
  const file = path.join(UPLOADS, 'map', `${run.id}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, md)
  run.mapFile = file
  appendEvent(run, { type: 'bot_note', text: `Карта проекта: ${relevant.length ? `похоже, задача про ${relevant.slice(0, 4).join(', ')}` : 'слои и слайсы'} — из графа импортов`, at: Date.now() })
}
// граф импортов произвольной ветки (для PR) — кеш по sha
const refCache = new Map()
async function graphAt(repo, ref) {
  const g = await baseRef(repo, true, ref)
  const key = `${repo}@${g.sha}`
  if (!refCache.has(key)) {
    const files = await g.list()
    const lines = await g.grep(IMPORT_RE)
    refCache.set(key, codeGraph({ list: () => files, read: g.read, grep: () => lines }))
    if (refCache.size > 20)
      refCache.delete(refCache.keys().next().value)
  }
  return refCache.get(key)
}

// ---------- GitHub: JSON-запрос от имени бота, комментарий с меткой (создать или обновить) ----------
async function ghJson(method, p, body) {
  const file = path.join(UPLOADS, 'tmp', `${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(body || {}))
  try { return JSON.parse(await sh('gh', ['api', '-X', method, p, '--input', file]) || '{}') }
  finally { fs.rmSync(file, { force: true }) }
}
async function upsertComment(repo, n, marker, body) {
  const R = `repos/${repo}`
  const comments = await gh(['api', `${R}/issues/${n}/comments?per_page=100`])
  const mine = (Array.isArray(comments) ? comments : []).find(c => String(c.body).includes(marker))
  if (mine)
    await ghJson('PATCH', `${R}/issues/comments/${mine.id}`, { body })
  else await ghJson('POST', `${R}/issues/${n}/comments`, { body })
  return mine ? 'updated' : 'created'
}

// «Что может задеть» + новые нарушения FSD (ветка PR против базовой) — одним комментарием
async function prReport(run) {
  const n = Number(String(run.prUrl).split('/').pop()); const R = `repos/${run.repo}`
  if (!n)
    return false
  const rc = readConfig().repos?.[run.repo] || {}
  const [files, pr] = await Promise.all([gh(['api', `${R}/pulls/${n}/files?per_page=100`]), gh(['api', `${R}/pulls/${n}`])])
  const changed = (Array.isArray(files) ? files : []).map(f => f.filename)
  if (!changed.length)
    return false
  const base = await codeData(run.repo)
  const parts = []
  if (rc.impact !== false)
    parts.push(impactMarkdown(base, changed))
  if (rc.fsd !== false && base.fsd && pr?.head?.ref) {
    try {
      const head = await graphAt(run.repo, `origin/${pr.head.ref}`)
      const key = e => `${e.from}>${e.to}`
      const had = new Set(base.edges.filter(e => e.bad).map(key))
      const fresh = head.edges.filter(e => e.bad && !had.has(key(e)))
      run.fsdNew = fresh.map(e => `${e.from} → ${e.to}: ${e.bad}`)
      parts.push(fresh.length
        ? ['### Правила слоёв FSD', `⚠️ Новых нарушений: **${fresh.length}**`, ...fresh.slice(0, 15).map(e => `- \`${e.from}\` → \`${e.to}\` — ${e.bad}`), fresh.length > 15 ? `- … и ещё ${fresh.length - 15}` : ''].filter(Boolean).join('\n')
        : '### Правила слоёв FSD\n✅ Новых нарушений нет')
    }
    catch (e) { console.error('fsd:', e.message) }
  }
  if (!parts.length)
    return false
  const body = `<!-- agent-bot:impact -->\n${parts.join('\n\n').replace('<!-- agent-bot:impact -->\n', '')}`
  return upsertComment(run.repo, n, '<!-- agent-bot:impact -->', body)
}

// ---------- скриншоты «до/после» ----------
const SECRETS = path.join(BOT, 'keys', 'screens')
const secretFile = (repo, kind) => path.join(SECRETS, `${repo.replace('/', '__')}.${kind}`)
const secret = (repo, kind) => { try { return fs.readFileSync(secretFile(repo, kind), 'utf8').trim() } catch { return '' } }
const UI_RE = /\.(?:vue|svelte|[jt]sx|css|scss|sass|less|html)$/
const vercelSlug = b => String(b).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function reachable(url) {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
    return r.status < 400 || r.status === 401 || r.status === 403
  }
  catch { return false }
}
async function previewOf(repo, rc, branch, sha) {
  if (rc.previewUrl)
    return rc.previewUrl.replace('{branch}', vercelSlug(branch)).replace('{sha}', sha.slice(0, 7)).replace(/\/$/, '')
  const deps = await gh(['api', `repos/${repo}/deployments?sha=${sha}&per_page=10`])
  for (const dep of Array.isArray(deps) ? deps : []) {
    const st = await gh(['api', `repos/${repo}/deployments/${dep.id}/statuses?per_page=5`])
    const ok = (Array.isArray(st) ? st : []).find(x => x.state === 'success' && x.environment_url)
    if (ok)
      return ok.environment_url.replace(/\/$/, '')
  }
  return ''
}
async function siteOf(repo, rc) {
  const cands = [rc.siteUrl]
  const info = await gh(['api', `repos/${repo}`])
  cands.push(info?.homepage)
  const deps = await gh(['api', `repos/${repo}/deployments?environment=Production&per_page=3`])
  for (const dep of Array.isArray(deps) ? deps : []) {
    const st = await gh(['api', `repos/${repo}/deployments/${dep.id}/statuses?per_page=3`])
    cands.push((Array.isArray(st) ? st : []).find(x => x.state === 'success')?.environment_url)
  }
  for (const u of cands.filter(Boolean)) {
    if (await reachable(u))
      return String(u).replace(/\/$/, '')
  }
  return ''
}
// картинки — в отдельную ветку agent-bot-screens (в PR они видны по ссылке ?raw=true)
async function pushImages(repo, files, dir) {
  const R = `repos/${repo}`; const BR = 'agent-bot-screens'
  const head = await gh(['api', `${R}/git/ref/heads/${BR}`])
  const parent = head?.object?.sha
  const baseTree = parent ? (await gh(['api', `${R}/git/commits/${parent}`]))?.tree?.sha : undefined
  const tree = []
  for (const f of files) {
    const blob = await ghJson('POST', `${R}/git/blobs`, { content: fs.readFileSync(f.file).toString('base64'), encoding: 'base64' })
    tree.push({ path: `${dir}/${path.basename(f.file)}`, mode: '100644', type: 'blob', sha: blob.sha })
  }
  const t = await ghJson('POST', `${R}/git/trees`, baseTree ? { base_tree: baseTree, tree } : { tree })
  const c = await ghJson('POST', `${R}/git/commits`, { message: `Скриншоты ${dir}`, tree: t.sha, parents: parent ? [parent] : [] })
  if (parent)
    await ghJson('PATCH', `${R}/git/refs/heads/${BR}`, { sha: c.sha, force: false })
  else await ghJson('POST', `${R}/git/refs`, { ref: `refs/heads/${BR}`, sha: c.sha })
  return p => `https://github.com/${repo}/blob/${BR}/${dir}/${path.basename(p)}?raw=true`
}
const routeKey = r => (r === '/' ? 'home' : r.replace(/^\//, '').replace(/[^\w-]+/g, '_'))
async function screensJob(run) {
  const rc = readConfig().repos?.[run.repo] || {}
  if (rc.screens === false)
    return
  const n = Number(String(run.prUrl).split('/').pop()); const R = `repos/${run.repo}`
  const [files, pr] = await Promise.all([gh(['api', `${R}/pulls/${n}/files?per_page=100`]), gh(['api', `${R}/pulls/${n}`])])
  const changed = (Array.isArray(files) ? files : []).map(f => f.filename)
  if (!changed.some(f => UI_RE.test(f)) || !pr?.head?.sha)
    return
  const note = text => { appendEvent(run, { type: 'bot_note', text: `Скриншоты: ${text}`, at: Date.now() }); pushState() }
  note('правки интерфейса — жду превью PR')
  let after = ''
  for (let i = 0; i < 20 && !after; i++) {
    after = await previewOf(run.repo, rc, pr.head.ref, pr.head.sha)
    if (after && !(await reachable(after)))
      after = ''
    if (!after)
      await sleep(30000)
  }
  if (!after)
    return note('превью не нашлось за 10 мин — задайте адрес превью в Настройки → Репозиторий → Скриншоты')
  const before = await siteOf(run.repo, rc)
  const routes = pickRoutes(await codeData(run.repo), changed, sliceOf, rc.pages)
  const shots = routes.flatMap(r => [
    ...(before ? [{ key: `${routeKey(r)}-before`, url: before + r }] : []),
    { key: `${routeKey(r)}-after`, url: after + r },
  ])
  const outDir = path.join(UPLOADS, 'screens', `${run.repo.replace('/', '__')}-pr${n}-${pr.head.sha.slice(0, 7)}`)
  const { files: shotsDone } = await shoot(shots, { cookie: secret(run.repo, 'cookie'), bypass: secret(run.repo, 'bypass'), outDir })
  const blocked = new Set(shotsDone.map(f => f.blocked).filter(Boolean))
  if (blocked.has('vercel'))
    note('превью закрыто защитой Vercel — добавьте секрет обхода (Vercel → Settings → Deployment Protection → Protection Bypass for Automation)')
  if (blocked.has('login'))
    note('открылась страница входа — добавьте cookie входа в настройках репозитория')
  const good = shotsDone.filter(f => f.file)
  if (!good.length)
    return note('снять не получилось')
  // в ленту задачи и в Telegram
  const box = outboxOf(run)
  fs.mkdirSync(box, { recursive: true })
  for (const f of good) fs.copyFileSync(f.file, path.join(box, `screen-${path.basename(f.file)}`))
  run.outNew = collectOut(run, 0)
  const dir = `pr-${n}/${pr.head.sha.slice(0, 7)}`
  let link
  try { link = await pushImages(run.repo, good, dir) }
  catch (e) { return note(`в PR не загрузились: ${e.message}`) }
  const img = (key, vp) => {
    const f = good.find(x => x.key === key && x.vp === vp)
    return f ? `<img src="${link(f.file)}" width="${vp === 'phone' ? 260 : 420}">` : '—'
  }
  const body = [
    '<!-- agent-bot:screens -->',
    '### Скриншоты · до и после',
    ...routes.flatMap(r => [
      `**${r}**`,
      '',
      `| | до${before ? ' (основной сайт)' : ''} | после (превью PR) |`,
      '|---|---|---|',
      ...VIEWPORTS.map(vp => `| ${vp.title} | ${before ? img(`${routeKey(r)}-before`, vp.id) : 'нет адреса сайта'} | ${img(`${routeKey(r)}-after`, vp.id)} |`),
      '',
    ]),
    `<sub>до — ${before || '—'} · после — ${after} · agent-bot, Playwright</sub>`,
  ].join('\n')
  await upsertComment(run.repo, n, '<!-- agent-bot:screens -->', body)
  note(`в PR — ${routes.join(', ')} на телефоне и десктопе`)
}

function next() {
  if (current || mapping)
    return
  const run = runs.find(r => r.status === 'queued')
  if (!run)
    return
  // цепочка: база — ветка предыдущего звена; если оно не удалось — звено пропускается
  if (run.after) {
    const prev = byId(run.after)
    if (!prev || prev.status !== 'done' || (!prev.prUrl && !prev.closedIssue)) {
      run.status = 'skipped'; run.note = 'Предыдущий тикет цепочки не получился'
      pushState(); return next()
    }
    run.base = prev.prUrl
      ? prev.branch
      : (prev.base || 'main')
  }
  // перед первым запуском — карта проекта (не дольше 25 с; без неё задача всё равно стартует)
  if (!run.mapDone && !run.continue && !run.reply) {
    mapping = true
    Promise.race([prepareMap(run), new Promise(r => setTimeout(r, 25000))])
      .catch(e => console.error('карта проекта:', e.message))
      .finally(() => { mapping = false; run.mapDone = true; next() })
    return
  }
  const cont = run.continue && run.sessionId && run.branch
  const args = cont
    ? [
        '_continue',
        run.sessionId,
        run.branch,
        ...(run.kind === 'issue'
          ? [
              String(run.issue),
            ]
          : []),
      ]
    : run.reply
      ? ['_resume', run.sessionId, run.reply]
      : KINDS[run.kind](run)
  const sendFiles = cont
    ? null
    : run.reply
      ? run.replyFiles
      : !run.sessionId ? run.files : null
  run.continue = undefined; run.reason = undefined; run.resumeAt = undefined; run.lastText = undefined
  if (cont) {
    appendEvent(run, {
      type: 'bot_note',
      text: 'Продолжение с того же места',
      at: Date.now(),
    })
  }
  else if (run.reply) {
    appendEvent(run, {
      type: 'bot_user',
      text: run.reply,
      files: run.replyFiles?.map(fileInfo),
      at: Date.now(),
    })
  }
  else {
    appendEvent(run, {
      type: 'bot_note',
      text: 'Запуск',
      at: Date.now(),
    })
    if (sendFiles?.length)
      appendEvent(run, { type: 'bot_files', files: sendFiles.map(fileInfo), at: Date.now() })
  }
  run.reply = undefined; run.replyFiles = undefined
  if (run.watchdog) { run.watchdog = undefined; run.reason = undefined }
  run.status = 'running'; run.startedAt = Date.now()
  const env = { ...ENV }
  if (run.ai)
    env.BOT_AI = run.ai
  env.BOT_REPO = run.repo || repoOf()
  if (run.refs?.length)
    env.BOT_REFS = run.refs.join(',')
  if (run.model && run.ai !== 'codex')
    env.BOT_MODEL = run.model
  if (run.model && run.ai === 'codex')
    env.BOT_CODEX_MODEL = run.model
  if (run.effort)
    env.BOT_EFFORT = run.effort
  // вложения: к первому запуску — из задачи, к ответу — из ответа; «Продолжить» их не повторяет
  const files = sendFiles
  if (files?.length)
    env.BOT_FILES = files.join('\n')
  env.BOT_OUTBOX = outboxOf(run)
  if (run.mapFile && fs.existsSync(run.mapFile))
    env.BOT_MAP = run.mapFile
  if (run.kind === 'idea')
    env.BOT_MODE = 'idea'
  const turnStart = Date.now()
  run.outNew = []
  const child = spawn(AGENT, args, {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawn('caffeinate', [
    '-i',
    '-w',
    String(child.pid),
  ], { stdio: 'ignore' }).unref()
  current = { run, child }
  let turn = {
    ids: new Set(),
    in: 0,
    out: 0,
  }
  pushState()

  // ---------- сторож: зависание, слишком долго, хождение по кругу ----------
  const wd = { last: Date.now(), since: Date.now(), sigs: new Map() }
  const trip = (text) => {
    if (current?.run !== run || run.status !== 'running')
      return
    run.status = 'stopped'; run.watchdog = text
    run.reason = `Сторож остановил задачу: ${text}. Правки сохранены WIP-коммитом — «Продолжить» продолжит с того же места.`
    appendEvent(run, { type: 'bot_note', text: `Сторож: ${text}`, at: Date.now() })
    try { process.kill(-child.pid, 'SIGTERM') }
    catch {}
  }
  const wdTimer = setInterval(() => {
    const c = readConfig(); const now = Date.now()
    if (c.watchIdle && now - wd.last > c.watchIdle * 60000)
      trip(`${c.watchIdle} мин без единого действия — похоже, завис`)
    else if (c.watchMax && now - wd.since > c.watchMax * 60000)
      trip(`идёт дольше ${c.watchMax} мин`)
  }, 30000)
  const watchTools = (ev) => {
    const lim = readConfig().watchRepeat
    if (!lim || ev.type !== 'assistant' || !Array.isArray(ev.message?.content))
      return
    for (const c of ev.message.content) {
      if (c.type !== 'tool_use')
        continue
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) { wd.sigs.clear(); continue }
      if (c.name === 'TodoWrite')
        continue
      const sig = `${c.name} ${JSON.stringify(c.input || {})}`
      const n = (wd.sigs.get(sig) || 0) + 1
      wd.sigs.set(sig, n)
      if (n >= lim) {
        const what = String(c.input?.command || c.input?.file_path || c.input?.pattern || '').slice(0, 80)
        trip(`${n} раз подряд одно и то же без правок (${c.name}${what ? `: ${what}` : ''}) — ходит по кругу`)
      }
    }
  }

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    wd.last = Date.now()
    let ev
    try { ev = JSON.parse(line) }
    catch { ev = { type: 'bot_raw', text: line } }
    watchTools(ev)
    if (ev.type === 'system' && ev.subtype === 'init') {
      run.sessionId = ev.session_id; run.modelUsed = ev.model; turn = {
        ids: new Set(),
        in: 0,
        out: 0,
      }
    }
    if (ev.type === 'rate_limit_event') { onRateLimit(ev.rate_limit_info); pushLive() }
    if (ev.type === 'assistant' && ev.message?.usage && !ev.parent_tool_use_id) {
      // оценка на ходу: каждое сообщение модели — один раз; контекст = всё, что ушло на вход последнему
      const u = ev.message.usage; const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      if (!turn.ids.has(ev.message.id)) { turn.ids.add(ev.message.id); turn.in += inTok; turn.out += u.output_tokens || 0 }
      run.ctx = inTok + (u.output_tokens || 0)
      run.liveIn = turn.in; run.liveOut = turn.out
      pushLive()
    }
    if (ev.type === 'result') {
      run.cost = (run.cost || 0) + (ev.total_cost_usd || 0)
      run.turns = (run.turns || 0) + (ev.num_turns || 0)
      run.lastResult = ev.is_error ? 'error' : 'ok'; run.lastText = String(ev.result || '').slice(0, 400)
      // точные цифры хода (по всем моделям, включая подагентов)
      let tin = 0; let tout = 0; let cached = 0
      for (const m of Object.values(ev.modelUsage || {})) {
        tin += (m.inputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0)
        cached += m.cacheReadInputTokens || 0; tout += m.outputTokens || 0
        if (m.contextWindow)
          run.ctxMax = Math.max(run.ctxMax || 0, m.contextWindow)
      }
      if (!tin && !tout) { tin = turn.in; tout = turn.out }
      run.tokIn = (run.tokIn || 0) + tin; run.tokOut = (run.tokOut || 0) + tout; run.tokCached = (run.tokCached || 0) + cached
      run.liveIn = run.liveOut = undefined
    }
    if (ev.type === 'bot_result') {
      if (ev.branch)
        run.branch = ev.branch; if (ev.pr)
        run.prUrl = ev.pr; if (ev.closed)
        run.closedIssue = true
    }
    if (ev.type === 'bot_error')
      run.error = ev.text
    appendEvent(run, slim(ev))
    if (ev.type === 'result')
      run.outNew.push(...collectOut(run, turnStart))
    if (ev.type === 'result' || ev.type === 'bot_result')
      pushState()
  })
  let errTail = ''
  child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000) })
  child.on('close', (code) => {
    clearInterval(wdTimer)
    run.outNew.push(...collectOut(run, turnStart))
    current = null
    const why = diagnose(run)
    if (run.status === 'stopped') { /* остановлен вручную */ }
    else if (run.error) {
      run.status = 'failed'; run.reason = /незакоммиченн/.test(run.error)
        ? 'В копии бота остались несохранённые правки от прошлой задачи, поэтому эта не стартовала. Откройте ту задачу и нажмите «Продолжить» — или отбросьте правки и повторите.'
        : run.error
    }
    else if (why?.limit) { run.status = 'limited'; run.reason = why.text; run.resumeAt = why.resetAt }
    else if (run.kind === 'issue' && (run.prUrl || run.closedIssue)) {
      run.status = 'done'
    }
    else if (why) { run.status = 'failed'; run.reason = why.text }
    else if (CHAT.has(run.kind)) {
      run.status = run.sessionId ? 'waiting' : 'failed'
    }
    else if (run.kind === 'issue') { run.status = 'failed'; run.reason = 'Бот закончил, но PR не открыл — причина в его последнем сообщении (возможно, задача уже сделана или нужна ваша помощь).' }
    else {
      run.status = code === 0
        ? 'done'
        : 'failed'
    }
    if (run.closedIssue)
      run.note = 'Issue уже был закрыт — делать нечего'
    if (run.status === 'failed' && errTail.trim()) {
      appendEvent(run, {
        type: 'bot_stderr',
        text: errTail.trim(),
      })
    }
    run.endedAt = Date.now(); run.liveIn = run.liveOut = undefined
    if (run.status === 'stopped') {
      execFile(AGENT, ['_wip'], {
        env: { ...ENV, BOT_REPO: run.repo || repoOf() },
      }, () => {})
    }
    appendEvent(run, {
      type: 'bot_note',
      text: label(run.status),
      at: Date.now(),
    })
    pushState()
    notify(run)
    if (run.prUrl && run.status === 'done') {
      prReport(run)
        .then(r => r && (appendEvent(run, { type: 'bot_note', text: `${r === 'updated' ? 'Обновлён' : 'В PR —'} комментарий «Что может задеть»${run.fsdNew ? (run.fsdNew.length ? ` · новых нарушений FSD: ${run.fsdNew.length}` : ' · новых нарушений FSD нет') : ''}`, at: Date.now() }), pushState()))
        .catch(e => console.error('pr report:', e.message))
      screensJob(run).catch(e => console.error('screens:', e.message))
    }
    next()
  })
}

function label(s) {
  return ({
    done: 'Готово',
    failed: 'Не получилось',
    waiting: 'Ждёт вашего ответа',
    stopped: 'Остановлено',
    limited: 'Упёрся в лимит — продолжит после сброса',
  })[s] || s
}

// Почему ход закончился ошибкой — по тексту итога Claude Code
function diagnose(run) {
  if (run.lastResult !== 'error')
    return null
  const t = run.lastText || ''
  if (run.ai === 'codex' && /limit/i.test(t))
    return { text: 'Закончился лимит Codex (подписки ChatGPT). Подождите сброса и нажмите «Продолжить» — или «Заново» с Claude.' }
  if (/hit your .*limit|usage limit|limit reached|out of (extra )?usage/i.test(t)) {
    const resetAt = parseReset(t)
    const weekly = /week/i.test(t)
    limits[weekly ? 'seven_day' : 'five_hour'] = {
      ...(limits[weekly ? 'seven_day' : 'five_hour'] || {}),
      status: 'rejected',
      utilization: 1,
      resetsAt: resetAt,
      at: Date.now(),
    }
    fs.writeFileSync(LIMITS, JSON.stringify(limits))
    return { limit: true, resetAt, text: `Закончился ${weekly ? 'недельный' : '5-часовой'} лимит подписки. ${resetAt
      ? `Бот сам продолжит с того же места в ${new Date(resetAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}.`
      : 'Нажмите «Продолжить» после сброса.'}` }
  }
  if (/connection|network|ECONN|socket|fetch failed|timed? ?out|overloaded|529|500|502|503/i.test(t))
    return { text: 'Оборвалась связь с Claude (сбой сети или серверов Anthropic). Работа не потеряна — нажмите «Продолжить».' }
  if (/context|too long|prompt is too long/i.test(t))
    return { text: 'Закончилось окно контекста. Лучше «Заново» — или «Продолжить», если осталось немного.' }
  if (/budget/i.test(t))
    return { text: 'Сработал предохранитель по цене (BOT_BUDGET, по умолчанию $8). Если задача стоит того — «Продолжить».' }
  if (/max.?turns/i.test(t))
    return { text: 'Упёрся в ограничение числа шагов. «Продолжить» — доделает.' }
  return { text: `Claude закончил ход с ошибкой: ${t.slice(0, 200)}` }
}
// «resets 2:50pm (Europe/Moscow)» / «resets 14:50» / «resets Nov 23, 3pm» → ближайший такой момент
function parseReset(t) {
  const m = t.match(/resets\s+(?:at\s+)?(?:([a-z]{3})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m)
    return undefined
  let h = +m[3]; const min = +(m[4] || 0); const ap = (m[5] || '').toLowerCase()
  if (ap === 'pm' && h < 12)
    h += 12; if (ap === 'am' && h === 12)
    h = 0
  const d = new Date(); d.setSeconds(0, 0); d.setHours(h, min)
  if (m[1]) {
    const mon = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[1].toLowerCase()) / 3; if (mon >= 0)
      d.setMonth(mon, +m[2])
  }
  while (d.getTime() < Date.now() - 60000) d.setDate(d.getDate() + 1)
  return d.getTime() + 60000 // с запасом в минуту
}
// после сброса лимита — продолжить сами
setInterval(() => {
  let changed = false
  for (const r of runs) {
    if (r.status === 'limited' && r.resumeAt && r.resumeAt <= Date.now()) { r.continue = true; r.status = 'queued'; changed = true }
  }
  if (changed) { pushState(); next() }
}, 30000)

// ---------- настройки ----------
const CONFIG = path.join(BOT, 'config.json')
const TOKEN = path.join(BOT, 'keys', 'claude-token')
const DEFAULTS = {
  repo: '',
  sizeModels: true,
  ai: 'claude',
  codexModel: '',
  codexEffort: '',
  codexChatModel: '',
  codexChatEffort: '',
  ticketModel: 'sonnet',
  ticketEffort: 'medium',
  chatModel: '',
  chatEffort: '',
  budget: 8,
  codeMode: true,
  notify: true,
  // куда и о чём сообщать: macOS, вкладка браузера, Telegram; события — готово / ждёт ответа / не получилось
  notifyOn: { done: true, waiting: true, failed: true },
  browserNotify: true,
  tgChat: '',
  // сторож: нет событий N мин / задача дольше N мин / одно и то же действие N раз без правок (0 — выключено)
  watchIdle: 15,
  watchMax: 90,
  watchRepeat: 5,
  allowCmds: [],
  denyCmds: [],
  skillsOff: [],
  autoEvery: 5,
  autoMaxPerDay: 10,
  repos: {},
}
function readConfig() {
  let c
  try {
    c = {
      ...DEFAULTS,
      ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')),
    }
  }
  catch { c = { ...DEFAULTS } }
  if (!AIS[c.ai]) // выбранный ИИ не установлен — работает тот, что есть
    c.ai = fallbackAi()
  return c
}
const ALLOWED = {
  ai: ['claude', 'codex'],
  ticketModel: ['haiku', 'sonnet', 'opus'],
  ticketEffort: ['low', 'medium', 'high', 'xhigh'],
  chatModel: ['', 'haiku', 'sonnet', 'opus'],
  chatEffort: ['', 'low', 'medium', 'high', 'xhigh'],
}
function writeConfig(patch) {
  const c = readConfig()
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED[k] && ALLOWED[k].includes(v))
      c[k] = v
    if (k === 'budget' && Number(v) >= 0.5 && Number(v) <= 100)
      c.budget = Math.round(Number(v) * 100) / 100
    if (k === 'codeMode' || k === 'notify' || k === 'sizeModels' || k === 'browserNotify')
      c[k] = !!v
    if (k === 'notifyOn' && v && typeof v === 'object')
      c.notifyOn = { done: !!v.done, waiting: !!v.waiting, failed: !!v.failed }
    if (['watchIdle', 'watchMax', 'watchRepeat'].includes(k) && Number(v) >= 0 && Number(v) <= 600)
      c[k] = Math.round(Number(v))
    if (k === 'repo' && (v === '' || isRepo(v)))
      c.repo = v
    if (['codexModel', 'codexChatModel'].includes(k) && typeof v === 'string' && /^[\w.:-]{0,60}$/.test(v))
      c[k] = v.trim()
    if (['codexEffort', 'codexChatEffort'].includes(k) && [
      '',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ].includes(v)) {
      c[k] = v
    }
    // начала команд для фонового режима: без ; & | $ ` и кавычек
    if ((k === 'allowCmds' || k === 'denyCmds') && Array.isArray(v))
      c[k] = [...new Set(v.map(x => String(x).trim()).filter(x => /^[\w@./:=+ -]{1,80}$/.test(x)))].slice(0, 50)
    if (k === 'skillsOff' && Array.isArray(v))
      c.skillsOff = v.filter(x => typeof x === 'string' && x.length < 200)
    if (k === 'autoEvery' && Number(v) >= 2 && Number(v) <= 120)
      c.autoEvery = Math.round(Number(v))
    if (k === 'autoMaxPerDay' && Number(v) >= 1 && Number(v) <= 100)
      c.autoMaxPerDay = Math.round(Number(v))
  }
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2))
  return c
}
// служебные поля, которые панель не присылает напрямую (чат Telegram)
function writeConfigRaw(patch) {
  const c = readConfig(); Object.assign(c, patch)
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2))
}
// Настройки одного репозитория — config.repos["owner/repo"]
const REPO_FIELDS = {
  ai: v => ['', 'claude', 'codex'].includes(v),
  ticketModel: v => ['', 'haiku', 'sonnet', 'opus'].includes(v),
  codexModel: v => typeof v === 'string' && /^[\w.:-]{0,60}$/.test(v),
  base: v => typeof v === 'string' && /^[\w./-]{0,100}$/.test(v),
  checks: v => typeof v === 'string' && v.length <= 500,
  draft: v => typeof v === 'boolean',
  reviewers: v => typeof v === 'string' && /^[\w,\s/-]{0,200}$/.test(v),
  labels: v => typeof v === 'string' && /^[\w,\s:.-]{0,200}$/.test(v),
  map: v => typeof v === 'boolean', // карта проекта в инструкциях перед задачей
  impact: v => typeof v === 'boolean', // комментарий «Что может задеть» в PR
  fsd: v => typeof v === 'boolean', // новые нарушения FSD в PR
  screens: v => typeof v === 'boolean', // скриншоты до/после для правок интерфейса
  siteUrl: v => typeof v === 'string' && (v === '' || /^https?:\/\/\S{3,200}$/.test(v)),
  previewUrl: v => typeof v === 'string' && (v === '' || /^https?:\/\/\S{3,200}$/.test(v)),
  pages: v => typeof v === 'string' && /^[\w/,\s\-.:?=&]{0,300}$/.test(v),
}
const AUTO_FIELDS = ['issues', 'ci', 'reviews', 'conflicts']
function writeRepoConfig(repo, patch) {
  const c = readConfig()
  const rc = { ...(c.repos?.[repo] || {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (REPO_FIELDS[k]?.(v))
      rc[k] = typeof v === 'string' ? v.trim() : v
    if (k === 'auto' && v && typeof v === 'object')
      rc.auto = Object.fromEntries(AUTO_FIELDS.map(f => [f, f in v ? !!v[f] : !!rc.auto?.[f]]))
  }
  // GitHub reports merge timestamps at second precision.
  if (patch.docReview === true)
    rc.docReviewSince ||= Math.ceil(Date.now() / 1000) * 1000
  if (patch.docReview === false)
    delete rc.docReviewSince
  c.repos = { ...(c.repos || {}), [repo]: rc }
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2))
  return rc
}

// ---------- проверка документации после слияния ----------
function announceDocReview(repo) {
  broadcast({ type: 'doc-review', repo })
}
const docReview = createDocReview({
  stateFile: path.join(DATA, 'doc-review.json'),
  settings: repo => readConfig().repos?.[repo] || {},
  updated: announceDocReview,
  async github(repo, endpoint, { page, perPage, body } = {}) {
    let resource = `repos/${repo}`
    if (endpoint)
      resource += `/${endpoint}`
    if (body)
      return ghJson('POST', resource, body)
    if (page) {
      const separator = resource.includes('?')
        ? '&'
        : '?'
      resource += `${separator}page=${page}&per_page=${perPage}`
    }
    return JSON.parse(await sh('gh', ['api', resource]))
  },
  async baseTree(repo, base) {
    const { W, sha } = await baseRef(repo, true, `refs/remotes/origin/${base}`, { strict: true })
    const git = args => sh('git', ['-C', W, ...args])
    const names = await git(['ls-tree', '-rz', '--name-only', sha])
    const files = new Set(names.split('\0').filter(Boolean))
    return {
      list: () => [...files],
      async read(file, { optional = false, ref = sha } = {}) {
        if (optional) {
          const exists = ref === sha
            ? files.has(file)
            : await git([
                'ls-tree',
                '-r',
                '--name-only',
                ref,
                '--',
                `:(literal)${file}`,
              ])
          if (!exists)
            return null
        }
        return git(['cat-file', 'blob', `${ref}:${file}`])
      },
    }
  },
})
function scanDocumentation() {
  for (const [repo, rc] of Object.entries(readConfig().repos || {})) {
    if (isRepo(repo) && rc.docReviewSince)
      void docReview.scan(repo)
  }
}

// ---------- правила владельца: rules/_global.md и rules/<owner>__<repo>.md ----------
const RULES = path.join(BOT, 'rules')
const rulesFile = repo => path.join(RULES, repo ? `${repo.replace('/', '__')}.md` : '_global.md')
function readRules(repo) {
  const r = f => {
    try { return fs.readFileSync(f, 'utf8') }
    catch { return '' }
  }
  return { global: r(rulesFile()), repo: r(rulesFile(repo)) }
}

// ---------- авторабота: issue «ready-for-agent», упавший CI, конфликты, ревью в PR бота ----------
const AUTO_STATE = path.join(DATA, 'auto.json')
let autoState = { seen: {}, ciTries: {}, day: '', count: 0, log: [], lastAt: 0 }
try { autoState = { ...autoState, ...JSON.parse(fs.readFileSync(AUTO_STATE, 'utf8')) } }
catch {}
const saveAuto = () => fs.writeFileSync(AUTO_STATE, JSON.stringify(autoState))
function autoLog(repo, text) {
  autoState.log.unshift({ at: Date.now(), repo, text })
  autoState.log = autoState.log.slice(0, 50)
}
const isBotAuthor = a => !a || a.is_bot || /^app\/|\[bot\]$/.test(a.login || '')
let autoBusy = false
async function autoTick(force = false) {
  const c = readConfig()
  const repos = Object.entries(c.repos || {}).filter(([, rc]) => AUTO_FIELDS.some(f => rc.auto?.[f]))
  if (!repos.length || autoBusy)
    return
  if (!force && Date.now() - autoState.lastAt < (c.autoEvery || 5) * 60000)
    return
  autoBusy = true
  autoState.lastAt = Date.now()
  const today = new Date().toDateString()
  if (autoState.day !== today)
    Object.assign(autoState, { day: today, count: 0 })
  const max = c.autoMaxPerDay || 10
  let added = 0
  try {
    for (const [repo, rc] of repos) {
      const a = rc.auto
      const ai = AIS[rc.ai] ? rc.ai : c.ai
      if (ai !== 'codex' && Object.values(limits).some(l => l.status === 'rejected' && l.resetsAt > Date.now())) {
        autoLog(repo, 'Пропуск: исчерпан лимит Claude')
        continue
      }
      const active = pred => runs.some(r => r.repo === repo && pred(r) && ['queued', 'running', 'waiting', 'limited'].includes(r.status))
      const enqueue = (fields, why) => {
        if (autoState.count >= max) {
          autoLog(repo, `Дневной предел авторабот (${max}) — «${fields.title}» отложено`)
          return false
        }
        autoState.count++
        added++
        newRun({ ...fields, repo, ai, auto: why })
        autoLog(repo, `${why}: ${fields.title}`)
        return true
      }
      if (a.issues) {
        const issues = await gh(['issue', 'list', '-R', repo, '--state', 'open', '--label', 'ready-for-agent', '--limit', '20', '--json', 'number,title,labels'])
        for (const i of issues) {
          const key = `issue:${repo}#${i.number}`
          if (autoState.seen[key] || i.labels.some(l => l.name === 'in-progress') || active(r => r.issue === i.number))
            continue
          if (enqueue({ kind: 'issue', issue: i.number, title: `#${i.number} ${i.title}` }, 'issue готов для бота'))
            autoState.seen[key] = Date.now()
        }
      }
      if (!a.ci && !a.reviews && !a.conflicts)
        continue
      const prs = await gh(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '30', '--json', 'number,title,headRefName,headRefOid,author,mergeable,statusCheckRollup'])
      for (const p of prs.filter(p => p.headRefName?.startsWith('agent/') || isBotAuthor(p.author))) {
        if (active(r => r.kind === 'pr' && Number(r.pr) === p.number))
          continue
        const id = `${repo}#${p.number}`
        const firstSight = !autoState.seen[`pr:${id}`]
        autoState.seen[`pr:${id}`] ||= Date.now()
        const job = (text, title, why, key) => {
          if (autoState.seen[key])
            return false
          if (enqueue({ kind: 'pr', pr: p.number, text, title: `PR #${p.number}: ${title}` }, why)) {
            autoState.seen[key] = Date.now()
            return true
          }
          return false
        }
        if (a.conflicts && p.mergeable === 'CONFLICTING' && job('@conflicts', 'конфликт с базой', 'конфликт в PR', `conf:${id}:${p.headRefOid}`))
          continue
        if (a.ci) {
          const failed = (p.statusCheckRollup || []).some(x => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(x.conclusion || x.state))
          if (!failed) {
            delete autoState.ciTries[id]
          }
          else if ((autoState.ciTries[id] || 0) >= 3) {
            if (!autoState.seen[`cistop:${id}:${p.headRefOid}`]) {
              autoState.seen[`cistop:${id}:${p.headRefOid}`] = Date.now()
              autoLog(repo, `PR #${p.number}: CI падает третий раз подряд — дальше без меня`)
            }
          }
          else if (job('@ci', 'упавшие проверки', 'CI упал', `ci:${id}:${p.headRefOid}`)) {
            autoState.ciTries[id] = (autoState.ciTries[id] || 0) + 1
            continue
          }
        }
        if (a.reviews) {
          const v = await gh(['pr', 'view', String(p.number), '-R', repo, '--json', 'reviews,comments'])
          const times = [
            ...(v.reviews || []).filter(r => !isBotAuthor(r.author) && (r.state === 'CHANGES_REQUESTED' || r.body?.trim())).map(r => r.submittedAt),
            ...(v.comments || []).filter(r => !isBotAuthor(r.author)).map(r => r.createdAt),
          ].filter(Boolean).sort()
          const last = times.at(-1)
          if (!last)
            continue
          const key = `rev:${id}:${last}`
          if (firstSight)
            autoState.seen[key] = Date.now() // старое ревью — уже до нас; отвечаем только на новое
          else
            job('', 'ответить на ревью', 'новое ревью', key)
        }
      }
    }
  }
  catch (e) { autoLog('', `Ошибка авторабот: ${e.message}`) }
  finally {
    autoBusy = false
    saveAuto()
    if (added) {
      pushState()
      next()
    }
  }
}
setInterval(() => autoTick(), 60000)
function tokenInfo() {
  try {
    const t = fs.readFileSync(TOKEN, 'utf8').trim(); const st = fs.statSync(TOKEN)
    return {
      set: !!t,
      hint: t
        ? `${t.slice(0, 14)}…${t.slice(-4)}`
        : '',
      savedAt: st.mtimeMs,
      mode: (st.mode & 0o777).toString(8),
    }
  }
  catch { return { set: false } }
}
// проверка токена — крошечный запрос к Haiku именно с этим токеном
function checkToken(token) {
  return new Promise((resolve) => {
    const env = { ...ENV, CLAUDE_CODE_OAUTH_TOKEN: token }
    const child = spawn('claude', [
      '-p',
      '--model',
      'haiku',
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--strict-mcp-config',
      '--setting-sources',
      'project',
      'Ответь: ок',
    ], {
      cwd: os.tmpdir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''; let err = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => child.kill(), 60000)
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out); resolve(j.is_error
          ? {
              ok: false,
              error: String(j.result).slice(0, 200),
            }
          : { ok: true })
      }
      catch {
        resolve({
          ok: false,
          error: (err || out || 'нет ответа').trim().split('\n').pop().slice(0, 200),
        })
      }
    })
  })
}

// ---------- уведомления: macOS, вкладка браузера, Telegram ----------
const TG_TOKEN = path.join(BOT, 'keys', 'telegram-token')
const tgToken = () => { try { return fs.readFileSync(TG_TOKEN, 'utf8').trim() } catch { return '' } }
async function tg(method, payload, token = tgToken()) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(10000),
  })
  const d = await r.json().catch(() => ({}))
  if (!d.ok)
    throw new Error(d.description || `Telegram: ${r.status}`)
  return d.result
}
// файлы от бота — следом за сообщением: картинки как фото, остальное документом (до 5 шт., до 20 МБ)
async function tgFiles(chat, files) {
  for (const f of files.slice(0, 5)) {
    try {
      if (fs.statSync(f).size > 20 * 1024 * 1024)
        continue
      const photo = IMG.test(f) && !/\.gif$/i.test(f)
      const fd = new FormData()
      fd.append('chat_id', chat)
      fd.append(photo ? 'photo' : 'document', new Blob([fs.readFileSync(f)]), path.basename(f))
      const r = await fetch(`https://api.telegram.org/bot${tgToken()}/${photo ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) })
      if (!r.ok)
        console.error('telegram file:', r.status, await r.text().catch(() => ''))
    }
    catch (e) { console.error('telegram file:', e.message) }
  }
}
function notify(run) {
  const c = readConfig(); const on = { ...DEFAULTS.notifyOn, ...c.notifyOn }
  const kind = run.status === 'done'
    ? 'done'
    : run.status === 'waiting'
      ? 'waiting'
      : ['failed', 'limited'].includes(run.status) || run.watchdog
          ? 'failed'
          : null
  if (!kind || !on[kind])
    return
  const head = {
    done: run.prUrl ? 'PR готов' : 'Готово',
    waiting: 'Бот ждёт ответа',
    failed: run.watchdog ? 'Сторож остановил' : run.status === 'limited' ? 'Упёрся в лимит' : 'Не получилось',
  }[kind]
  const where = (run.repo || '').split('/')[1] || ''
  const title = `${head}${where ? ` · ${where}` : ''}`
  const detail = String(kind === 'waiting' ? run.lastText || '' : kind === 'failed' ? run.reason || run.error || '' : '').trim()
  if (c.notify) {
    const q = s => String(s).replace(/["\\]/g, '').slice(0, 200)
    execFile('osascript', ['-e', `display notification "${q(detail || run.title)}" with title "${q(title)}" subtitle "${q(detail ? run.title : '')}"`], () => {})
  }
  if (c.browserNotify)
    broadcast({ type: 'notify', title, body: run.title, detail: detail.slice(0, 200), run: run.id })
  if (c.tgChat && tgToken()) {
    const out = run.outNew || []
    const text = [`${title}`, run.title, detail && `\n${detail.slice(0, 600)}`, run.prUrl, out.length && `Файлов от бота: ${out.length} — в панели`].filter(Boolean).join('\n')
    tg('sendMessage', { chat_id: c.tgChat, text, disable_web_page_preview: true })
      .then(() => tgFiles(c.tgChat, out))
      .catch(e => console.error('telegram:', e.message))
  }
}

// ---------- итог PR: состояние, проверки, ревью, файлы с diff ----------
const prCache = new Map()
async function prSummary(run, fresh) {
  const n = Number(String(run.prUrl || '').split('/').pop()) || Number(run.pr)
  if (!n || !isRepo(run.repo))
    return null
  const key = `${run.repo}#${n}`; const hit = prCache.get(key)
  if (hit && !fresh && Date.now() - hit.at < 20000)
    return hit.data
  const R = `repos/${run.repo}`
  const [pr, files, reviews] = await Promise.all([
    gh(['api', `${R}/pulls/${n}`]),
    gh(['api', `${R}/pulls/${n}/files?per_page=100`]),
    gh(['api', `${R}/pulls/${n}/reviews?per_page=100`]),
  ])
  if (!pr?.number)
    return null
  const [runsRes, status] = await Promise.all([
    gh(['api', `${R}/commits/${pr.head.sha}/check-runs?per_page=100`]),
    gh(['api', `${R}/commits/${pr.head.sha}/status`]),
  ])
  const checks = [
    ...(runsRes?.check_runs || []).map(c => ({
      name: c.name,
      url: c.html_url,
      state: c.status !== 'completed'
        ? 'run'
        : c.conclusion === 'success'
          ? 'ok'
          : ['neutral', 'skipped'].includes(c.conclusion) ? 'skip' : 'fail',
    })),
    ...(status?.statuses || []).map(s => ({
      name: s.context,
      url: s.target_url,
      state: s.state === 'success' ? 'ok' : s.state === 'pending' ? 'run' : 'fail',
    })),
  ]
  const last = {}
  for (const v of Array.isArray(reviews) ? reviews : []) {
    if (['APPROVED', 'CHANGES_REQUESTED'].includes(v.state))
      last[v.user?.login] = v.state
  }
  const states = Object.values(last)
  const data = {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.merged ? 'merged' : pr.state,
    draft: !!pr.draft,
    conflicts: pr.mergeable_state === 'dirty',
    review: states.includes('CHANGES_REQUESTED') ? 'changes' : states.includes('APPROVED') ? 'approved' : null,
    comments: (pr.comments || 0) + (pr.review_comments || 0),
    additions: pr.additions,
    deletions: pr.deletions,
    changed: pr.changed_files,
    checks,
    files: (Array.isArray(files) ? files : []).map(f => ({
      name: f.filename,
      status: f.status,
      add: f.additions,
      del: f.deletions,
      patch: f.patch && f.patch.length > 30000 ? `${f.patch.slice(0, 30000)}\n… (обрезано)` : f.patch || '',
    })),
  }
  prCache.set(key, { at: Date.now(), data })
  return data
}

// большие результаты инструментов храним укороченными — лента и так читаемая
function slim(ev) {
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'tool_result') {
        let t = Array.isArray(c.content)
          ? c.content.map(x => x.text || '').join('\n')
          : String(c.content ?? '')
        if (t.length > 3000)
          t = `${t.slice(0, 3000)}\n… (ещё ${t.length - 3000} символов)`
        c.content = t
      }
    }
  }
  return ev
}

// ---------- GitHub-данные для формы ----------
function gh(args) {
  return new Promise(resolve => execFile('gh', args, { env: ENV, timeout: 20000 }, (err, out) => {
    try {
      resolve(err
        ? []
        : JSON.parse(out))
    }
    catch { resolve([]) }
  }))
}
const ghCache = new Map() // repo → { at, data }
async function ghLists(repo, force) {
  const c = ghCache.get(repo)
  if (!force && c && Date.now() - c.at < 60000)
    return c.data
  const [issues, prs] = await Promise.all([
    gh([
      'issue',
      'list',
      '-R',
      repo,
      '--state',
      'open',
      '--limit',
      '60',
      '--json',
      'number,title,labels',
    ]),
    gh([
      'pr',
      'list',
      '-R',
      repo,
      '--state',
      'open',
      '--limit',
      '40',
      '--json',
      'number,title,headRefName,url,author,reviewDecision',
    ]),
  ])
  const data = {
    issues: issues.map(i => ({
      ...i,
      labels: i.labels.map(l => l.name),
    })),
    prs,
  }
  ghCache.set(repo, {
    at: Date.now(),
    data,
  })
  return data
}
// репозитории, к которым у приложения бота есть доступ
let reposCache = { at: 0, list: [] }
let reposLoading = null
async function repoList(force) {
  // свежее 5 мин — сразу; старее — отдаём старое и обновляем в фоне (опрос всех установок — несколько секунд)
  if (!force && reposCache.list.length) {
    if (Date.now() - reposCache.at > 300000 && !reposLoading)
      reposLoading = loadRepos().finally(() => { reposLoading = null })
    return reposCache.list
  }
  if (!reposLoading)
    reposLoading = loadRepos().finally(() => { reposLoading = null })
  return reposLoading
}
async function loadRepos() {
  // все установки приложения: ваш аккаунт и организации
  const r = await new Promise(resolve => execFile(path.join(BOT, 'token.sh'), ['--repos'], { env: ENV, timeout: 30000 }, (err, out) => {
    try { resolve(err ? [] : JSON.parse(out)) }
    catch { resolve([]) }
  }))
  const list = (Array.isArray(r)
    ? r
    : []).sort()
  if (list.length) {
    reposCache = {
      at: Date.now(),
      list,
    }
  }
  return list.length
    ? list
    : [DEFAULT_REPO]
}
function repoOf(r) {
  return isRepo(r)
    ? r
    : readConfig().repo || DEFAULT_REPO
}
const memPath = repo => path.join(BOT, 'memory', `${repo.replace('/', '__')}.md`)

function repoStatus(repo) {
  return new Promise(resolve => execFile(AGENT, ['_status'], {
    env: { ...ENV, BOT_REPO: repo },
    timeout: 60000,
  }, (_e, out) => resolve(String(out || '').trim())))
}

// ---------- HTTP ----------
async function body(req) {
  let s = ''; for await (const c of req) s += c
  try { return JSON.parse(s || '{}') }
  catch { return {} }
}
function json(res, data, code = 200) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }

// Собранная панель (Vue + Vite) — ui/dist; сборка: cd ui && npm run build (bot ui делает сам)
const DIST = path.join(BOT, 'ui', 'dist')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}
function serveStatic(p, res) {
  let file = path.normalize(path.join(DIST, decodeURIComponent(p)))
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end() }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
    file = path.join(DIST, 'index.html')
  if (!fs.existsSync(file)) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Панель не собрана: cd ui && npm install && npm run build') }
  const ext = path.extname(file)
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': file.includes('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  // только с этого компьютера и только со своей страницы
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://127.0.0.1:${PORT}`)
    return json(res, { error: 'forbidden' }, 403)

  if (req.method === 'GET' && !p.startsWith('/api/'))
    return serveStatic(p, res)
  if (p === '/api/state') {
    return json(res, {
      ...snapshot(),
      repo: repoOf(),
      repos: await repoList(url.searchParams.has('fresh')),
    })
  }
  if (p === '/api/codex') {
    return json(res, {
      models: codexModels(),
      login: await codexLogin(),
      limits: readCodexLimits(true),
    })
  }
  if (req.method === 'POST' && p === '/api/codex/limits') { readCodexLimits(true); pushState(); return json(res, { limits: codexLimits }) }
  if (req.method === 'POST' && p === '/api/limits/check') { // крошечный запрос к Haiku — только чтобы узнать лимиты (~$0.01–0.04)
    if (!AIS.claude)
      return json(res, { limits })
    const child = spawn('claude', [
      '-p',
      '--model',
      'haiku',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
      'Ответь одной буквой: ок',
    ], {
      cwd: os.tmpdir(),
      env: ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    readline.createInterface({ input: child.stdout }).on('line', (l) => {
      try {
        const e = JSON.parse(l); if (e.type === 'rate_limit_event')
          onRateLimit(e.rate_limit_info)
      }
      catch {}
    })
    await new Promise(r => child.on('close', r))
    pushState()
    return json(res, { limits })
  }
  if (p === '/api/settings' && req.method === 'GET') {
    return json(res, {
      config: readConfig(),
      token: tokenInfo(),
    })
  }
  if (p === '/api/settings' && req.method === 'POST') {
    return json(res, {
      config: writeConfig(await body(req)),
      token: tokenInfo(),
    })
  }
  if (p === '/api/settings/token' && req.method === 'POST') {
    const b = await body(req)
    if (b.remove) {
      try { fs.unlinkSync(TOKEN) }
      catch {}; return json(res, {
        token: tokenInfo(),
      })
    }
    if (b.check) {
      const t = tokenInfo().set
        ? fs.readFileSync(TOKEN, 'utf8').trim()
        : ''; return json(res, t
        ? await checkToken(t)
        : { ok: false, error: 'Токен не задан' })
    }
    const t = String(b.token || '').trim()
    if (!/^sk-ant-[\w-]{20,}$/.test(t))
      return json(res, { error: 'Не похоже на токен: он начинается с sk-ant-' }, 400)
    const r = await checkToken(t)
    if (!r.ok)
      return json(res, { error: `Claude не принял токен: ${r.error}` }, 400)
    fs.mkdirSync(path.dirname(TOKEN), { recursive: true })
    fs.writeFileSync(TOKEN, `${t}\n`, { mode: 0o600 }); fs.chmodSync(TOKEN, 0o600)
    return json(res, {
      ok: true,
      token: tokenInfo(),
    })
  }
  // скиллы
  if (p === '/api/skills' && req.method === 'GET') {
    const repo = repoOf(url.searchParams.get('repo'))
    const work = path.join(BOT, 'work', repo.replace('/', '__'))
    return json(res, { skills: skills.listSkills(work).map(({ dir, file, ...x }) => x), sources: skills.listSources(work).map(({ dir, ...x }) => x) })
  }
  if (p === '/api/skills/toggle' && req.method === 'POST') {
    const b = await body(req)
    const off = new Set(readConfig().skillsOff)
    if (b.on)
      off.delete(b.id)
    else off.add(b.id)
    writeConfig({ skillsOff: [...off] })
    skills.build()
    return json(res, { ok: true })
  }
  if (p.startsWith('/api/skills/') && req.method === 'POST') {
    const b = await body(req)
    try {
      if (p === '/api/skills/install')
        return json(res, await skills.install(b.spec))
      if (p === '/api/skills/update') {
        await skills.update(b.source)
        return json(res, { ok: true })
      }
      if (p === '/api/skills/remove') {
        skills.remove(b.source)
        return json(res, { ok: true })
      }
    }
    catch (e) { return json(res, { error: e.message }, 400) }
  }
  // правила владельца
  if (p === '/api/rules' && req.method === 'GET')
    return json(res, readRules(repoOf(url.searchParams.get('repo'))))
  if (p === '/api/rules' && req.method === 'POST') {
    const b = await body(req)
    const repo = repoOf(b.repo)
    fs.mkdirSync(RULES, { recursive: true })
    for (const [k, f] of [['global', rulesFile()], ['repo', rulesFile(repo)]]) {
      if (typeof b[k] === 'string') {
        if (b[k].length > 20000)
          return json(res, { error: 'Слишком длинно' }, 400)
        fs.writeFileSync(f, b[k])
      }
    }
    return json(res, readRules(repo))
  }
  // настройки репозитория
  if (p === '/api/repo-settings' && req.method === 'GET')
    return json(res, { settings: readConfig().repos?.[repoOf(url.searchParams.get('repo'))] || {} })
  if (p === '/api/repo-settings' && req.method === 'POST') {
    const b = (await body(req)) ?? {}
    const repo = repoOf(b.repo)
    const rc = writeRepoConfig(repo, b)
    if (b.auto)
      setTimeout(() => autoTick(true), 1000)
    if (typeof b.docReview === 'boolean' || typeof b.base === 'string') {
      announceDocReview(repo)
      if (isRepo(repo) && rc.docReviewSince)
        void docReview.scan(repo)
    }
    if (b.docReview === true) {
      const activationDelay = rc.docReviewSince - Date.now()
      if (activationDelay > 0)
        await new Promise(resolve => setTimeout(resolve, activationDelay))
    }
    return json(res, { settings: rc })
  }
  if (p === '/api/doc-review' && req.method === 'GET') {
    const repo = url.searchParams.get('repo')
    if (!isRepo(repo))
      return json(res, { error: 'Укажите репозиторий' }, 400)
    return json(res, docReview.status(repo))
  }
  if (p === '/api/doc-review/issue' && req.method === 'POST') {
    const { repo, id } = (await body(req)) ?? {}
    if (!isRepo(repo) || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      return json(res, { error: 'Укажите репозиторий и находку' }, 400)
    try {
      const issue = await docReview.publish(repo, id)
      if (!issue)
        return json(res, { error: 'Находка не найдена' }, 404)
      ghCache.delete(repo)
      return json(res, { issue })
    }
    catch {
      return json(res, { error: 'Не удалось создать issue на GitHub. Попробуйте ещё раз.' }, 502)
    }
  }
  // авторабота: журнал
  if (p === '/api/auto' && req.method === 'GET')
    return json(res, { log: autoState.log, count: autoState.count, max: readConfig().autoMaxPerDay, lastAt: autoState.lastAt })
  if (p === '/api/auto/run' && req.method === 'POST') {
    await autoTick(true)
    return json(res, { log: autoState.log })
  }
  if (p === '/api/memory' && req.method === 'GET') {
    const file = memPath(repoOf(url.searchParams.get('repo')))
    let text = ''; try { text = fs.readFileSync(file, 'utf8') }
    catch {}
    return json(res, { text, path: file })
  }
  if (p === '/api/memory' && req.method === 'POST') {
    const b = await body(req)
    if (typeof b.text !== 'string' || b.text.length > 20000)
      return json(res, { error: 'Слишком длинно (до 20 000 символов)' }, 400)
    const file = memPath(repoOf(b.repo))
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, b.text)
    return json(res, { ok: true })
  }
  if (p === '/api/github')
    return json(res, await ghLists(repoOf(url.searchParams.get('repo')), url.searchParams.has('fresh')))
  if (p === '/api/repo-status')
    return json(res, { status: await repoStatus(repoOf(url.searchParams.get('repo'))), busy: !!current })
  if (p === '/api/events') { // SSE: общий поток (без run) или поток одного запуска
    const runId = url.searchParams.get('run')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
    if (runId) {
      try {
        for (const l of fs.readFileSync(evFile(runId), 'utf8').split('\n')) {
          if (l) {
            res.write(`data: ${JSON.stringify({
              type: 'event',
              ev: JSON.parse(l),
            })}\n\n`)
          }
        }
      }
      catch {}
      res.write(`data: ${JSON.stringify({ type: 'replayed' })}\n\n`)
    }
    const c = { res, runId: runId || null }
    clients.add(c); req.on('close', () => clients.delete(c))
    return
  }

  if (req.method === 'POST' && p === '/api/jobs') {
    const b = await body(req)
    const repo = repoOf(b.repo)
    const cfgNow = readConfig()
    let ai = ['claude', 'codex'].includes(b.ai)
      ? b.ai
      : cfgNow.repos?.[repo]?.ai || cfgNow.ai
    if (!AIS[ai]) {
      if (['claude', 'codex'].includes(b.ai))
        return json(res, { error: `${b.ai === 'codex' ? 'Codex' : 'Claude Code'} не установлен` }, 400)
      ai = cfgNow.ai
    }
    const refs = (Array.isArray(b.refs)
      ? b.refs
      : []).filter(r => isRepo(r) && r !== repo).slice(0, 4)
    const opts = {
      model: b.model || undefined,
      effort: b.effort || undefined,
      ai,
      repo,
      refs: refs.length ? refs : undefined,
      files: pickFiles(b.files).length ? pickFiles(b.files) : undefined,
    }
    const made = []
    if (b.kind === 'queue' || b.kind === 'chain') {
      const ids = (b.issues || []).map(Number).filter(Boolean)
      if (!ids.length)
        return json(res, { error: 'Выберите issue' }, 400)
      const { issues } = await ghLists(repo)
      let prev = null
      for (const n of ids) {
        const t = issues.find(i => i.number === n)?.title || ''
        const r = newRun({
          kind: 'issue',
          issue: n,
          title: `#${n} ${t}`,
          group: b.kind,
          ...opts,
          ...(b.kind === 'chain' && prev
            ? { after: prev.id }
            : {}),
        })
        made.push(r); prev = r
      }
    }
    else if (b.kind === 'issue') {
      const { issues } = await ghLists(repo)
      const t = issues.find(i => i.number === Number(b.issue))?.title || ''
      made.push(newRun({
        kind: 'issue',
        issue: Number(b.issue),
        title: `#${b.issue} ${t}`,
        ...opts,
      }))
    }
    else if (b.kind === 'pr') {
      made.push(newRun({
        kind: 'pr',
        pr: Number(b.pr),
        text: b.text || '',
        title: `PR #${b.pr}: ${{ '@ci': 'упавшие проверки', '@conflicts': 'конфликт с базой' }[b.text] || b.text || 'по ревью и проверкам'}`,
        ...opts,
      }))
    }
    else if (KINDS[b.kind]) {
      if (!b.text && !['triage', 'tickets'].includes(b.kind))
        return json(res, { error: 'Опишите задачу' }, 400)
      const names = {
        idea: 'Фича',
        bug: 'Баг',
        triage: 'Разбор issue',
        tickets: 'Нарезать на тикеты',
        task: 'Задача',
      }
      made.push(newRun({
        kind: b.kind,
        text: b.text || '',
        title: `${names[b.kind]}${b.text
          ? `: ${b.text.slice(0, 70)}`
          : ''}`,
        ...opts,
      }))
    }
    else {
      return json(res, { error: 'Неизвестная команда' }, 400)
    }
    pushState(); next()
    return json(res, {
      ids: made.map(r => r.id),
    })
  }

  const pm = p.match(/^\/api\/runs\/(\d+)\/pr$/)
  if (pm) {
    const run = runs.find(r => r.id === pm[1])
    if (!run)
      return json(res, { error: 'Нет такой задачи' }, 404)
    return json(res, { pr: await prSummary(run, url.searchParams.has('fresh')) })
  }
  if (req.method === 'POST' && p === '/api/upload') {
    const max = 25 * 1024 * 1024; const chunks = []; let size = 0
    for await (const c of req) {
      size += c.length
      if (size > max)
        return json(res, { error: 'Файл больше 25 МБ' }, 413)
      chunks.push(c)
    }
    let name = 'file'
    try { name = decodeURIComponent(String(req.headers['x-name'] || 'file')) }
    catch {}
    const ext = (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || (MIME[String(req.headers['content-type']).split('/')[1]] ? String(req.headers['content-type']).split('/')[1] : '')).toLowerCase()
    const base = name.replace(/\.[^.]*$/, '').replace(/[^\w\-а-яё ]+/gi, '_').trim().slice(0, 60) || 'file'
    const dir = path.join(UPLOADS, new Date().toISOString().slice(0, 10))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}-${base}${ext ? `.${ext}` : ''}`)
    fs.writeFileSync(file, Buffer.concat(chunks))
    return json(res, { ...fileInfo(file), size })
  }
  if (p === '/api/file') { // превью вложений — только из uploads/
    const f = url.searchParams.get('p')
    if (!isUpload(f))
      return json(res, { error: 'not found' }, 404)
    const ext = f.split('.').pop().toLowerCase()
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' })
    return fs.createReadStream(f).pipe(res)
  }

  if (p === '/api/repo-secret') { // секреты скриншотов: cookie входа, обход защиты Vercel (keys/screens/, chmod 600)
    if (req.method !== 'POST') {
      const repo = repoOf(url.searchParams.get('repo'))
      return json(res, { cookie: !!secret(repo, 'cookie'), bypass: !!secret(repo, 'bypass') })
    }
    const b = await body(req)
    const repo = repoOf(b.repo)
    if (!['cookie', 'bypass'].includes(b.kind))
      return json(res, { error: 'Не тот секрет' }, 400)
    const v = String(b.value || '').trim()
    if (v.length > 8000 || /[\r\n]/.test(v))
      return json(res, { error: 'Одной строкой, до 8 КБ' }, 400)
    if (v) {
      fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 })
      fs.writeFileSync(secretFile(repo, b.kind), `${v}\n`, { mode: 0o600 }); fs.chmodSync(secretFile(repo, b.kind), 0o600)
    }
    else fs.rmSync(secretFile(repo, b.kind), { force: true })
    return json(res, { cookie: !!secret(repo, 'cookie'), bypass: !!secret(repo, 'bypass') })
  }
  if (req.method === 'POST' && p === '/api/screens/test') { // пробный снимок главной сайта (и превью по шаблону), чтобы проверить доступ
    const b = await body(req)
    const repo = repoOf(b.repo)
    const rc = readConfig().repos?.[repo] || {}
    try {
      const site = await siteOf(repo, rc)
      const shots = site ? [{ key: 'site', url: site + (rc.pages?.trim().split(/[,\s]+/)[0] || '/') }] : []
      if (rc.previewUrl)
        shots.push({ key: 'preview', url: rc.previewUrl.replace('{branch}', 'main').replace('{sha}', '') })
      if (!shots.length)
        return json(res, { error: 'Не знаю адрес сайта: задайте его или «Website» репозитория на GitHub' }, 400)
      const { files } = await shoot(shots, { cookie: secret(repo, 'cookie'), bypass: secret(repo, 'bypass'), outDir: path.join(UPLOADS, 'screens', `test-${repo.replace('/', '__')}-${Date.now()}`) })
      return json(res, { site, files: files.filter(f => f.vp === 'phone').map(f => ({ key: f.key, url: shots.find(x => x.key === f.key)?.url, file: f.file, blocked: f.blocked, error: f.error })) })
    }
    catch (e) { return json(res, { error: e.message.split('\n')[0] }, 500) }
  }
  if (p === '/api/codegraph') { // граф кода: файлы и импорты базовой ветки + где работал бот
    try { return json(res, await codeData(repoOf(url.searchParams.get('repo')), url.searchParams.has('fresh'))) }
    catch (e) { return json(res, { error: e.message }, 500) }
  }
  if (p === '/api/arch') { // схема архитектуры: docs/architecture.json из базовой ветки + каркас сканера
    try { return json(res, await archData(repoOf(url.searchParams.get('repo')), url.searchParams.has('fresh'))) }
    catch (e) { return json(res, { error: e.message }, 500) }
  }
  if (req.method === 'POST' && p === '/api/arch/ai') { // задача боту: проверить каркас по коду и принести PR со схемой
    const b = await body(req)
    const repo = repoOf(b.repo)
    const d = await archData(repo, true)
    const file = path.join(UPLOADS, 'arch', `${repo.replace('/', '__')}-scan.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(d.scan, null, 2))
    const cfgNow = readConfig()
    const ai = AIS[b.ai] ? b.ai : AIS[cfgNow.repos?.[repo]?.ai] ? cfgNow.repos[repo].ai : cfgNow.ai
    const run = newRun({
      kind: 'task',
      repo,
      ai,
      files: [file],
      title: d.saved ? 'Схема архитектуры: обновить' : 'Схема архитектуры: создать',
      text: `${d.saved ? 'Обнови' : 'Создай'} схему архитектуры проекта — файл docs/architecture.json (формат ниже; её рисует панель бота).
Во вложении — каркас от сканера без ИИ (по docker-compose, зависимостям, .env.example и адресам API в коде). Возьми его за основу и проверь по коду и конфигам: убери лишнее, добавь недостающие сервисы, хранилища, очереди, внешние системы и связи — кто кого вызывает (http), кто куда пишет и откуда читает (data), какие события шлёт (event), куда уходят логи и метрики (metrics). У каждого узла — короткая подпись sub: язык · фреймворк · порт или назначение. Добавь 3–6 полезных видов (views), например «Вход и авторизация», «Вызовы между сервисами», «События», «Данные и хранилища».${d.saved ? ' Файл уже есть: обнови его, узлы с "manual": true не трогай.' : ''}
Меняй только docs/architecture.json (и, если уместно, одну строку-ссылку на него в README или AGENTS.md); код не трогай. Проверь, что это валидный JSON и все from/to есть среди nodes. Затем ветка, коммит, PR.

${ARCH_FORMAT}`,
    })
    pushState(); next()
    return json(res, { ids: [run.id] })
  }
  if (p === '/api/installations') { // установки GitHub App: чьи можно использовать (BOT_OWNERS), чужие — удалить
    const run = args => new Promise(resolve => execFile(path.join(BOT, 'token.sh'), args, { env: ENV, timeout: 30000 }, (err, out, e) => resolve({ err: err && (String(e).trim() || err.message), out })))
    if (req.method === 'POST') {
      const b = await body(req)
      if (b.remove) {
        const r = await run(['--uninstall', String(Number(b.remove))])
        if (r.err)
          return json(res, { error: r.err }, 400)
      }
      else if (typeof b.owner === 'string' && /^[\w.-]{1,40}$/.test(b.owner)) {
        const file = path.join(BOT, 'bot.env')
        const text = fs.readFileSync(file, 'utf8')
        const cur = (text.match(/^BOT_OWNERS=['"]?([^'"\n]*)/m)?.[1] || '').split(',').map(x => x.trim()).filter(Boolean)
        const next = b.allow
          ? [...new Set([...cur, b.owner])]
          : cur.filter(x => x.toLowerCase() !== b.owner.toLowerCase())
        if (!next.length)
          return json(res, { error: 'Нужен хотя бы один разрешённый владелец' }, 400)
        const line = `BOT_OWNERS='${next.join(',')}'`
        fs.writeFileSync(file, /^BOT_OWNERS=.*$/m.test(text) ? text.replace(/^BOT_OWNERS=.*$/m, line) : `${text.replace(/\n?$/, '\n')}${line}\n`, { mode: 0o600 })
      }
      reposCache = { at: 0, list: [] }
    }
    const r = await run(['--installations'])
    let list = []
    try { list = JSON.parse(r.out) }
    catch {}
    const owners = (fs.readFileSync(path.join(BOT, 'bot.env'), 'utf8').match(/^BOT_OWNERS=['"]?([^'"\n]*)/m)?.[1] || '').trim()
    return json(res, { list, owners })
  }
  if (p === '/api/telegram') {
    const c = readConfig()
    if (req.method !== 'POST') {
      let bot = ''
      if (tgToken())
        bot = await tg('getMe').then(b => b.username).catch(() => '')
      return json(res, { set: !!tgToken(), bot, chat: c.tgChat })
    }
    const b = await body(req)
    try {
      if (b.token) {
        const t = String(b.token).trim()
        if (!/^\d+:[\w-]{30,}$/.test(t))
          return json(res, { error: 'Не похоже на токен бота — его выдаёт @BotFather' }, 400)
        const me = await tg('getMe', {}, t)
        fs.mkdirSync(path.dirname(TG_TOKEN), { recursive: true })
        fs.writeFileSync(TG_TOKEN, `${t}\n`, { mode: 0o600 }); fs.chmodSync(TG_TOKEN, 0o600)
        return json(res, { set: true, bot: me.username, chat: c.tgChat })
      }
      if (b.find) { // чат — тот, кто последним написал боту
        const ups = await tg('getUpdates', { limit: 50 })
        const chat = [...ups].reverse().map(u => (u.message || u.my_chat_member || {}).chat).find(Boolean)
        if (!chat)
          return json(res, { error: 'Боту пока никто не писал — откройте его в Telegram и нажмите «Старт»' }, 400)
        writeConfigRaw({ tgChat: String(chat.id) })
        await tg('sendMessage', { chat_id: chat.id, text: 'Готово: сюда будут приходить сообщения о задачах бота.' })
        return json(res, { set: true, chat: String(chat.id) })
      }
      if (b.test) {
        await tg('sendMessage', { chat_id: c.tgChat, text: 'Проверка: уведомления работают.' })
        return json(res, { ok: true })
      }
      if (b.remove) {
        try { fs.unlinkSync(TG_TOKEN) }
        catch {}
        writeConfigRaw({ tgChat: '' })
        return json(res, { set: false, chat: '' })
      }
    }
    catch (e) { return json(res, { error: e.message }, 400) }
    return json(res, { error: 'Нечего делать' }, 400)
  }
  const m = p.match(/^\/api\/runs\/(\d+)\/(reply|stop|close|retry|delete|continue)$/)
  if (req.method === 'POST' && m) {
    const run = byId(m[1]); if (!run)
      return json(res, { error: 'Нет такого запуска' }, 404)
    const act = m[2]
    if (act === 'reply') {
      const b = await body(req)
      const files = pickFiles(b.files)
      if (!run.sessionId || (!b.text && !files.length))
        return json(res, { error: 'Нечего продолжать' }, 400)
      run.reply = b.text || 'Посмотри вложения.'; run.replyFiles = files.length ? files : undefined; run.status = 'queued'
    }
    else if (act === 'stop') {
      if (current?.run === run) {
        run.status = 'stopped'; try { process.kill(-current.child.pid, 'SIGTERM') }
        catch {}
      }
      else if (run.status === 'queued') {
        run.status = 'stopped'
      }
    }
    else if (act === 'close') {
      if (run.status === 'waiting')
        run.status = 'done'
    }
    else if (act === 'continue') {
      if (!run.sessionId)
        return json(res, { error: 'Нечего продолжать — нет сессии' }, 400)
      if (CHAT.has(run.kind) && !run.branch)
        run.reply = 'Продолжай с того места, где остановился.'
      else run.continue = true
      run.status = 'queued'
    }
    else if (act === 'retry') {
      if ([
        'failed',
        'stopped',
        'skipped',
        'limited',
      ].includes(run.status)) {
        if (run.status === 'limited')
          run.status = 'stopped'
        const { id, status, createdAt, cost, turns, sessionId, error, prUrl, branch, lastResult, startedAt, endedAt, after, note, reason, resumeAt, lastText, closedIssue, tokIn, tokOut, tokCached, ctx, ctxMax, liveIn, liveOut, watchdog, modelUsed, replyFiles, outSeen, outNew, codexImgs, mapDone, mapFile, fsdNew, ...rest } = run
        newRun(rest)
      }
    }
    else if (act === 'delete') {
      if (current?.run === run)
        return json(res, { error: 'Сначала остановите' }, 400)
      runs = runs.filter(r => r !== run); try { fs.unlinkSync(evFile(run.id)) }
      catch {}
    }
    pushState(); next()
    return json(res, { ok: true })
  }

  if (req.method === 'POST' && p === '/api/reset') {
    if (current)
      return json(res, { error: 'Бот сейчас работает' }, 409)
    const b = await body(req)
    await new Promise(r => execFile(AGENT, ['_reset'], {
      env: {
        ...ENV,
        BOT_REPO: repoOf(b.repo),
      },
    }, r))
    return json(res, { ok: true })
  }

  json(res, { error: 'not found' }, 404)
})

repoList() // список репозиториев — заранее, чтобы панель открывалась сразу
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`bot ui: http://127.0.0.1:${PORT}\n`)
  scanDocumentation()
  setInterval(scanDocumentation, 60000)
  next()
})
process.on('SIGTERM', () => {
  try {
    if (current)
      process.kill(-current.child.pid, 'SIGTERM')
  }
  catch {}; process.exit(0)
})
