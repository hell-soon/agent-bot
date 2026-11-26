// Схема задачи: события журнала → этапы на оси (изучает → правит → проверяет → PR …)
// У новых событий есть время (t) — у этапов длительность и паузы; у старых — только порядок.

export type Phase = 'start' | 'read' | 'plan' | 'agent' | 'edit' | 'check' | 'git' | 'pr' | 'ask' | 'answer' | 'files' | 'error' | 'end' | 'note'

export interface Step { label: string, ei: number, error?: boolean }
export interface SchemaNode {
  id: number
  kind: Phase
  title: string
  sub: string
  t0?: number
  t1?: number
  ei: number
  steps: Step[]
  files: string[]
  errors: number
}

export const PHASE: Record<Phase, { title: string, icon: string }> = {
  start: { title: 'Запуск', icon: '▶' },
  read: { title: 'Изучает код', icon: '⌕' },
  plan: { title: 'План', icon: '☐' },
  agent: { title: 'Скиллы и подагенты', icon: '✦' },
  edit: { title: 'Правки', icon: '✎' },
  check: { title: 'Проверки', icon: '✓' },
  git: { title: 'Git', icon: '⑂' },
  pr: { title: 'Pull request', icon: '⇡' },
  ask: { title: 'Вопрос вам', icon: '?' },
  answer: { title: 'Ваш ответ', icon: '↩' },
  files: { title: 'Файлы', icon: '▤' },
  error: { title: 'Ошибка', icon: '!' },
  end: { title: 'Готово', icon: '●' },
  note: { title: '', icon: '·' },
}

const CHECK = /\b(?:test|tests|lint|typecheck|type-check|build|check|vitest|jest|pytest|tsc|vue-tsc|eslint|playwright|cargo (?:test|build|check|clippy)|go (?:test|build|vet))\b/
const GIT = /^\s*git (?:add|commit|push|checkout|switch|merge|rebase|stash|restore|reset|branch|cherry-pick)\b/

function classify(name: string, i: any = {}): Phase {
  if ([
    'Edit',
    'MultiEdit',
    'Write',
    'NotebookEdit',
  ].includes(name)) {
    return 'edit'
  }
  if (name === 'TodoWrite')
    return 'plan'
  if (['Skill', 'Task', 'Agent'].includes(name))
    return 'agent'
  if (name === 'Bash') {
    const c = String(i.command || '')
    if (/\bgh pr (?:create|edit|ready|comment)\b/.test(c))
      return 'pr'
    if (GIT.test(c))
      return 'git'
    if (/\b(?:npm|pnpm|yarn|bun|npx|bunx|node|make|cargo|go|python3?)\b/.test(c) && CHECK.test(c))
      return 'check'
  }
  return 'read'
}

function stepLabel(name: string, i: any, short: (p: string) => string) {
  switch (name) {
    case 'Read': return `читает ${short(i.file_path)}`
    case 'Grep': return `ищет «${i.pattern}»`
    case 'Glob': return `ищет файлы ${i.pattern}`
    case 'Edit': case 'MultiEdit': return `правит ${short(i.file_path)}`
    case 'Write': return `записывает ${short(i.file_path)}`
    case 'Bash': return String(i.command || '').split('\n')[0].slice(0, 140)
    case 'TodoWrite': return `план: ${(i.todos || []).length} пунктов`
    case 'Skill': return `скилл /${i.skill || i.command || ''}`
    case 'Task': case 'Agent': return `подагент: ${i.description || ''}`
    default: return name
  }
}

function plural(n: number, a: string, b: string, c: string) {
  return `${n} ${n % 10 === 1 && n % 100 !== 11
    ? a
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
      ? b
      : c}`
}

function summary(n: SchemaNode) {
  const s = n.steps.length
  switch (n.kind) {
    case 'read': return plural(s, 'шаг', 'шага', 'шагов')
    case 'edit': return `${plural(s, 'правка', 'правки', 'правок')} в ${plural(n.files.length, 'файле', 'файлах', 'файлах')}`
    case 'check': return n.errors
      ? `${plural(s, 'запуск', 'запуска', 'запусков')}, упало ${n.errors}`
      : `${plural(s, 'запуск', 'запуска', 'запусков')}, всё прошло`
    case 'git': case 'pr': case 'agent': case 'plan': return n.steps.map(x => x.label).slice(-1)[0] || ''
    default: return n.sub
  }
}

export function buildSchema(events: any[], short: (p: string) => string) {
  const nodes: SchemaNode[] = []
  const tools = new Map<string, { step: Step, node: SchemaNode }>() // без ссылки шаг → этап: круг ломает Vue
  let lastText = ''
  const open = (kind: Phase, ei: number, t?: number, title?: string, sub = '') => {
    const n: SchemaNode = {
      id: nodes.length,
      kind,
      title: title ?? PHASE[kind].title,
      sub,
      t0: t,
      t1: t,
      ei,
      steps: [],
      files: [],
      errors: 0,
    }
    nodes.push(n)
    return n
  }
  const cur = () => nodes[nodes.length - 1]

  events.forEach((ev, ei) => {
    const t: number | undefined = ev.t ?? ev.at
    const n0 = cur()
    if (n0 && t)
      n0.t1 = t
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text?.trim())
          lastText = c.text
        if (c.type !== 'tool_use')
          continue
        const kind = classify(c.name, c.input)
        let n = cur()
        if (!n || n.kind !== kind)
          n = open(kind, ei, t) // у старых задач у шагов нет времени — этап без времени, а не с чужим
        const step: Step = {
          label: stepLabel(c.name, c.input || {}, short),
          ei,
        }
        n.steps.push(step)
        tools.set(c.id, { step, node: n })
        const fp = c.input?.file_path
        if (kind === 'edit' && fp && !n.files.includes(short(fp)))
          n.files.push(short(fp))
      }
    }
    else if (ev.type === 'user') {
      for (const c of ev.message?.content || []) {
        const st = c.type === 'tool_result' && tools.get(c.tool_use_id)
        if (st && c.is_error && !st.step.error) { st.step.error = true; st.node.errors++ }
      }
    }
    else if (ev.type === 'bot_user') {
      open('answer', ei, t, undefined, String(ev.text || '').slice(0, 160))
    }
    else if (ev.type === 'bot_files' && ev.files?.length) {
      open('files', ei, t, ev.from === 'bot'
        ? 'Файлы от бота'
        : 'Ваши вложения', ev.files.map((f: any) => f.name).join(', '))
    }
    else if (ev.type === 'bot_result' && ev.pr) {
      open('pr', ei, t, `PR #${String(ev.pr).split('/').pop()} открыт`, String(ev.pr).replace('https://github.com/', ''))
    }
    else if (ev.type === 'bot_error') {
      open('error', ei, t, undefined, String(ev.text || '').slice(0, 200))
    }
    else if (ev.type === 'result' && ev.is_error) {
      open('error', ei, t, 'Ход закончился ошибкой', String(ev.result || '').slice(0, 200))
    }
    else if (ev.type === 'bot_note') {
      const text = String(ev.text || '')
      if (text === 'Запуск') {
        open('start', ei, t)
      }
      else if (text === 'Продолжение с того же места') {
        open('start', ei, t, 'Продолжение')
      }
      else if (text === 'Ждёт вашего ответа') {
        open('ask', ei, t, undefined, lastText.replace(/```choices[\s\S]*?```/g, '').trim().slice(-200))
      }
      else if (text.startsWith('Сторож')) {
        open('error', ei, t, 'Сторож остановил', text.replace(/^Сторож:\s*/, ''))
      }
      else if (/^(Готово|Не получилось|Остановлено|Упёрся в лимит|Закончил)/.test(text)) {
        open(text === 'Готово'
          ? 'end'
          : text === 'Остановлено'
            ? 'note'
            : 'error', ei, t, text)
      }
      else if (text) {
        open('note', ei, t, text)
      }
    }
  })

  // одиночное «заглянул в файл» между двумя одинаковыми этапами — часть этих этапов
  for (let i = 1; i < nodes.length - 1; i++) {
    const [a, b, c] = [nodes[i - 1], nodes[i], nodes[i + 1]]
    if (b.kind === 'read' && b.steps.length <= 2 && a.kind === c.kind && ['edit', 'check'].includes(a.kind)) {
      a.steps.push(...b.steps, ...c.steps)
      a.errors += c.errors
      for (const f of c.files) {
        if (!a.files.includes(f))
          a.files.push(f)
      }
      a.t1 = c.t1 ?? a.t1
      nodes.splice(i, 2)
      i--
    }
  }
  nodes.forEach((n, i) => {
    n.id = i
    if (!n.sub)
      n.sub = summary(n)
    const next = nodes[i + 1]
    if (next?.t0 && n.t0 && (!n.t1 || n.t1 < next.t0) && [
      'read',
      'edit',
      'check',
      'git',
      'plan',
      'agent',
    ].includes(n.kind)) {
      n.t1 = next.t0
    }
  })
  const t0 = nodes.find(n => n.t0)?.t0
  const t1 = [...nodes].reverse().find(n => n.t1)?.t1
  return {
    nodes,
    span: t0 && t1
      ? t1 - t0
      : 0,
    edits: nodes.filter(n => n.kind === 'edit').reduce((a, n) => a + n.steps.length, 0),
    checks: nodes.filter(n => n.kind === 'check').reduce((a, n) => a + n.steps.length, 0),
    steps: nodes.reduce((a, n) => a + n.steps.length, 0),
  }
}

export function dur(ms: number) {
  const m = Math.round(ms / 60000)
  if (ms < 60000)
    return `${Math.max(1, Math.round(ms / 1000))} с`
  if (m < 60)
    return `${m} мин`
  const h = Math.floor(m / 60)
  return h < 24
    ? `${h} ч ${m % 60
        ? `${m % 60} мин`
        : ''}`.trim()
    : `${Math.floor(h / 24)} д ${h % 24} ч`
}
