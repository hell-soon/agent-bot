// Общее состояние панели: запуски, лимиты, настройки, GitHub-данные, навигация (по hash).
import { reactive, computed, watch } from 'vue'
import { api, ls } from './api'
import { aiName, type Ai } from './format'

export type Mode = 'task' | 'issue' | 'idea' | 'bug' | 'pr' | 'queue' | 'chain' | 'triage' | 'tickets'
export const MODES: Record<Mode, { name: string; ph?: string; hint: string; more?: boolean }> = {
  task: { name: 'Своими словами', ph: 'Что сделать? Например: «поправь отступы в карточке плеера на телефоне»', hint: '' },
  issue: { name: 'Из issue', hint: 'Бот создаст ветку, напишет код, проверит и откроет PR — без вопросов.' },
  idea: { name: 'Фича', ph: 'Идея своими словами: что не устраивает, что хочется', hint: 'Бот изучит код и будет спрашивать по одному. Итог — issue, которые можно отдать боту.' },
  bug: { name: 'Баг', ph: 'Что делали → что ожидали → что случилось; телефон или компьютер', hint: 'Найдёт причину и предложит исправление.' },
  pr: { name: 'Правки PR', ph: 'Что поправить — или оставьте пустым: бот прочитает ревью и проверки', hint: '' },
  queue: { name: 'Очередь', hint: 'Несколько независимых задач — каждая свой PR. Отмечайте по порядку.', more: true },
  chain: { name: 'Цепочка', hint: 'Каждая следующая строится поверх предыдущей. Порядок важен.', more: true },
  triage: { name: 'Разобрать issue', hint: 'Проверит новые issue, уточнит, поставит метки и размер.', more: true },
  tickets: { name: 'Нарезать', ph: 'Необязательно: какую спецификацию или issue разбить', hint: 'Разобьёт план на небольшие issue с зависимостями.', more: true },
}

const savedMode = ls.get('bot:mode') as Mode | null
export const store = reactive({
  ready: false,
  runs: [] as any[],
  current: null as string | null,
  limits: {} as Record<string, any>,
  codexLimits: null as any,
  today: {} as any,
  botDir: '',
  botName: 'bot',
  repos: [] as string[],
  curRepo: '',
  cfg: {} as any,
  gh: { issues: [] as any[], prs: [] as any[] },
  codexInfo: null as null | { models: any[]; login: { ok: boolean; text: string }; limits: any },
  repoDirty: '',
  selected: null as string | null,
  // строка ввода
  compose: { mode: (savedMode && MODES[savedMode] ? savedMode : 'task') as Mode, draft: '', picked: [] as number[], showMore: false, focusTick: 0, prPick: '' },
  // окна
  drawer: null as null | 'main' | 'memory',
  palette: false,
  sbOpen: false,
  toast: '',
})
store.compose.showMore = !!MODES[store.compose.mode].more

export const selectedRun = computed(() => store.runs.find((r) => r.id === store.selected) || null)
// ИИ, который сейчас на экране: у открытой задачи — её, иначе — по умолчанию
export const shownAi = computed<Ai>(() => (selectedRun.value ? (selectedRun.value.ai === 'codex' ? 'codex' : 'claude') : store.cfg.ai === 'codex' ? 'codex' : 'claude'))
watch(shownAi, (ai) => { document.documentElement.dataset.ai = ai }, { immediate: true })

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(t: string) { store.toast = t; clearTimeout(toastTimer); toastTimer = setTimeout(() => { store.toast = '' }, 2200) }

// ---------- навигация ----------
function readHash() { const h = location.hash.slice(1); store.selected = h && store.runs.some((r) => r.id === h) ? h : null }
window.addEventListener('popstate', readHash)
export function select(id: string) { store.selected = id; store.sbOpen = false; history.pushState(null, '', '#' + id) }
export function goHome() { store.selected = null; history.pushState(null, '', '#') }
export function newTask(mode: Mode = 'task', text?: string) {
  store.sbOpen = false
  if (text !== undefined) store.compose.draft = text
  setMode(mode)
  if (store.selected) goHome()
  store.compose.focusTick++
}
export function setMode(m: Mode) {
  store.compose.mode = m; store.compose.picked = []
  if (MODES[m].more) store.compose.showMore = true
  ls.set('bot:mode', m)
}

// ---------- действия ----------
export async function startJob(b: Record<string, any>) {
  const { ids } = await api<{ ids: string[] }>('/api/jobs', { repo: store.curRepo, ...b })
  store.compose.draft = ''; store.compose.picked = []
  select(ids[0])
}
export async function setAi(ai: Ai) {
  if (ai === store.cfg.ai) return
  store.cfg.ai = ai
  try { await api('/api/settings', { ai }); toast('По умолчанию — ' + aiName(ai)) } catch (e: any) { toast(e.message) }
}
export async function saveSetting(k: string, v: unknown) {
  try { await api('/api/settings', { [k]: v }); store.cfg[k] = v; toast('Сохранено') } catch (e: any) { toast(e.message) }
}
export async function loadGh(fresh = false) {
  if (!store.curRepo) return
  try { store.gh = await api(`/api/github?repo=${encodeURIComponent(store.curRepo)}${fresh ? '&fresh' : ''}`) } catch { /* GitHub недоступен */ }
}
export async function loadCodex() { try { store.codexInfo = await api('/api/codex') } catch { /* нет codex */ } }
export async function checkRepo() {
  try {
    const r = await api<{ status: string; busy: boolean }>(`/api/repo-status?repo=${encodeURIComponent(store.curRepo)}`)
    store.repoDirty = r.status && !r.busy ? r.status : ''
  } catch { store.repoDirty = '' }
}
export async function resetRepo() { await api('/api/reset', { repo: store.curRepo }); checkRepo() }
export async function checkLimits() {
  try { if (shownAi.value === 'codex') await api('/api/codex/limits', {}); else await api('/api/limits/check', {}); toast('Лимиты обновлены') } catch { /* молча */ }
}
export async function runAction(id: string, act: string) {
  try { await api(`/api/runs/${id}/${act}`, {}); if (act === 'delete') goHome(); if (act === 'continue') select(id) } catch (e: any) { toast(e.message) }
}
export async function reply(id: string, text: string) { await api(`/api/runs/${id}/reply`, { text }) }
export function setRepo(r: string) {
  store.curRepo = r; ls.set('bot:repo', r); store.gh = { issues: [], prs: [] }
  loadGh(); checkRepo()
}

// ---------- старт и живое состояние ----------
export async function init() {
  const [s, st] = await Promise.all([api('/api/state'), api('/api/settings').catch(() => ({ config: {} }))])
  Object.assign(store, { runs: s.runs, current: s.current, limits: s.limits || {}, codexLimits: s.codexLimits, today: s.today || {}, botDir: s.botDir, botName: s.botName || 'bot', cfg: st.config || {} })
  store.repos = s.repos?.length ? s.repos : [s.repo].filter(Boolean)
  const saved = ls.get('bot:repo')
  store.curRepo = store.repos.includes(saved!) ? saved! : store.repos.includes(s.repo) ? s.repo : store.repos[0] || ''
  readHash()
  store.ready = true
  loadGh(); checkRepo(); loadCodex()
  const live = new EventSource('/api/events')
  live.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.type !== 'state') return
    const wasBusy = !!store.current
    Object.assign(store, { runs: d.runs, current: d.current, limits: d.limits || {}, codexLimits: d.codexLimits, today: d.today || {} })
    if (wasBusy && !d.current) { checkRepo(); loadGh(true) }
  }
}
