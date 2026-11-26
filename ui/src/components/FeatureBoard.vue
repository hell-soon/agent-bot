<script setup lang="ts">
import type { Mark, Sketch } from './SketchFrame.vue'
// Мини-доска «Разработки фичи»: шаги, заметки, стрелки зависимостей и предложения бота.
// Доска живёт на сервере (run.board, логика — featurePlan.mjs); здесь — показ и действия через /api/runs/:id/board.
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { api } from '../lib/api'
import { toast } from '../lib/store'
import SketchFrame from './SketchFrame.vue'

interface Item { id: string, type: 'step' | 'note', title: string, text: string, x: number, y: number, by: 'bot' | 'user' }
interface Sug { id: string, kind: 'add' | 'edit' | 'remove' | 'link' | 'unlink' | 'sketch', item?: Item, target?: string, title?: string, text?: string, from?: string, to?: string, sketch?: Sketch }
interface Board { rev: number, items: Item[], links: { from: string, to: string }[], suggestions: Sug[], sketches?: Sketch[], marks?: Mark[] }

const props = defineProps<{ run: any }>()
const W = 220 // ширина карточки
const HEAD = 24 // высота, на которой в карточку входят стрелки
const SK_HEAD = 26 // заголовок рамки эскиза (как SKETCH_HEAD в featureSketch.mjs)

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
// вопрос бота во время разработки — пауза: доска снова открыта и редактируется до «Продолжить работу»
const paused = computed(() => !!props.run.pause)
const locked = computed(() => !!props.run.planApproved && !paused.value)
const thinking = computed(() => ['running', 'queued'].includes(props.run.status))
// утверждённый план можно свернуть; на паузе доска раскрывается сама
const root = ref<HTMLElement>()
const shown = ref(!props.run.planApproved)
const open = computed(() => !locked.value || shown.value)
watch(paused, async (p) => {
  if (!p)
    return
  shown.value = true
  await nextTick()
  root.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
})
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
// ---------- эскизы ----------
const moving = reactive<Record<string, { x: number, y: number }>>({}) // рамка, которую сейчас тащат
const sketches = computed(() => {
  const edits = new Map(board.value.suggestions.filter(s => s.kind === 'sketch' && s.target).map(s => [s.target!, s]))
  return [
    ...(board.value.sketches || []).map((sk) => {
      const sug = edits.get(sk.id)
      return { sk, sug, proposal: sug && { sketch: sug.sketch!, isNew: false } }
    }),
    ...board.value.suggestions.filter(s => s.kind === 'sketch' && !s.target).map(sug => ({
      sk: sug.sketch!,
      sug,
      proposal: { sketch: sug.sketch!, isNew: true },
    })),
  ]
})
const skPos = (sk: Sketch) => moving[sk.id] || { x: sk.x, y: sk.y }
function setMoving(id: string, p: { x: number, y: number } | null) {
  if (p)
    moving[id] = p
  else
    delete moving[id]
}
const stepList = computed(() => board.value.items.filter(i => i.type === 'step').map(i => ({ id: i.id, title: i.title })))
// пунктир от шага к его эскизу
const attach = computed(() => sketches.value.flatMap(({ sk }) => {
  const a = sk.step && where.value.get(sk.step)
  const p = skPos(sk)
  return a
    ? [
        { key: sk.id, d: curve(a, { x: p.x, y: p.y - SK_HEAD / 2 - HEAD }).d },
      ]
    : []
}))

const size = computed(() => {
  const ps = [
    ...[
      ...where.value.values(),
    ].map(p => ({ x: p.x + W + 60, y: p.y + 200 })),
    ...sketches.value.map(({ sk }) => ({ x: skPos(sk).x + sk.w + 60, y: skPos(sk).y + sk.h + 80 })),
  ]
  return {
    w: Math.max(...ps.map(p => p.x), 600),
    h: Math.max(...ps.map(p => p.y), 320),
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
  follow(endMove)
}
function onMove(e: PointerEvent) {
  const p = at(e)
  if (wire.from) {
    wire.x = p.x
    wire.y = p.y
    return
  }
  drag.x = Math.max(0, Math.round(p.x - drag.dx))
  drag.y = Math.max(0, Math.round(p.y - drag.dy))
  drag.moved = true
}
// Слежка за указателем до отпускания; pointercancel (жест системы, прокрутка) — отмена без изменений
let unfollow = () => {}
function follow(end: (e: PointerEvent, cancelled: boolean) => void) {
  unfollow()
  const up = (e: PointerEvent) => {
    unfollow()
    end(e, e.type === 'pointercancel')
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  unfollow = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    unfollow = () => {}
  }
}
onBeforeUnmount(() => unfollow())
async function endMove(_e: PointerEvent, cancelled: boolean) {
  const { id, x, y, moved } = drag
  if (moved && !cancelled)
    await op({ op: 'move', id, x, y })
  drag.id = ''
}
function startWire(e: PointerEvent, it: Item) {
  if (e.button !== 0)
    return
  const p = at(e)
  Object.assign(wire, { from: it.id, x: p.x, y: p.y })
  follow(endWire)
}
async function endWire(e: PointerEvent, cancelled: boolean) {
  const from = wire.from
  wire.from = ''
  const to = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-step]')?.dataset.step
  if (!cancelled && to && to !== from)
    await op({ op: 'link', from, to })
}

// ---------- рисование от руки поверх доски и эскизов ----------
const pen = ref(false)
const stroke = ref<[number, number][]>([])
const marks = computed(() => board.value.marks || [])
const boardMarks = computed(() => marks.value.filter(m => !m.on))
const marksOn = (id: string) => marks.value.filter(m => m.on === id)
const pathOf = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('')
let unpen = () => {}
onBeforeUnmount(() => unpen())
function startStroke(e: PointerEvent) {
  if (e.button !== 0 || locked.value)
    return
  e.preventDefault()
  unpen()
  const p = at(e)
  stroke.value = [
    [
      Math.round(p.x),
      Math.round(p.y),
    ],
  ]
  const move = (ev: PointerEvent) => {
    const q = at(ev)
    stroke.value.push([
      Math.round(q.x),
      Math.round(q.y),
    ])
  }
  const up = (ev: PointerEvent) => {
    unpen()
    const pts = stroke.value
    stroke.value = []
    if (ev.type !== 'pointercancel' && pts.length > 1)
      saveStroke(pts)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  unpen = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    unpen = () => {}
  }
}
// штрих, начатый на эскизе, принадлежит ему (координаты — внутри рамки), иначе — доске
function saveStroke(pts: [number, number][]) {
  const [x, y] = pts[0]
  const sk = [
    ...(board.value.sketches || []),
  ].reverse().find(s => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h)
  op({
    op: 'mark',
    on: sk?.id || '',
    pts: sk
      ? pts.map(([px, py]) => [px - sk.x, py - sk.y])
      : pts,
  })
}
function undoMark() {
  const last = marks.value[marks.value.length - 1]
  if (last)
    op({ op: 'unmark', id: last.id })
}
function clearMarks() {
  // eslint-disable-next-line no-alert -- простое подтверждение, как у карточек доски
  if (confirm('Стереть все пометки от руки?'))
    op({ op: 'clearMarks' })
}
function addSketch() {
  const el = canvas.value?.parentElement
  op({
    op: 'addSketch',
    title: 'Эскиз',
    ...(el
      ? { x: el.scrollLeft + 40, y: el.scrollTop + 40 + SK_HEAD }
      : {}),
  })
}

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
// ---------- вопрос бота и «Продолжить работу» ----------
const answer = ref('')
const resuming = ref(false)
const askedStep = computed(() => {
  const id = props.run.pause?.step
  return board.value.items.find(i => !!id && i.id === id)
})
const resumeBlocker = computed(() => thinking.value
  ? 'Бот заканчивает ход — сейчас можно будет продолжить'
  : board.value.suggestions.length
    ? 'Сначала примите или отклоните предложения бота'
    : '')
const cleanOption = (l: string) => l.replace(/\s*\((?:рекомендую|рекомендуется|recommended)\)/i, '')
// клик по варианту — он становится ответом (повторный клик снимает)
function pickOption(o: string) {
  const v = cleanOption(o)
  answer.value = answer.value === v
    ? ''
    : v
}
async function resume() {
  resuming.value = true
  try {
    await api(`/api/runs/${props.run.id}/resume`, {
      answer: answer.value.trim(),
    })
    answer.value = ''
  }
  catch (e: any) {
    toast(e.message)
  }
  finally {
    resuming.value = false
  }
}
const SUG_TEXT: Record<string, string> = {
  add: 'Бот предлагает добавить',
  edit: 'Бот предлагает изменить',
  remove: 'Бот предлагает удалить',
  link: 'Новая зависимость',
  unlink: 'Убрать зависимость',
  sketch: 'Бот предлагает эскиз',
}
</script>

<template>
  <section
    ref="root"
    class="fboard"
  >
    <header>
      <b>План фичи</b>
      <template v-if="locked">
        <span class="tag ok">утверждён — бот работает по нему</span>
        <span class="spacer" />
        <button
          class="btn ghost sm"
          @click="shown = !shown"
        >
          {{ shown ? 'Свернуть' : 'Показать план' }}
        </button>
      </template>
      <span
        v-else-if="paused"
        class="tag wait"
      >пауза — бот ждёт ответа</span>
      <span
        v-else
        class="small"
      >{{ steps }} шаг. · стрелка — «после» · карточки можно двигать</span>
      <span
        v-if="!locked"
        class="spacer"
      />
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
        <button
          class="btn ghost sm"
          @click="addSketch"
        >
          + Эскиз
        </button>
        <button
          class="btn sm"
          :class="pen ? 'primary' : 'ghost'"
          title="Рисовать от руки поверх плана и эскизов"
          @click="pen = !pen"
        >
          ✏ {{ pen ? 'Готово' : 'Рисовать' }}
        </button>
        <template v-if="marks.length">
          <button
            class="btn ghost sm"
            title="Убрать последнюю пометку"
            @click="undoMark"
          >
            ↶
          </button>
          <button
            class="btn ghost sm"
            title="Стереть все пометки"
            @click="clearMarks"
          >
            Стереть
          </button>
        </template>
      </template>
    </header>

    <form
      v-if="paused"
      class="question"
      @submit.prevent="resume"
    >
      <div class="small">
        Вопрос бота{{ askedStep ? ` к шагу «${askedStep.title || askedStep.id}»` : '' }} — правки кода остановлены
      </div>
      <div class="q">
        {{ run.pause.text }}
      </div>
      <div
        v-if="run.pause.options?.length"
        class="opts"
      >
        <button
          v-for="o in run.pause.options"
          :key="o"
          type="button"
          class="btn sm"
          :class="answer === cleanOption(o) ? 'primary' : 'ghost'"
          @click="pickOption(o)"
        >
          {{ o }}
        </button>
      </div>
      <textarea
        v-model="answer"
        rows="2"
        placeholder="Ответ боту (можно не писать, если ответили правкой плана или эскиза)"
        @keydown.enter.meta.prevent="resume"
        @keydown.enter.ctrl.prevent="resume"
      />
      <div class="row">
        <span class="small">{{ resumeBlocker || 'Бот получит ответ и доску — если вы её меняли, то с обновлённым планом.' }}</span>
        <span class="spacer" />
        <button
          class="btn primary"
          :disabled="!!resumeBlocker || resuming"
        >
          Продолжить работу
        </button>
      </div>
    </form>

    <div
      v-if="open"
      class="viewport"
    >
      <div
        v-if="!cards.length && !sketches.length"
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
          <path
            v-for="a in attach"
            :key="`att${a.key}`"
            class="att"
            :d="a.d"
          />
        </svg>

        <sketch-frame
          v-for="v in sketches"
          :key="v.sug && v.proposal?.isNew ? v.sug.id : v.sk.id"
          :sketch="{ ...v.sk, ...skPos(v.sk) }"
          :head="SK_HEAD"
          :marks="v.proposal?.isNew ? [] : marksOn(v.sk.id)"
          :steps="stepList"
          :readonly="locked || pen"
          :proposal="locked ? undefined : v.proposal"
          :act="op"
          @accept="op({ op: 'accept', id: v.sug!.id })"
          @reject="op({ op: 'reject', id: v.sug!.id })"
          @moving="p => setMoving(v.sk.id, p)"
        />

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
            asked: paused && askedStep?.id === c.it.id,
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
              <span
                v-if="paused && askedStep?.id === c.it.id"
                class="tag wait"
                :title="run.pause.text"
              >вопрос бота</span>
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

        <!-- пометки от руки на доске — поверх карточек; на эскизах их рисует сама рамка -->
        <svg
          class="ink"
          :width="size.w"
          :height="size.h"
        >
          <path
            v-for="m in boardMarks"
            :key="m.id"
            :d="pathOf(m.pts)"
          />
          <path
            v-if="stroke.length > 1"
            :d="pathOf(stroke)"
          />
        </svg>
        <div
          v-if="pen && !locked"
          class="pad"
          title="Рисуйте поверх плана и эскизов"
          @pointerdown="startStroke"
        />
      </div>
    </div>

    <footer v-if="!run.planApproved">
      <span class="small">{{ blocker || 'Бот получит исходную задачу, этот план, эскизы и пометки. До нажатия код не меняется.' }}</span>
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
.tag.wait {
  color: var(--warn);
  background: var(--warn-soft);
  border-radius: 6px;
  padding: 1px 6px;
  font-size: 11px;
}
.question {
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: var(--warn-soft);
  .small {
    color: var(--warn);
  }
  .q {
    margin: 4px 0 8px;
    font-weight: 600;
  }
  .opts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
  }
  .row {
    align-items: center;
  }
}
.viewport {
  position: relative;
  height: 520px;
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
.att {
  fill: none;
  stroke: var(--muted);
  stroke-width: 1.2;
  stroke-dasharray: 2 4;
  opacity: 0.7;
}
svg.ink {
  z-index: 4;
  pointer-events: none;
  path {
    fill: none;
    stroke: var(--bad);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}
.pad {
  position: absolute;
  inset: 0;
  z-index: 5;
  cursor: crosshair;
  touch-action: none;
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
  &.asked {
    border-color: var(--warn);
    box-shadow: 0 0 0 3px var(--warn-soft);
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
@media (prefers-reduced-motion: reduce) {
  .arr,
  .card,
  .chip-sug {
    animation: none;
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
