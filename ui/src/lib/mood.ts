// Эмоция мини-агента — только по состоянию запуска и последним событиям, без модели.
// События одинаковые у Claude и Codex (Codex приходит через codex-adapter.mjs), так что правила общие.

export type Mood
  = | 'sleepy' // в очереди
    | 'working' // вызывает инструмент
    | 'thinking' // пишет или обдумывает
    | 'curious' // задал вопрос
    | 'calm' // ответил, ждёт
    | 'tired' // упёрся в лимит
    | 'confused' // ошибка
    | 'happy' // готово, есть PR
    | 'pleased' // готово без PR

export const MOOD_LABEL: Record<Mood, string> = {
  sleepy: 'ждёт очереди',
  working: 'работает',
  thinking: 'задумался',
  curious: 'любопытствует',
  calm: 'спокоен',
  tired: 'устал',
  confused: 'озадачен',
  happy: 'радуется',
  pleased: 'доволен',
}

interface RunLike {
  status?: string
  pause?: unknown
  prUrl?: string
  lastResult?: string
  lastText?: string
}

// последнее «содержательное» событие модели: ответ ассистента или результат инструмента
function lastStep(events: any[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type === 'assistant' || ev?.type === 'user' || ev?.type === 'result')
      return ev
  }
  return null
}

const asksQuestion = (text = '') => /```(?:choices|question)\b/.test(text)

export function moodOf(run: RunLike | null | undefined, events: any[] = []): Mood {
  switch (run?.status) {
    case 'queued':
      return 'sleepy'
    case 'running': {
      const ev = lastStep(events)
      const content = ev?.type === 'assistant'
        ? ev.message?.content || []
        : []
      return content.some((c: any) => c?.type === 'tool_use')
        ? 'working'
        : 'thinking'
    }
    case 'limited':
      return 'tired'
    case 'failed':
      return 'confused'
    case 'done':
      return run.prUrl ? 'happy' : 'pleased'
    case 'waiting':
      if (run.lastResult === 'error')
        return 'confused'
      if (run.pause || asksQuestion(run.lastText))
        return 'curious'
      return 'calm'
    default: // stopped, skipped и неизвестное
      return 'calm'
  }
}
