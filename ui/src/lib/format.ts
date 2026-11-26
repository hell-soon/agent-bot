export type Ai = 'claude' | 'codex'

export const STATUS: Record<string, string> = {
  limited: 'ждёт лимита',
  queued: 'в очереди',
  running: 'работает',
  waiting: 'ждёт ответа',
  done: 'готово',
  failed: 'не получилось',
  stopped: 'остановлено',
  skipped: 'пропущено',
}
export function aiName(ai?: string) {
  return ai === 'codex'
    ? 'Codex'
    : 'Claude'
}
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const modKey = isMac ? '⌘' : 'Ctrl '

export function ago(t?: number) {
  if (!t)
    return ''
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1
    ? 'сейчас'
    : m < 60
      ? `${m} мин`
      : m < 1440
        ? `${Math.round(m / 60)} ч`
        : new Date(t).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
}
export function until(t?: number) {
  if (!t)
    return ''
  const m = Math.max(0, Math.round((t - Date.now()) / 60000))
  return m < 60
    ? `через ${m} мин`
    : m < 1440
      ? `через ${Math.floor(m / 60)} ч ${m % 60} мин`
      : new Date(t).toLocaleString('ru', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
export function money(c?: number) {
  return c
    ? `$${c.toFixed(2)}`
    : ''
}
export function tok(n?: number) {
  return !n
    ? '0'
    : n >= 1e6
      ? `${(n / 1e6).toFixed(n >= 1e7
        ? 0
        : 1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}k`
        : String(n)
}
export function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
export function greeting() {
  const h = new Date().getHours(); return h < 5
    ? 'Доброй ночи'
    : h < 12
      ? 'Доброе утро'
      : h < 18
        ? 'Добрый день'
        : 'Добрый вечер'
}

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[c]!)
}

// Простой markdown ответов ИИ: блоки кода, `код`, **жирный**, ссылки, абзацы. Всё экранируется.
export function md(s: string) {
  let h = esc(s)
  h = h.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`)
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  h = h.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
  return h.split(/\n{2,}/).map(p => (p.startsWith('<pre>')
    ? p
    : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('')
}

export const runTok = (r: any) => ({ in: (r.tokIn || 0) + (r.liveIn || 0), out: (r.tokOut || 0) + (r.liveOut || 0) })
export function isActive(r: any) {
  return [
    'running',
    'queued',
    'waiting',
    'limited',
  ].includes(r.status)
}
export function kindIcon(k?: string) {
  return k === 'bug'
    ? 'bug'
    : k === 'idea'
      ? 'idea'
      : k === 'pr' || k === 'feature'
        ? k
        : k === 'issue'
          ? 'issue'
          : 'task'
}
