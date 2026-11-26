<script setup lang="ts">
// Мини-доска «Разработки фичи»: шаги, заметки, стрелки зависимостей и предложения бота.
// Доска живёт на сервере (run.board, логика — featurePlan.mjs); здесь — показ и действия через /api/runs/:id/board.
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { api } from '../lib/api'
import { toast } from '../lib/store'

interface Item { id: string, type: 'step' | 'note', title: string, text: string, x: number, y: number, by: 'bot' | 'user' }
interface Sug { id: string, kind: 'add' | 'edit' | 'remove' | 'link' | 'unlink', item?: Item, target?: string, title?: string, text?: string, from?: string, to?: string }
interface Board { rev: number, items: Item[], links: { from: string, to: string }[], suggestions: Sug[] }

const props = defineProps<{ run: any }>()
const W = 220 // ширина карточки
const HEAD = 24 // высота, на которой в карточку входят стрелки

const local = ref<Board | null>(null) // ответ сервера на своё действие — до прихода общего состояния
const board = computed<Board>(() => {
  const srv: Board = props.run.board || {
    rev: 0,
    items: [],
    links: [],
    suggestions: [],
  }
  return local.value && local.value.rev > srv.rev
    ? local.value
    : srv
})
const locked = computed(() => !!props.run.planApproved)
const thinking = computed(() => ['running', 'queued'].includes(props.run.status))
const canAsk = computed(() => !!props.run.sessionId && !thinking.value && !locked.value)
const steps = computed(() => board.value.items.filter(i => i.type === 'step').length)

async function op(body: Record<string, any>) {
  try {
    const r = await api<{ board: Board, id?: string }>(`/api/runs/${props.run.id}/board`, body)
    local.value = r.board
    return r.id
  }
  catch (e: any) { toast(e.message) }
}

// ---------- карточки и стрелки ----------
const drag = reactive<{ id: string, x: number, y: number, dx: number, dy: number, moved: boolean }>({
  id: '',
  x: 0,
  y: 0,
  dx: 0,
  dy: 0,
  moved: false,
})
const wire = reactive({ from: '', x: 0, y: 0 }) // тянем новую стрелку
function posOf(it: Item) {
  return drag.id === it.id
    ? { x: drag.x, y: drag.y }
    : { x: it.x, y: it.y }
}
const sugFor = computed(() => {
  const m = new Map<string, Sug>()
  for (const s of board.value.suggestions) {
    if (s.target)
      m.set(s.target, s)
  }
  return m
})
const cards = computed(() => [
  ...board.value.items.map(it => ({ it, add: null as Sug | null })),
  ...board.value.suggestions.filter(s => s.kind === 'add').map(s => ({ it: s.item!, add: s })),
])
const where = computed(() => new Map(cards.value.map(c => [
  c.it.id,
  posOf(c.it),
])))
function curve(a: { x: number, y: number }, b: { x: number, y: number }) {
  const sx = a.x + W; const sy = a.y + HEAD; const ex = b.x; const ey = b.y + HEAD
  const d = Math.max(40, Math.abs(ex - sx) / 2)
  return { d: `M${sx} ${sy} C${sx + d} ${sy}, ${ex - d} ${ey}, ${ex} ${ey}`, mx: (sx + ex) / 2, my: (sy + ey) / 2 }
}
const arrows = computed(() => {
  const out: { key: string, d: string, mx: number, my: number, from: string, to: string, sug?: Sug, off?: boolean }[] = []
  const unlink = new Map(board.value.suggestions.filter(s => s.kind === 'unlink').map(s => [`${s.from}>${s.to}`, s]))
  const add = (from: string, to: string, sug?: Sug) => {
    const a = where.value.get(from); const b = where.value.get(to)
    if (a && b) {
      out.push({
        key: `${sug?.id || 'l'}:${from}>${to}`,
        ...curve(a, b),
        from,
        to,
        sug,
        off: sug?.kind === 'unlink',
      })
    }
  }
  for (const l of board.value.links) add(l.from, l.to, unlink.get(`${l.from}>${l.to}`))
  for (const s of board.value.suggestions.filter(x => x.kind === 'link')) add(s.from!, s.to!, s)
  return out
})
const size = computed(() => {
  const ps = [
    ...where.value.values(),
  ]
  return {
    w: Math.max(...ps.map(p => p.x + W + 60), 600),
    h: Math.max(...ps.map(p => p.y + 200), 320),
  }
})
const wirePath = computed(() => {
  const a = where.value.get(wire.from)
  return a
    ? curve(a, { x: wire.x, y: wire.y - HEAD }).d
    : ''
})

const canvas = ref<HTMLElement>()
function at(e: PointerEvent) {
  const r = canvas.value!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
function startMove(e: PointerEvent, it: Item) {
  if (locked.value || (e.target as HTMLElement).closest('button, input, textarea') || e.button !== 0)
    return
  const p = at(e)
  Object.assign(drag, {
    id: it.id,
    x: it.x,
    y: it.y,
    dx: p.x - it.x,
    dy: p.y - it.y,
    moved: false,
  })
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', endMove, { once: true })
}
function onMove(e: PointerEvent) {
  const p = at(e)
  if (wire.from) { wire.x = p.x; wire.y = p.y; return }
  drag.x = Math.max(0, Math.round(p.x - drag.dx)); drag.y = Math.max(0, Math.round(p.y - drag.dy)); drag.moved = true
}
async function endMove() {
  window.removeEventListener('pointermove', onMove)
  const { id, x, y, moved } = drag
  if (moved)
    await op({ op: 'move', id, x, y })
  drag.id = ''
}
function startWire(e: PointerEvent, it: Item) {
  const p = at(e)
  Object.assign(wire, { from: it.id, x: p.x, y: p.y })
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', endWire, { once: true })
}
async function endWire(e: PointerEvent) {
  window.removeEventListener('pointermove', onMove)
  const from = wire.from
  wire.from = ''
  const to = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-step]')?.dataset.step
  if (to && to !== from)
    await op({ op: 'link', from, to })
}
onBeforeUnmount(() => window.removeEventListener('pointermove', onMove))

// ---------- правка и вопросы боту ----------
const edit = reactive({ id: '', title: '', text: '' })
const ask = reactive({ id: '', text: '', busy: false })
function startEdit(it: Item) {
  Object.assign(edit, { id: it.id, title: it.title, text: it.text })
  ask.id = ''
}
async function saveEdit() {
  await op({
    op: 'edit',
    id: edit.id,
    title: edit.title,
    text: edit.text,
  })
  edit.id = ''
}
async function addItem(type: 'step' | 'note') {
  const el = canvas.value?.parentElement
  const id = await op({
    op: 'add',
    type,
    title: type === 'step'
      ? 'Новый шаг'
      : '',
    text: type === 'note'
      ? 'Заметка'
      : '',
    ...(el
      ? { x: el.scrollLeft + 40, y: el.scrollTop + 40 }
      : {}),
  })
  const it = id && board.value.items.find(i => i.id === id)
  if (it)
    startEdit(it)
}
function remove(it: Item) {
  // eslint-disable-next-line no-alert -- простое подтверждение, как в настройках скиллов
  if (confirm(`Удалить «${it.title || it.text.slice(0, 40)}»?`))
    op({ op: 'remove', id: it.id })
}
async function sendAsk() {
  if (!ask.text.trim())
    return
  ask.busy = true
  try {
    await api(`/api/runs/${props.run.id}/reply`, {
      text: ask.text.trim(),
      step: ask.id,
    })
    Object.assign(ask, { id: '', text: '' })
  }
  catch (e: any) { toast(e.message) }
  finally { ask.busy = false }
}

// ---------- утверждение ----------
const approving = ref(false)
const blocker = computed(() => locked.value
  ? ''
  : thinking.value
    ? 'Бот ещё работает над планом'
    : !props.run.sessionId
        ? 'Бот не начал работу'
        : !steps.value
            ? 'Добавьте хотя бы один шаг'
            : board.value.suggestions.length
              ? 'Сначала примите или отклоните предложения бота'
              : '')
async function approve() {
  approving.value = true
  try { await api(`/api/runs/${props.run.id}/approve`, {}) }
  catch (e: any) { toast(e.message) }
  finally { approving.value = false }
}
const SUG_TEXT: Record<string, string> = {
  add: 'Бот предлагает добавить',
  edit: 'Бот предлагает изменить',
  remove: 'Бот предлагает удалить',
  link: 'Новая зависимость',
  unlink: 'Убрать зависимость',
}
</script>

<template>
  <section class="fboard">
    <header>
      <b>План фичи</b>
      <span
        v-if="locked"
        class="tag ok"
      >утверждён — бот работает по нему</span>
      <span
        v-else
        class="small"
      >{{ steps }} шаг. · стрелка — «после» · карточки можно двигать</span>
      <span class="spacer" />
      <template v-if="!locked">
        <template v-if="board.suggestions.length">
          <span class="small sug-count">Предложений бота: {{ board.suggestions.length }}</span>
          <button
            class="btn ghost sm"
            @click="op({ op: 'acceptAll' })"
          >
            Принять все
          </button>
          <button
            class="btn ghost sm"
            @click="op({ op: 'rejectAll' })"
          >
            Отклонить все
          </button>
        </template>
        <button
          class="btn ghost sm"
          @click="addItem('step')"
        >
          + Шаг
        </button>
        <button
          class="btn ghost sm"
          @click="addItem('note')"
        >
          + Заметка
        </button>
      </template>
    </header>

    <div class="viewport">
      <div
        v-if="!cards.length"
        class="empty small"
      >
        {{ thinking ? 'Бот изучает код и строит план…' : 'Плана пока нет — добавьте шаги сами или попросите бота в ответе ниже.' }}
      </div>
      <div
        ref="canvas"
        class="canvas"
        :style="{ width: `${size.w}px`, height: `${size.h}px` }"
      >
        <svg
          :width="size.w"
          :height="size.h"
        >
          <defs>
            <marker
              id="fb-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path
                d="M0 0L10 5L0 10z"
                fill="context-stroke"
              />
            </marker>
          </defs>
          <g
            v-for="a in arrows"
            :key="a.key"
            class="arr"
            :class="{ sug: a.sug, off: a.off }"
          >
            <path
              :d="a.d"
              marker-end="url(#fb-arrow)"
            />
            <path
              v-if="!locked && !a.sug"
              class="hit"
              :d="a.d"
              @click="op({ op: 'unlink', from: a.from, to: a.to })"
            >
              <title>Убрать зависимость</title>
            </path>
          </g>
          <path
            v-if="wire.from"
            class="wire"
            :d="wirePath"
          />
        </svg>

        <div
          v-for="a in arrows.filter(x => x.sug && !locked)"
          :key="`chip${a.key}`"
          class="chip-sug"
          :style="{ left: `${a.mx}px`, top: `${a.my}px` }"
        >
          <span>{{ SUG_TEXT[a.sug!.kind] }}</span>
          <button
            title="Принять"
            @click="op({ op: 'accept', id: a.sug!.id })"
          >
            ✓
          </button>
          <button
            title="Отклонить"
            @click="op({ op: 'reject', id: a.sug!.id })"
          >
            ✕
          </button>
        </div>

        <div
          v-for="c in cards"
          :key="c.it.id"
          class="card"
          :class="[c.it.type, {
            ghost: c.add,
            del: sugFor.get(c.it.id)?.kind === 'remove',
            chg: sugFor.get(c.it.id)?.kind === 'edit',
            dragging: drag.id === c.it.id,
          }]"
          :data-step="c.it.type === 'step' && !c.add ? c.it.id : undefined"
          :style="{ left: `${posOf(c.it).x}px`, top: `${posOf(c.it).y}px`, width: `${W}px` }"
          @pointerdown="!c.add && startMove($event, c.it)"
        >
          <template v-if="edit.id === c.it.id">
            <input
              v-if="c.it.type === 'step'"
              v-model="edit.title"
              placeholder="Название шага"
              @keydown.enter.prevent="saveEdit"
            >
            <textarea
              v-model="edit.text"
              rows="3"
              :placeholder="c.it.type === 'step' ? 'Что сделать' : 'Заметка'"
              @keydown.enter.meta.prevent="saveEdit"
              @keydown.enter.ctrl.prevent="saveEdit"
            />
            <div class="row">
              <button
                class="btn primary sm"
                @click="saveEdit"
              >
                Сохранить
              </button>
              <button
                class="btn ghost sm"
                @click="edit.id = ''"
              >
                Отмена
              </button>
            </div>
          </template>
          <template v-else>
            <div class="head">
              <span class="kind">{{ c.it.type === 'step' ? 'шаг' : 'заметка' }}{{ c.it.by === 'user' ? ' · ваш' : '' }}</span>
              <span class="spacer" />
              <template v-if="!locked && !c.add">
                <button
                  title="Править"
                  @click="startEdit(c.it)"
                >
                  ✎
                </button>
                <button
                  v-if="c.it.type === 'step'"
                  title="Спросить бота про этот шаг"
                  :disabled="!canAsk"
                  @click="ask.id = ask.id === c.it.id ? '' : c.it.id; edit.id = ''"
                >
                  💬
                </button>
                <button
                  title="Удалить"
                  @click="remove(c.it)"
                >
                  ✕
                </button>
              </template>
            </div>
            <div
              v-if="c.it.title"
              class="title"
            >
              {{ c.it.title }}
            </div>
            <div
              v-if="c.it.text && c.it.text !== c.it.title"
              class="text"
            >
              {{ c.it.text }}
            </div>
          </template>

          <div
            v-if="!locked && (c.add || sugFor.get(c.it.id))"
            class="sug"
          >
            <div class="small">
              {{ SUG_TEXT[(c.add || sugFor.get(c.it.id))!.kind] }}
            </div>
            <template v-if="sugFor.get(c.it.id)?.kind === 'edit'">
              <div class="title">
                {{ sugFor.get(c.it.id)!.title }}
              </div>
              <div class="text">
                {{ sugFor.get(c.it.id)!.text }}
              </div>
            </template>
            <div class="row">
              <button
                class="btn primary sm"
                @click="op({ op: 'accept', id: (c.add || sugFor.get(c.it.id))!.id })"
              >
                Принять
              </button>
              <button
                class="btn ghost sm"
                @click="op({ op: 'reject', id: (c.add || sugFor.get(c.it.id))!.id })"
              >
                Отклонить
              </button>
            </div>
          </div>

          <form
            v-if="ask.id === c.it.id"
            class="ask"
            @submit.prevent="sendAsk"
          >
            <textarea
              v-model="ask.text"
              rows="2"
              placeholder="Вопрос или просьба боту про этот шаг"
              @keydown.enter.meta.prevent="sendAsk"
              @keydown.enter.ctrl.prevent="sendAsk"
            />
            <button
              class="btn primary sm"
              :disabled="ask.busy || !ask.text.trim()"
            >
              Отправить
            </button>
          </form>

          <span
            v-if="!locked && !c.add && c.it.type === 'step'"
            class="port"
            title="Потяните к другому шагу — он будет делаться после этого"
            @pointerdown.stop.prevent="startWire($event, c.it)"
          />
        </div>
      </div>
    </div>

    <footer v-if="!locked">
      <span class="small">{{ blocker || 'Бот получит исходную задачу и этот план. До нажатия код не меняется.' }}</span>
      <span class="spacer" />
      <button
        class="btn primary"
        :disabled="!!blocker || approving"
        @click="approve"
      >
        Начать работу
      </button>
    </footer>
  </section>
</template>

<style scoped lang="scss">
.fboard {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  margin: 12px 0;
  overflow: hidden;
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  flex-wrap: wrap;
  font-size: 13px;
}
header {
  border-bottom: 1px solid var(--line);
}
footer {
  border-top: 1px solid var(--line);
}
.spacer {
  flex: 1;
}
.sug-count {
  color: var(--accent-text);
}
.tag.ok {
  color: var(--ok);
  background: var(--ok-soft);
  border-radius: 6px;
  padding: 1px 6px;
}
.viewport {
  position: relative;
  height: 440px;
  overflow: auto;
  background: var(--sunk);
  background-image: radial-gradient(var(--line) 1px, transparent 1px);
  background-size: 18px 18px;
}
.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  text-align: center;
  z-index: 1;
  pointer-events: none;
}
.canvas {
  position: relative;
}
svg {
  position: absolute;
  inset: 0;
  overflow: visible;
}
.arr {
  animation: fade 0.45s ease both;
  path {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.6;
  }
  .hit {
    stroke: transparent;
    stroke-width: 12;
    cursor: pointer;
    &:hover {
      stroke: var(--bad-soft);
    }
  }
  &.sug path {
    stroke: var(--accent);
    stroke-dasharray: 6 4;
  }
  &.off path {
    stroke: var(--bad);
  }
}
.wire {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.6;
  stroke-dasharray: 4 4;
}
.chip-sug {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  font-size: 11px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-text);
  border: 1px solid var(--accent);
  z-index: 2;
  animation: chip-in 0.35s ease both;
  button {
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0 3px;
  }
}
.card {
  position: absolute;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  box-shadow: var(--shadow);
  font-size: 13px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  z-index: 1;
  animation: pop 0.35s ease both;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
  &.note {
    background: var(--warn-soft);
  }
  &.dragging {
    cursor: grabbing;
    z-index: 3;
    animation: none;
  }
  &.ghost {
    border: 1.5px dashed var(--accent);
    background: var(--accent-soft);
    cursor: default;
  }
  &.chg {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  &.del {
    border-color: var(--bad);
    box-shadow: 0 0 0 3px var(--bad-soft);
    .title,
    .text {
      text-decoration: line-through;
      opacity: 0.7;
    }
  }
  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 6px;
    font: inherit;
    user-select: text;
  }
}
.head {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 20px;
  margin-bottom: 2px;
  .kind {
    font-size: 11px;
    color: var(--muted);
  }
  button {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--muted);
    padding: 0 3px;
    font-size: 12px;
    &:hover:not(:disabled) {
      color: var(--text);
    }
    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
  }
}
.title {
  font-weight: 600;
}
.text {
  color: var(--muted);
  white-space: pre-wrap;
  max-height: 96px;
  overflow: auto;
}
.sug {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--accent);
  .small {
    color: var(--accent-text);
  }
}
.row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.ask {
  margin-top: 8px;
}
.port {
  position: absolute;
  right: -7px;
  top: 17px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--card);
  border: 2px solid var(--accent);
  cursor: crosshair;
  &:hover {
    background: var(--accent);
  }
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.92) translateY(6px);
  }
}
@keyframes chip-in {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.8);
  }
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
</style>
