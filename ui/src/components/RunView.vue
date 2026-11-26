<script setup lang="ts">
import type { FeedItem } from '../lib/feed'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, triggerRef } from 'vue'
import { buildFeed } from '../lib/feed'
import { aiName, md, modKey, money, runTok, STATUS, tok, until } from '../lib/format'
import { goHome, reply, resetRepo, runAction, selectedRun, store, toast } from '../lib/store'
import FeatureBoard from './FeatureBoard.vue'
import Icon from './Icon.vue'
import PrSummary from './PrSummary.vue'
import RunSchema from './RunSchema.vue'
import { ls } from '../lib/api'
import AttachList from './AttachList.vue'
import { useAttach } from '../lib/upload'

const r = selectedRun
const events = shallowRef<any[]>([])
let es: EventSource | null = null
let replaying = true
const scroller = () => document.getElementById('scroll')
function nearBottom() { const s = scroller(); return !s || s.scrollTop + s.clientHeight > s.scrollHeight - 160 }
function toBottom() {
  const s = scroller(); if (s)
    s.scrollTop = s.scrollHeight
}

onMounted(() => {
  es = new EventSource(`/api/events?run=${store.selected}`)
  es.onmessage = async (m) => {
    const d = JSON.parse(m.data)
    if (d.type === 'replayed') { replaying = false; triggerRef(events); await nextTick(); toBottom(); return }
    if (d.type !== 'event')
      return
    events.value.push(d.ev)
    if (replaying)
      return
    const stick = nearBottom()
    triggerRef(events)
    if (stick) { await nextTick(); toBottom() }
  }
})
onBeforeUnmount(() => es?.close())

// путь внутри рабочей копии бота — короче
function short(p: string) {
  p = String(p || ''); const d = store.botDir
  for (const k of ['/work/', '/refs/']) {
    if (d && p.startsWith(d + k))
      return p.slice(d.length + k.length).replace(/^[^/]+\//, '')
  }
  return p
}
const feed = computed(() => buildFeed(events.value, short))
// Вкладки: лента или схема (запоминаем выбор)
const tab = ref<'feed' | 'schema'>(ls.get('bot:tab') === 'schema' ? 'schema' : 'feed')
function setTab(t: 'feed' | 'schema') { tab.value = t; ls.set('bot:tab', t) }
// из схемы — к месту в ленте: первый пункт ленты с этим или следующим событием, с подсветкой
async function jump(ei: number) {
  setTab('feed')
  await nextTick()
  const el = [...document.querySelectorAll<HTMLElement>('.feed [data-ei]')].find(x => Number(x.dataset.ei) >= ei)
  if (!el)
    return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
}
const ai = computed(() => (r.value?.ai === 'codex'
  ? 'codex'
  : 'claude'))
// шапка «bot · Claude» перед первой репликой бота после реплики человека
function showWho(i: number) {
  const it = feed.value.items[i]
  if (!isBot(it))
    return false; for (let j = i - 1; j >= 0; j--) {
    const p = feed.value.items[j]; if (p.k === 'note')
      continue
    return !isBot(p)
  } return true
}
function isBot(it: FeedItem) {
  return it.k === 'tool' || it.k === 'choice' || it.k === 'result' || ((it.k === 'msg' || it.k === 'files') && it.who === 'bot')
}

// ---------- вопросы с вариантами ----------
const picks = reactive<Record<string, number[]>>({})
const openChoices = computed(
  () => feed.value.items.filter((it): it is Extract<FeedItem, { k: 'choice' }> => it.k === 'choice' && !it.answered),
)
const canAnswer = computed(() => r.value && !['running', 'queued'].includes(r.value.status))
const answerText = ref('')
const at = useAttach()
const replyFile = ref<HTMLInputElement>()
// Любой вопрос — можно выбрать несколько: клик/1–9 отмечает, «Ответить»/↵ отправляет; двойной клик — сразу только этот
const curQ = ref('') // вопрос, в котором отмечали последним (для клавиш)
function pick(it: Extract<FeedItem, { k: 'choice' }>, i: number) {
  if (it.answered || !canAnswer.value)
    return
  const cur = picks[it.key] || []
  picks[it.key] = cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i]
  curQ.value = it.key
}
function pickOnly(it: Extract<FeedItem, { k: 'choice' }>, i: number) {
  if (it.answered || !canAnswer.value)
    return
  picks[it.key] = [i]
  sendChoices()
}
async function sendChoices() {
  const open = openChoices.value
  if (!open.length)
    return
  if (open.some(c => !picks[c.key]?.length))
    return toast('Отметьте вариант в каждом вопросе')
  const parts = open.map((c) => {
    const labels = [...picks[c.key]].sort().map(i => cleanLabel(c.q.options[i].label))
    return open.length > 1
      ? `${c.q.question} — ${labels.join(', ')}`
      : labels.join(', ')
  })
  const extra = answerText.value.trim()
  try {
    await reply(r.value!.id, extra
      ? `${parts.join('\n')}\n\n${extra}`
      : parts.join('\n')); answerText.value = ''
  }
  catch (e: any) { toast(e.message) }
}
const cleanLabel = (l: string) => l.replace(/\s*\((рекомендую|рекомендуется|recommended)\)/i, '')
const isRec = (l: string) => /рекоменд|recommend/i.test(l)
function isPicked(it: Extract<FeedItem, { k: 'choice' }>, i: number) {
  return it.answered
    ? !!it.answer?.includes(cleanLabel(it.q.options[i].label))
    : !!picks[it.key]?.includes(i)
}
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.closest('textarea, input, select, dialog') || e.metaKey || e.ctrlKey || e.altKey)
    return
  if (e.key === 'Enter' && openChoices.value.some(c => picks[c.key]?.length)) {
    e.preventDefault(); sendChoices(); return
  }
  const n = Number(e.key); if (!n)
    return
  const c = openChoices.value.find(x => x.key === curQ.value) || openChoices.value.find(x => !picks[x.key]?.length) || openChoices.value[openChoices.value.length - 1]
  if (c && c.q.options[n - 1])
    pick(c, n - 1)
}
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

// ---------- ответ ----------
const canReply = computed(() => r.value?.sessionId && ['waiting', 'done', 'failed'].includes(r.value.status) && !['issue', 'pr'].includes(r.value.kind))
async function send() {
  const text = answerText.value.trim()
  if (at.busy.value)
    return toast('Файлы ещё загружаются')
  if (!text && !at.atts.value.length)
    return
  if (openChoices.value.some(c => picks[c.key]?.length))
    return sendChoices()
  try {
    await reply(r.value!.id, text, at.paths()); answerText.value = ''; at.clear()
  }
  catch (e: any) { toast(e.message) }
}
function onReplyKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
}

// ---------- сведения ----------
const t = computed(() => runTok(r.value || {}))
const pct = computed(() => (r.value?.ctx
  ? Math.round(r.value.ctx / (r.value.ctxMax || 200000) * 100)
  : 0))
const dur = computed(() => (r.value?.startedAt
  ? Math.max(1, Math.round(((r.value.endedAt || Date.now()) - r.value.startedAt) / 60000))
  : 0))
const modelName = computed(() => String(r.value?.modelUsed || r.value?.model || '')
  .replace(/^codex( · )?/, '')
  .replace(/^claude-/, ''))
const acts = computed(() => {
  const x = r.value; if (!x)
    return []
  const a: [string, string, boolean?][] = []
  if (['failed', 'stopped', 'limited'].includes(x.status) && x.sessionId) {
    a.push([
      'continue',
      x.status === 'limited'
        ? 'Продолжить сейчас'
        : 'Продолжить',
      true,
    ])
  }
  if ([
    'failed',
    'stopped',
    'skipped',
    'limited',
  ].includes(x.status)) {
    a.push(['retry', 'Заново'])
  }
  if (['running', 'queued'].includes(x.status))
    a.push(['stop', 'Остановить'])
  if (x.status === 'waiting')
    a.push(['close', 'Завершить разговор'])
  return a
})
const dirty = computed(() => r.value?.status === 'failed' && /несохранённые правки/.test(r.value.reason || ''))
async function discardAndRetry() {
  if (!confirm('Отбросить несохранённые правки в копии бота и запустить задачу заново? Ваша рабочая папка не затрагивается.'))
    return
  await resetRepo(); runAction(r.value!.id, 'retry')
}
function act(a: string) {
  if (a === 'delete' && !confirm('Убрать запуск из истории?'))
    return; runAction(r.value!.id, a)
}
</script>

<template>
  <div
    v-if="r"
    class="rv"
  >
    <div class="col">
      <header class="head">
        <div class="title">
          <button
            class="btn ghost icon"
            title="Назад (Esc)"
            @click="goHome"
          >
            <icon name="back" />
          </button>
          <h2>{{ r.title }}</h2>
          <span
            v-if="r.auto"
            class="badge"
            :title="`Поставлено авторабой: ${r.auto}`"
          >авто</span>
          <span
            class="badge"
            :class="r.status"
          >{{ STATUS[r.status] || r.status }}</span>
        </div>
        <div class="acts narrow">
          <a
            v-if="r.prUrl"
            class="btn sm"
            :href="r.prUrl"
            target="_blank"
          >PR ↗</a>
          <button
            v-for="[a, l, p] in acts"
            :key="a"
            class="btn sm"
            :class="{ primary: p }"
            @click="act(a)"
          >
            {{ l }}
          </button>
        </div>
        <div
          v-if="r.reason"
          class="why"
          :class="{ limited: r.status === 'limited' }"
        >
          {{ r.reason }}<template v-if="r.status === 'limited' && r.resumeAt">
            Осталось {{ until(r.resumeAt).replace('через ', '') }}.
          </template>
          <button
            v-if="dirty"
            class="btn sm"
            @click="discardAndRetry"
          >
            Отбросить правки и повторить
          </button>
        </div>
        <div
          v-else-if="r.note"
          class="why ok"
        >
          {{ r.note }}
        </div>
        <div class="seg tabs">
          <button
            :class="{ on: tab === 'feed' }"
            @click="setTab('feed')"
          >
            Лента
          </button>
          <button
            :class="{ on: tab === 'schema' }"
            @click="setTab('schema')"
          >
            Схема
          </button>
        </div>
      </header>

      <feature-board
        v-if="r.kind === 'feature'"
        :run="r"
      />
      <run-schema
        v-if="tab === 'schema'"
        :events="events"
        :n="events.length"
        :short="short"
        :live="r.status === 'running'"
        @jump="jump"
      />
      <div
        v-else
        class="feed"
      >
        <template
          v-for="(it, i) in feed.items"
          :key="it.key"
        >
          <div
            v-if="showWho(i)"
            class="who"
          >
            <span class="av"><icon
              name="bot"
              :size="14"
            /></span>bot <span class="muted">· {{ aiName(ai) }}</span>
          </div>
          <div
            v-if="it.k === 'msg'"
            :data-ei="it.ei"
            class="msg"
            :class="{ user: it.who === 'user' }"
            v-html="md(it.text)"
          />
          <div
            v-else-if="it.k === 'companion'"
            :data-ei="it.ei"
            class="msg"
          >
            <div class="who">
              Мини-агент <span class="muted">· {{ it.mood }}</span>
            </div>
            {{ it.text }}
          </div>
          <div
            v-else-if="it.k === 'tool'"
            :data-ei="it.ei"
            class="tool"
            :class="{ error: it.error }"
          >
            <span class="ic">{{ it.icon }}</span>
            <div class="what">
              <span v-html="it.html" />
              <ul
                v-if="it.todos"
                class="todos"
              >
                <li
                  v-for="(td, j) in it.todos"
                  :key="j"
                  :class="td.status"
                >
                  {{ td.content }}
                </li>
              </ul>
              <details
                v-if="it.out"
                :open="it.error"
              >
                <summary>{{ it.error ? 'ошибка' : 'вывод' }}</summary><pre>{{ it.out }}</pre>
              </details>
            </div>
          </div>
          <div
            v-else-if="it.k === 'choice'"
            :data-ei="it.ei"
            class="choice"
            :class="{ answered: it.answered }"
          >
            <div
              class="q"
              v-html="md(it.q.question).replace(/^<p>|<\/p>$/g, '')"
            />
            <div class="opts">
              <button
                v-for="(o, j) in it.q.options"
                :key="j"
                type="button"
                class="opt"
                :class="{ on: isPicked(it, j) }"
                :disabled="it.answered"
                @click="pick(it, j)"
                @dblclick="pickOnly(it, j)"
              >
                <span class="k">{{ isPicked(it, j) ? '✓' : j + 1 }}</span>
                <span class="l">{{ cleanLabel(o.label) }}<span
                  v-if="isRec(o.label)"
                  class="rec"
                >рекомендую</span></span>
                <span
                  v-if="o.description"
                  class="d"
                >{{ o.description }}</span>
              </button>
            </div>
            <div
              v-if="!it.answered"
              class="foot"
            >
              Можно несколько: 1–9 — отметить, ↵ — ответить, двойной клик — сразу этот · или своими словами<span class="spacer" />
              <button
                type="button"
                class="btn primary sm"
                :disabled="!picks[it.key]?.length || !canAnswer"
                @click="sendChoices"
              >
                Ответить
              </button>
            </div>
          </div>
          <attach-list
            v-else-if="it.k === 'files'"
            :data-ei="it.ei"
            class="msg-files"
            :class="{ bot: it.who === 'bot' }"
            :files="it.files"
          />
          <div
            v-else-if="it.k === 'note'"
            :data-ei="it.ei"
            class="note"
          >
            {{ it.text }}
          </div>
          <div
            v-else-if="it.k === 'result'"
            :data-ei="it.ei"
            class="result"
            :class="{ bad: it.bad }"
            v-html="it.html"
          />
        </template>
      </div>

      <pr-summary
        v-if="r.prUrl || (r.kind === 'pr' && r.pr)"
        :key="r.id"
        :run="r"
      />

      <div class="dock">
        <div
          v-if="r.status === 'running'"
          class="typing"
        >
          <span class="st running" />Работает — можно закрыть вкладку
        </div>
        <form
          v-else-if="canReply"
          class="reply"
          @submit.prevent="send"
          @paste="at.onPaste"
          @dragover.prevent
          @drop="at.onDrop"
        >
          <attach-list
            class="reply-files"
            :files="at.atts.value"
            :busy="at.busy.value"
            removable
            @remove="at.remove"
          />
          <button
            type="button"
            class="btn ghost icon"
            title="Приложить картинку или файл (можно вставить ⌘V)"
            @click="replyFile?.click()"
          >
            <icon
              name="clip"
              :size="16"
            />
          </button>
          <input
            ref="replyFile"
            type="file"
            multiple
            hidden
            @change="at.add(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''"
          >
          <textarea
            v-model="answerText"
            rows="1"
            :placeholder="`Ответ…  ${modKey}↵ — отправить`"
            @keydown="onReplyKey"
          />
          <button class="btn primary">
            Ответить
          </button>
        </form>
      </div>
    </div>

    <aside class="side">
      <div class="card">
        <dl class="kv">
          <dt>ИИ</dt><dd>
            {{ aiName(ai) }}<template v-if="modelName">
              · {{ modelName }}
            </template>
          </dd>
          <template v-if="r.repo">
            <dt>Репозиторий</dt><dd :title="r.repo">
              {{ r.repo.split('/')[1] }}
            </dd>
          </template>
          <template v-if="r.branch">
            <dt>Ветка</dt><dd :title="r.branch">
              {{ r.branch }}
            </dd>
          </template>
          <template v-if="r.prUrl">
            <dt>PR</dt><dd>
              <a
                :href="r.prUrl"
                target="_blank"
              >#{{ r.prUrl.split('/').pop() }} ↗</a>
            </dd>
          </template>
          <template v-if="t.in || t.out">
            <dt>Токены</dt><dd :title="`Вход ${t.in.toLocaleString('ru')} · выход ${t.out.toLocaleString('ru')}`">
              {{ tok(t.in + t.out) }}
            </dd>
          </template>
          <template v-if="r.cost">
            <dt>Стоимость</dt><dd>{{ money(r.cost) }}</dd>
          </template>
          <template v-if="dur">
            <dt>Время</dt><dd>{{ dur }} мин</dd>
          </template>
        </dl>
        <div v-if="pct">
          <dl class="kv">
            <dt>Контекст</dt><dd>{{ pct }}%</dd>
          </dl>
          <div
            class="ctxbar"
            :class="{ warn: pct > 70 }"
          >
            <i :style="{ width: `${Math.min(100, pct)}%` }" />
          </div>
        </div>
        <div
          v-if="acts.length || r.status !== 'running'"
          class="side-acts"
        >
          <button
            v-for="[a, l, p] in acts"
            :key="a"
            class="btn sm"
            :class="{ primary: p }"
            @click="act(a)"
          >
            {{ l }}
          </button>
          <button
            v-if="r.status !== 'running'"
            class="btn ghost sm"
            @click="act('delete')"
          >
            Убрать из истории
          </button>
        </div>
      </div>
      <div class="card">
        <h4>План</h4>
        <ul
          v-if="feed.todos?.length"
          class="todos"
        >
          <li
            v-for="(td, j) in feed.todos"
            :key="j"
            :class="td.status"
          >
            {{ td.content }}
          </li>
        </ul>
        <div
          v-else
          class="small"
        >
          Появится, когда бот его составит
        </div>
      </div>
      <div class="card">
        <h4>
          Изменённые файлы<template v-if="feed.files.length">
            · {{ feed.files.length }}
          </template>
        </h4>
        <ul
          v-if="feed.files.length"
          class="files"
        >
          <li
            v-for="f in feed.files"
            :key="f"
            :title="f"
          >
            &lrm;{{ f }}
          </li>
        </ul>
        <div
          v-else
          class="small"
        >
          Пока ничего
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped lang="scss">
.rv {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 290px;
  gap: 32px;
  width: min(1160px, calc(100% - 40px));
  margin: 0 auto;
  align-items: start;
}
.col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 52px);
}
.head {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg);
  padding: 6px 0 12px;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 8px;
  transition: background 0.25s;
}
.title {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  h2 {
    margin: 2px 0 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.01em;
    flex: 1;
    min-width: 0;
  }
  .badge {
    margin-top: 3px;
  }
}
.acts {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.narrow {
  display: none;
}
.why .btn {
  display: flex;
  margin-top: 8px;
}
.why {
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--bad-soft);
  color: var(--bad);
  font-size: 13px;
  &.limited {
    background: var(--warn-soft);
    color: var(--warn);
  }
  &.ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
}

.feed {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 18px 0 24px;
}
.who {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  margin-top: 10px;
}
.av {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  background: var(--accent);
  color: var(--on-accent);
  :deep(.icon) {
    stroke-width: 2.2;
  }
}
.msg {
  max-width: 700px;
  padding-left: 30px;
  :deep(p) {
    margin: 0 0 8px;
    &:last-child {
      margin: 0;
    }
  }
  &.user {
    align-self: flex-end;
    background: var(--card);
    border: 1px solid var(--line);
    padding: 9px 14px;
    border-radius: 14px;
    margin-top: 10px;
  }
}
.tool {
  display: flex;
  gap: 8px;
  align-items: baseline;
  color: var(--muted);
  font-size: 13px;
  padding-left: 32px;
  .ic {
    width: 14px;
    text-align: center;
    flex: none;
    font-size: 12px;
  }
  .what {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  :deep(code) {
    background: transparent;
    padding: 0;
    color: var(--text);
    opacity: 0.85;
  }
  summary {
    cursor: pointer;
    font-size: 12px;
  }
  &.error .what {
    color: var(--bad);
  }
}
.note {
  align-self: center;
  font-size: 12px;
  color: var(--muted);
  margin: 4px 0;
}
.result {
  margin-left: 30px;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--ok-soft);
  color: var(--ok);
  :deep(a) {
    color: inherit;
    font-weight: 600;
  }
  &.bad {
    background: var(--bad-soft);
    color: var(--bad);
  }
}
.todos {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: grid;
  gap: 3px;
  li::before {
    content: '○ ';
  }
  li.completed {
    opacity: 0.6;
    text-decoration: line-through;
    &::before {
      content: '● ';
      color: var(--ok);
    }
  }
  li.in_progress {
    color: var(--text);
    &::before {
      content: '◐ ';
      color: var(--accent);
    }
  }
}
.choice {
  margin-left: 30px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 14px;
  max-width: 670px;
  display: grid;
  gap: 10px;
  box-shadow: var(--shadow);
  .q {
    font-weight: 600;
  }
  .opts {
    display: grid;
    gap: 6px;
  }
  .opt {
    text-align: left;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 1px 10px;
    padding: 9px 11px;
    border-radius: 10px;
    border: 1px solid var(--line);
    transition: 0.12s;
    &:hover:not(:disabled) {
      border-color: var(--accent);
    }
    .k {
      grid-row: span 2;
      width: 20px;
      height: 20px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      font-size: 11.5px;
      font-weight: 600;
      background: var(--sunk);
      color: var(--muted);
      margin-top: 1px;
    }
    .l {
      font-weight: 500;
    }
    .rec {
      margin-left: 6px;
      font-size: 11.5px;
      color: var(--accent-text);
      font-weight: 500;
    }
    .d {
      grid-column: 2;
      color: var(--muted);
      font-size: 12.5px;
    }
    &.on {
      border-color: var(--accent);
      background: var(--accent-soft);
      .k {
        background: var(--accent);
        color: var(--on-accent);
      }
    }
  }
  .foot {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
  }
  &.answered {
    box-shadow: none;
    .opt {
      cursor: default;
      &:not(.on) {
        opacity: 0.4;
      }
    }
  }
}
.dock {
  position: sticky;
  bottom: 0;
  padding: 10px 0 18px;
  background: linear-gradient(transparent, var(--bg) 30%);
}
.typing {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
}
.reply {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: var(--shadow);
  padding: 8px;
  &:focus-within {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  }
  // поле — той же высоты, что кнопки (34 px), текст по центру; растёт вверх, кнопки остаются внизу
  textarea {
    background: transparent;
    border: 0;
    box-sizing: border-box;
    min-height: 34px;
    height: 34px;
    padding: 8px 4px;
    line-height: 18px;
    resize: none;
    &:focus {
      border: 0;
    }
  }
}

.side {
  position: sticky;
  top: 8px;
  display: grid;
  gap: 12px;
  max-height: calc(100vh - 70px);
  overflow: auto;
  padding: 6px 0 12px;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px;
  display: grid;
  gap: 10px;
  h4 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  .todos {
    font-size: 13px;
  }
}
.kv {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px 12px;
  font-size: 13px;
  margin: 0;
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  a {
    color: var(--accent-text);
    font-weight: 500;
    text-decoration: none;
  }
}
.ctxbar {
  margin-top: 5px;
  height: 4px;
  border-radius: 9px;
  background: var(--sunk);
  overflow: hidden;
  i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  &.warn i {
    background: var(--warn);
  }
}
.side-acts {
  display: grid;
  gap: 6px;
  .btn {
    width: 100%;
  }
}
.files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  li {
    font-family: var(--mono);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
}

@media (max-width: 1180px) {
  .rv {
    grid-template-columns: minmax(0, 1fr);
    width: min(760px, calc(100% - 32px));
  }
  .side {
    display: none;
  }
  .narrow {
    display: flex;
  }
}
@media (max-width: 820px) {
  .msg,
  .tool,
  .result,
  .choice {
    padding-left: 0;
    margin-left: 0;
  }
}
.tabs {
  justify-self: start;
  margin-top: 10px;
}
// подсветка пункта, к которому перешли из схемы
:deep(.flash) {
  animation: flash 1.6s ease-out;
}
@keyframes flash {
  0%, 30% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 10px; }
  100% { box-shadow: 0 0 0 3px transparent; }
}
// вложения: в ответе — строкой над полем, в ленте — справа, как реплика человека
.reply-files {
  flex-basis: 100%;
}
.reply textarea {
  flex: 1;
}
.msg-files {
  justify-self: end;
  align-self: flex-end;
  justify-content: flex-end;
  max-width: 80%;
  &.bot { // файлы от бота — слева, крупнее
    justify-self: start;
    align-self: flex-start;
    justify-content: flex-start;
    :deep(.att.img) {
      width: 180px;
      height: 180px;
    }
  }
}
</style>
