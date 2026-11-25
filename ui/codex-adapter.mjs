// Запуск Codex (OpenAI) в фоне и перевод его событий в формат stream-json Claude Code — его понимает панель.
//   node codex-adapter.mjs new "<задача>"
//   node codex-adapter.mjs resume <thread_id> "<сообщение>"
// Окружение: CODEX_MODEL, CODEX_EFFORT (low|medium|high|xhigh), CODEX_WRITABLE (доп. папка на запись, напр. память),
//            CODEX_INTERACTIVE_HINT — не используется здесь.
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const [mode, a1, a2] = process.argv.slice(2)
const prompt = mode === 'resume' ? a2 : a1
if (!prompt || (mode === 'resume' && !a1)) { console.error('usage: codex-adapter new <prompt> | resume <id> <prompt>'); process.exit(2) }

const cfg = [
  '-c', 'sandbox_mode="workspace-write"',
  '-c', 'sandbox_workspace_write.network_access=true', // git push, gh, npm
  '-c', 'approval_policy="never"',
]
if (process.env.CODEX_WRITABLE) cfg.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([process.env.CODEX_WRITABLE])}`)
if (process.env.CODEX_EFFORT) cfg.push('-c', `model_reasoning_effort="${process.env.CODEX_EFFORT}"`)
const model = process.env.CODEX_MODEL ? ['-m', process.env.CODEX_MODEL] : []
const args = mode === 'resume'
  ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...model, ...cfg, a1, prompt]
  : ['exec', '--json', '--skip-git-repo-check', ...model, ...cfg, prompt]

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const started = Date.now()
let session = mode === 'resume' ? a1 : '', lastText = '', turns = 0, failed = null, n = 0
const usage = { in: 0, out: 0, cached: 0 }
const said = new Set() // id элементов, для которых уже выдан tool_use

function toolUse(id, name, input) { if (said.has(id)) return; said.add(id); turns++; out({ type: 'assistant', message: { id: `cx-${id}-${n++}`, content: [{ type: 'tool_use', id, name, input }] } }) }
function toolResult(id, content, isError) { out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: String(content ?? ''), is_error: !!isError }] } }) }
const shortCmd = (c) => String(c || '').replace(/^\/bin\/(z|ba)?sh -l?c\s+/, '').replace(/^(['"])([\s\S]*)\1$/, '$2')

function onItem(kind, it) {
  switch (it.type) {
    case 'agent_message':
      if (kind === 'completed' && it.text) { lastText = it.text; out({ type: 'assistant', message: { id: `cx-${it.id}`, content: [{ type: 'text', text: it.text }] } }) }
      break
    case 'command_execution':
      toolUse(it.id, 'Bash', { command: shortCmd(it.command) })
      if (kind === 'completed') toolResult(it.id, it.aggregated_output, it.exit_code !== 0 && it.exit_code != null)
      break
    case 'file_change':
      if (kind !== 'completed') break
      for (const [i, ch] of (it.changes || []).entries()) {
        const id = `${it.id}-${i}`
        toolUse(id, ch.kind === 'add' ? 'Write' : 'Edit', { file_path: ch.path })
        toolResult(id, ch.kind === 'delete' ? 'удалён' : '', it.status === 'failed')
      }
      break
    case 'todo_list':
      out({ type: 'assistant', message: { id: `cx-${it.id}-${n++}`, content: [{ type: 'tool_use', id: `${it.id}-${n}`, name: 'TodoWrite',
        input: { todos: (it.items || []).map((t) => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })) } }] } })
      break
    case 'web_search':
      toolUse(it.id, 'WebSearch', { query: it.query })
      if (kind === 'completed') toolResult(it.id, '')
      break
    case 'mcp_tool_call':
      toolUse(it.id, `${it.server}:${it.tool}`, it.arguments || {})
      if (kind === 'completed') toolResult(it.id, it.error?.message || '', it.status === 'failed')
      break
    case 'error':
      out({ type: 'bot_raw', text: '⚠️ ' + (it.message || '') })
      break
    // reasoning — внутренние рассуждения, в ленту не выводим
  }
}

const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
let errTail = ''
child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-3000) })
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let ev; try { ev = JSON.parse(line) } catch { return }
  if (ev.type === 'thread.started') { session = ev.thread_id; out({ type: 'system', subtype: 'init', session_id: session, model: 'codex' + (process.env.CODEX_MODEL ? ' · ' + process.env.CODEX_MODEL : ''), provider: 'codex' }) }
  else if (ev.type === 'item.started' || ev.type === 'item.updated') onItem('started', ev.item)
  else if (ev.type === 'item.completed') onItem('completed', ev.item)
  else if (ev.type === 'turn.completed') {
    const u = ev.usage || {}
    usage.in += u.input_tokens || 0; usage.cached += u.cached_input_tokens || 0; usage.out += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0)
  } else if (ev.type === 'turn.failed') failed = ev.error?.message || 'ход не удался'
  else if (ev.type === 'error') failed = ev.message || 'ошибка'
})
child.on('close', (code) => {
  if (!failed && code !== 0) failed = errTail.trim().split('\n').filter(Boolean).pop() || `codex завершился с кодом ${code}`
  out({
    type: 'result', subtype: failed ? 'error' : 'success', is_error: !!failed, session_id: session,
    result: failed || lastText, num_turns: turns, duration_ms: Date.now() - started, total_cost_usd: 0,
    // input_tokens у Codex уже включает кэш — в modelUsage кладём «некэшированное» отдельно, как у Claude
    modelUsage: { codex: { inputTokens: usage.in - usage.cached, cacheReadInputTokens: usage.cached, outputTokens: usage.out } },
  })
  process.exit(0)
})
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { child.kill(s); setTimeout(() => process.exit(1), 2000) })
