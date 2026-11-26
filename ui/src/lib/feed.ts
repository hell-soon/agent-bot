// Лента запуска: события stream-json (Claude, Codex — через адаптер) → элементы для отображения.
type FeedItemBody
  = | {
    k: 'msg'
    key: string
    who: 'bot' | 'user'
    text: string
  }
  | {
    k: 'files'
    key: string
    who?: 'bot' | 'user'
    files: { path: string, name: string, image: boolean }[]
  }
  | {
    k: 'tool'
    key: string
    icon: string
    html: string
    out?: string
    error?: boolean
    todos?: any[]
  }
  | {
    k: 'choice'
    key: string
    q: Question
    answered: boolean
    answer?: string
  }
  | {
    k: 'note'
    key: string
    text: string
  }
  | {
    k: 'result'
    key: string
    html: string
    bad?: boolean
  }

// ei — номер события в журнале: по нему схема задачи прокручивает ленту к нужному месту
export type FeedItem = FeedItemBody & { ei?: number }

export interface Question {
  question: string
  multi?: boolean
  options: {
    label: string
    description?: string
  }[]
}

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[c]!)
}

// Вопрос с вариантами — блок ```choices {json}``` в тексте ответа
export function splitChoices(t: string) {
  const questions: Question[] = []
  // план и вопрос «Разработки фичи» показываются на доске, а не JSON-ом в ленте
  const text = t.replace(/```plan[ \t]*\r?\n[\s\S]*?```/g, '*План — на доске выше.*').replace(/```question[ \t]*\r?\n[\s\S]*?```/g, '*Вопрос — на доске выше: ответьте там или здесь.*').replace(/```choices\s*\n([\s\S]*?)```/g, (all, body) => {
    try {
      const q = JSON.parse(body)
      if (!q.question || !Array.isArray(q.options) || !q.options.length)
        return all
      q.options = q.options.map((o: any) => (typeof o === 'string'
        ? { label: o }
        : o)).filter((o: any) => o?.label)
      questions.push(q); return ''
    }
    catch { return all }
  })
  return { text, questions }
}

export function toolView(
  name: string,
  i: any = {},
  short: (p: string) => string,
): [string, string] {
  switch (name) {
    case 'Read': return ['↗', `Читает <code>${esc(short(i.file_path))}</code>`]
    case 'Grep': return ['⌕', `Ищет <code>${esc(i.pattern)}</code>${i.path
      ? ` в <code>${esc(short(i.path))}</code>`
      : ''}`]
    case 'Glob': return ['⌕', `Ищет файлы <code>${esc(i.pattern)}</code>`]
    case 'Edit': case 'MultiEdit': return ['✎', `Правит <code>${esc(short(i.file_path))}</code>`]
    case 'Write': return ['✎', `Записывает <code>${esc(short(i.file_path))}</code>`]
    case 'Bash': return ['›', `<code>${esc(i.command?.length > 240
      ? `${i.command.slice(0, 240)}…`
      : i.command)}</code>`]
    case 'Skill': return ['✦', `Скилл <code>/${esc(i.skill || i.command || '')}</code>`]
    case 'Task': case 'Agent': return ['⧉', `Подагент: ${esc(i.description || '')}`]
    case 'WebFetch': case 'WebSearch': return ['◎', `${name} <code>${esc(i.url || i.query || '')}</code>`]
    default: return [
      '·',
      esc(name),
    ]
  }
}

export function buildFeed(events: any[], short: (p: string) => string) {
  const items: FeedItem[] = []
  const tools = new Map<string, Extract<FeedItem, { k: 'tool' }>>()
  let todos: any[] | null = null
  const files = new Set<string>()
  let n = 0
  const key = () => String(n++)
  let ei = 0
  const push = (it: FeedItem) => { it.ei = ei; items.push(it) }
  for (; ei < events.length; ei++) {
    const ev = events[ei]
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text?.trim()) {
          const { text, questions } = splitChoices(c.text)
          if (text.trim()) {
            push({
              k: 'msg',
              key: key(),
              who: 'bot',
              text,
            })
          }
          for (const q of questions) {
            push({
              k: 'choice',
              key: key(),
              q,
              answered: false,
            })
          }
        }
        if (c.type === 'tool_use') {
          if (c.name === 'TodoWrite') {
            todos = c.input?.todos || []; push({
              k: 'tool',
              key: key(),
              icon: '☐',
              html: 'План',
              todos: todos!,
            }); continue
          }
          if (['Edit', 'MultiEdit', 'Write'].includes(c.name) && c.input?.file_path) {
            const f = short(c.input.file_path); if (!f.startsWith('/'))
              files.add(f)
          }
          const [icon, html] = toolView(c.name, c.input, short)
          const it = {
            k: 'tool' as const,
            key: key(),
            icon,
            html,
          }
          tools.set(c.id, it); push(it)
        }
      }
    }
    else if (ev.type === 'user') {
      for (const c of ev.message?.content || []) {
        if (c.type !== 'tool_result')
          continue
        const it = tools.get(c.tool_use_id); if (!it)
          continue
        const out = String(c.content ?? '').trim()
        if (out)
          it.out = out
        if (c.is_error)
          it.error = true
      }
    }
    else if (ev.type === 'result') {
      if (ev.is_error) {
        push({
          k: 'note',
          key: key(),
          text: 'Закончил с ошибкой',
        })
      }
      else if (ev.num_turns > 2) {
        push({
          k: 'note',
          key: key(),
          text: `${ev.num_turns} шагов${ev.duration_ms
            ? ` · ${Math.max(1, Math.round(ev.duration_ms / 60000))} мин`
            : ''}${ev.total_cost_usd
            ? ` · $${ev.total_cost_usd.toFixed(2)}`
            : ''}`,
        })
      }
    }
    else if (ev.type === 'bot_user') {
      for (const it of items) {
        if (it.k === 'choice' && !it.answered) { it.answered = true; it.answer = ev.text }
      }
      push({
        k: 'msg',
        key: key(),
        who: 'user',
        text: ev.text,
      })
      if (ev.files?.length)
        push({ k: 'files', key: key(), files: ev.files })
    }
    else if (ev.type === 'bot_files' && ev.files?.length) {
      push({ k: 'files', key: key(), who: ev.from === 'bot' ? 'bot' : 'user', files: ev.files })
    }
    else if (ev.type === 'bot_note') {
      if (!/^(Ждёт вашего ответа|Запуск|Готово)$/.test(ev.text)) {
        push({
          k: 'note',
          key: key(),
          text: ev.text,
        })
      }
    }
    else if (ev.type === 'bot_result') {
      if (ev.closed) {
        push({
          k: 'result',
          key: key(),
          html: esc(ev.text),
        })
      }
      else if ('pr' in ev) {
        push(ev.pr
          ? {
              k: 'result',
              key: key(),
              html: `PR открыт — <a href="${esc(ev.pr)}" target="_blank">${esc(String(ev.pr).replace('https://github.com/', ''))}</a>`,
            }
          : {
              k: 'result',
              key: key(),
              html: `PR не появился (ветка <code>${esc(ev.branch)}</code>). Причина — выше.`,
              bad: true,
            })
      }
    }
    else if (ev.type === 'bot_error') {
      push({
        k: 'result',
        key: key(),
        html: esc(ev.text) + (ev.code === 'dirty'
          ? ' — нажмите «Отбросить» на главной и повторите.'
          : ''),
        bad: true,
      })
    }
    else if (ev.type === 'bot_stderr' || (ev.type === 'bot_raw' && ev.text?.trim())) {
      push({
        k: 'tool',
        key: key(),
        icon: '!',
        html: ev.type === 'bot_stderr'
          ? 'Сообщения об ошибках'
          : '',
        out: ev.text,
        error: ev.type === 'bot_stderr',
      })
    }
  }
  return {
    items,
    todos,
    files: [...files],
  }
}
