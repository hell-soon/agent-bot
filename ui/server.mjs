import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
// Панель бота: http://127.0.0.1:4545 — запускает ../agent.sh в фоне и показывает ход работы.
// Без зависимостей. Запуск: bot ui
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

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
fs.mkdirSync(DATA, { recursive: true })

/** @type {any[]} */
let runs = []
try { runs = JSON.parse(fs.readFileSync(STATE, 'utf8')) }
catch {}
// после перезапуска сервера «работающие» уже не работают
for (const r of runs) {
  if (r.status === 'running')
    r.status = 'stopped'
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
  runs.push(run)
  return run
}

function next() {
  if (current)
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
      at: Date.now(),
    })
  }
  else {
    appendEvent(run, {
      type: 'bot_note',
      text: 'Запуск',
      at: Date.now(),
    })
  }
  run.reply = undefined
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

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev
    try { ev = JSON.parse(line) }
    catch { ev = { type: 'bot_raw', text: line } }
    if (ev.type === 'system' && ev.subtype === 'init') {
      run.sessionId = ev.session_id; run.model ||= ev.model; turn = {
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
    if (ev.type === 'result' || ev.type === 'bot_result')
      pushState()
  })
  let errTail = ''
  child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000) })
  child.on('close', (code) => {
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
    if (!runs.some(r => r.status === 'queued'))
      notify(run)
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
}
function readConfig() {
  try {
    return {
      ...DEFAULTS,
      ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')),
    }
  }
  catch { return { ...DEFAULTS } }
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
    if (k === 'codeMode' || k === 'notify' || k === 'sizeModels')
      c[k] = !!v
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
  }
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2))
  return c
}
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

function notify(run) {
  if (!readConfig().notify)
    return
  const t = `${run.title}: ${label(run.status)}`.replace(/["\\]/g, '')
  execFile('osascript', ['-e', `display notification "${t}" with title "bot"`], () => {})
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
async function repoList(force) {
  if (!force && reposCache.list.length && Date.now() - reposCache.at < 300000)
    return reposCache.list
  const r = await gh([
    'api',
    '/installation/repositories',
    '--paginate',
    '--jq',
    '[.repositories[].full_name]',
  ])
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
    const ai = ['claude', 'codex'].includes(b.ai)
      ? b.ai
      : readConfig().ai
    const repo = repoOf(b.repo)
    const refs = (Array.isArray(b.refs)
      ? b.refs
      : []).filter(r => isRepo(r) && r !== repo).slice(0, 4)
    const opts = {
      model: b.model || undefined,
      effort: b.effort || undefined,
      ai,
      repo,
      refs: refs.length ? refs : undefined,
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
        title: `PR #${b.pr}: ${b.text || 'по ревью и проверкам'}`,
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

  const m = p.match(/^\/api\/runs\/(\d+)\/(reply|stop|close|retry|delete)$/)
  if (req.method === 'POST' && m) {
    const run = byId(m[1]); if (!run)
      return json(res, { error: 'Нет такого запуска' }, 404)
    const act = m[2]
    if (act === 'reply') {
      const b = await body(req)
      if (!run.sessionId || !b.text)
        return json(res, { error: 'Нечего продолжать' }, 400)
      run.reply = b.text; run.status = 'queued'
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
        const { id, status, createdAt, cost, turns, sessionId, error, prUrl, branch, lastResult, startedAt, endedAt, after, note, reason, resumeAt, lastText, closedIssue, tokIn, tokOut, tokCached, ctx, ctxMax, liveIn, liveOut, ...rest } = run
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

server.listen(PORT, '127.0.0.1', () => { console.log(`bot ui: http://127.0.0.1:${PORT}`); next() })
process.on('SIGTERM', () => {
  try {
    if (current)
      process.kill(-current.child.pid, 'SIGTERM')
  }
  catch {}; process.exit(0)
})
