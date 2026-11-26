<script setup lang="ts">
// Эскиз интерфейса на доске фичи: рамка с блоками (прямоугольник, текст, кнопка) и пометками от руки.
// Двигать и тянуть за угол можно и рамку, и блоки; подпись блока — двойной клик. Изменения уходят на сервер через props.act.
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue'

export interface Shape { id: string, type: 'rect' | 'text' | 'button', x: number, y: number, w: number, h: number, label: string }
export interface Sketch { id: string, step: string, title: string, x: number, y: number, w: number, h: number, shapes: Shape[], by?: string }
export interface Mark { id: string, on: string, pts: [number, number][] }

const props = defineProps<{
  sketch: Sketch
  scale: number
  head: number // высота заголовка над телом рамки
  marks: Mark[]
  steps: { id: string, title: string }[]
  readonly: boolean // план утверждён или идёт рисование
  proposal?: { sketch: Sketch, isNew: boolean } // предложение бота: новый эскиз или новый вариант этого
  act: (body: Record<string, any>) => Promise<unknown> // действие с доской на сервере
}>()
const emit = defineEmits<{
  accept: []
  reject: []
  moving: [pos: { x: number, y: number } | null]
}>()

// перетаскивание по смещению указателя: рамка, её размер, блок, его размер
const live = reactive({ key: '', x: 0, y: 0, w: 0, h: 0 })
function idle() {}
let stop = idle // снимает слежку за указателем текущего перетаскивания
onBeforeUnmount(() => stop())
function track(e: PointerEvent, key: string, start: { x: number, y: number, w: number, h: number }, apply: (dx: number, dy: number) => Partial<typeof live>, done: () => Promise<unknown>) {
  if (e.button !== 0 || props.readonly || props.proposal?.isNew)
    return
  e.stopPropagation()
  e.preventDefault()
  stop()
  const ox = e.clientX; const oy = e.clientY
  const scale = props.scale
  let moved = false
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId)
      return
    const dx = (ev.clientX - ox) / scale
    const dy = (ev.clientY - oy) / scale
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3)
      return
    moved = true
    Object.assign(live, { key, ...start }, apply(dx, dy))
    if (key === 'frame')
      emit('moving', { x: live.x, y: live.y })
  }
  const up = async (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId)
      return
    stop()
    if (moved && ev.type !== 'pointercancel')
      await done() // до ответа сервера рамка остаётся там, куда её отпустили
    if (live.key !== key || stop !== idle)
      return // за это время начали новое перетаскивание — его состояние не трогаем
    live.key = ''
    emit('moving', null)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    stop = idle
  }
}

const sk = computed(() => props.proposal?.isNew
  ? props.proposal.sketch
  : props.sketch)
const frame = computed(() => live.key === 'frame' || live.key === 'size'
  ? {
      x: live.x,
      y: live.y,
      w: live.w,
      h: live.h,
    }
  : sk.value)
function box(s: Shape) {
  return live.key === `s:${s.id}`
    ? {
        x: live.x,
        y: live.y,
        w: live.w,
        h: live.h,
      }
    : s
}
const GRAB = 16 // как в featureSketch.mjs: у блока внутри рамки всегда видно хотя бы столько
const within = (v: number, lo: number, hi = Infinity) => Math.min(Math.max(lo, hi), Math.max(lo, Math.round(v)))
const fitW = () => Math.max(120, ...sk.value.shapes.map(x => x.x + GRAB))
const fitH = () => Math.max(120, ...sk.value.shapes.map(x => x.y + GRAB))

function moveFrame(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('button, input, select'))
    return
  const s = sk.value
  track(e, 'frame', s, (dx, dy) => ({
    x: within(s.x + dx, 0),
    y: within(s.y + dy, props.head),
  }), () => props.act({
    op: 'sketch',
    id: s.id,
    x: live.x,
    y: live.y,
  }))
}
function sizeFrame(e: PointerEvent) {
  const s = sk.value
  track(e, 'size', s, (dx, dy) => ({
    w: within(s.w + dx, fitW(), 1600),
    h: within(s.h + dy, fitH(), 1600),
  }), () => props.act({
    op: 'sketch',
    id: s.id,
    w: live.w,
    h: live.h,
  }))
}

const selected = ref('')
function moveShape(e: PointerEvent, s: Shape) {
  if ((e.target as HTMLElement).closest('button, input'))
    return
  selected.value = s.id
  track(e, `s:${s.id}`, s, (dx, dy) => ({
    x: within(s.x + dx, 0, sk.value.w - GRAB),
    y: within(s.y + dy, 0, sk.value.h - GRAB),
  }), () => props.act({
    op: 'shape',
    sketch: sk.value.id,
    id: s.id,
    x: live.x,
    y: live.y,
  }))
}
function sizeShape(e: PointerEvent, s: Shape) {
  track(e, `s:${s.id}`, s, (dx, dy) => ({
    w: within(s.w + dx, 8),
    h: within(s.h + dy, 8),
  }), () => props.act({
    op: 'shape',
    sketch: sk.value.id,
    id: s.id,
    w: live.w,
    h: live.h,
  }))
}

// подписи: блок — двойной клик, рамка — двойной клик по заголовку (там же привязка к шагу)
const label = reactive({ id: '', text: '' })
const labelInput = ref<HTMLInputElement[]>()
async function editLabel(s: Shape) {
  if (props.readonly || props.proposal?.isNew)
    return
  Object.assign(label, { id: s.id, text: s.label })
  await nextTick()
  labelInput.value?.[0]?.focus()
}
function saveLabel() {
  if (label.id && label.text !== sk.value.shapes.find(s => s.id === label.id)?.label) {
    props.act({
      op: 'shape',
      sketch: sk.value.id,
      id: label.id,
      label: label.text,
    })
  }
  label.id = ''
}
const meta = reactive({ open: false, title: '', step: '' })
function editHead() {
  if (props.readonly || props.proposal?.isNew)
    return
  Object.assign(meta, { open: true, title: sk.value.title, step: sk.value.step })
}
function saveHead() {
  props.act({
    op: 'sketch',
    id: sk.value.id,
    title: meta.title,
    step: meta.step,
  })
  meta.open = false
}
function addShape(type: Shape['type']) {
  props.act({
    op: 'addShape',
    sketch: sk.value.id,
    type,
  })
}
function removeSketch() {
  // eslint-disable-next-line no-alert -- простое подтверждение, как у карточек доски
  if (confirm(`Удалить эскиз «${sk.value.title || 'Эскиз'}» вместе с пометками на нём?`))
    props.act({ op: 'removeSketch', id: sk.value.id })
}
const stepTitle = computed(() => props.steps.find(s => s.id === sk.value.step)?.title)
const line = (m: Mark) => m.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('')
</script>

<template>
  <div
    class="sketch"
    :class="{ ghost: proposal?.isNew, chg: proposal && !proposal.isNew, dragging: live.key === 'frame' }"
    :style="{ left: `${frame.x}px`, top: `${frame.y - head}px`, width: `${frame.w}px` }"
  >
    <div
      class="bar"
      :style="{ height: `${head}px` }"
      @pointerdown="moveFrame"
      @dblclick="editHead"
    >
      <span class="name">{{ sk.title || 'Эскиз' }}<span
        v-if="stepTitle"
        class="small"
      > · к «{{ stepTitle }}»</span></span>
      <template v-if="!readonly && !proposal?.isNew">
        <button
          title="Добавить блок"
          @click="addShape('rect')"
        >
          ▭
        </button>
        <button
          title="Добавить текст"
          @click="addShape('text')"
        >
          T
        </button>
        <button
          title="Добавить кнопку"
          @click="addShape('button')"
        >
          ⬚
        </button>
        <button
          title="Название и шаг"
          @click="editHead"
        >
          ✎
        </button>
        <button
          title="Удалить эскиз"
          @click="removeSketch"
        >
          ✕
        </button>
      </template>
    </div>

    <form
      v-if="meta.open"
      class="headform"
      :style="{ top: `${head}px` }"
      @submit.prevent="saveHead"
    >
      <input
        v-model="meta.title"
        placeholder="Название эскиза"
      >
      <select v-model="meta.step">
        <option value="">
          без шага
        </option>
        <option
          v-for="s in steps"
          :key="s.id"
          :value="s.id"
        >
          {{ s.title || s.id }}
        </option>
      </select>
      <button class="btn primary sm">
        Сохранить
      </button>
      <button
        type="button"
        class="btn ghost sm"
        @click="meta.open = false"
      >
        Отмена
      </button>
    </form>

    <div
      class="body"
      :style="{ width: `${frame.w}px`, height: `${frame.h}px` }"
      @pointerdown.self="selected = ''"
    >
      <div
        v-for="s in sk.shapes"
        :key="s.id"
        class="shape"
        :class="[s.type, { sel: selected === s.id && !readonly }]"
        :style="{ left: `${box(s).x}px`, top: `${box(s).y}px`, width: `${box(s).w}px`, height: `${box(s).h}px` }"
        @pointerdown="moveShape($event, s)"
        @dblclick.stop="editLabel(s)"
      >
        <input
          v-if="label.id === s.id"
          ref="labelInput"
          v-model="label.text"
          @keydown.enter.prevent="saveLabel"
          @keydown.esc="label.id = ''"
          @blur="saveLabel"
        >
        <span v-else>{{ s.label }}</span>
        <template v-if="selected === s.id && !readonly && !proposal?.isNew">
          <button
            class="x"
            title="Удалить блок"
            @click.stop="props.act({ op: 'removeShape', sketch: sk.id, id: s.id })"
          >
            ✕
          </button>
          <span
            class="grip"
            title="Тяните, чтобы изменить размер"
            @pointerdown="sizeShape($event, s)"
          />
        </template>
      </div>

      <!-- новый вариант от бота — пунктиром поверх текущего -->
      <div
        v-if="proposal && !proposal.isNew"
        class="variant"
        :style="{ width: `${proposal.sketch.w}px`, height: `${proposal.sketch.h}px` }"
      >
        <div
          v-for="s in proposal.sketch.shapes"
          :key="s.id"
          class="shape"
          :class="s.type"
          :style="{ left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` }"
        >
          <span>{{ s.label }}</span>
        </div>
      </div>

      <span
        v-if="!readonly && !proposal?.isNew"
        class="grip frame-grip"
        title="Тяните, чтобы изменить размер эскиза"
        @pointerdown="sizeFrame"
      />
    </div>

    <!-- пометки — вне тела рамки: тело обрезает блоки по краю, а обводка может выходить за него -->
    <svg
      class="ink"
      :style="{ top: `${head}px` }"
      :width="frame.w"
      :height="frame.h"
    >
      <path
        v-for="m in marks"
        :key="m.id"
        :d="line(m)"
      />
    </svg>

    <div
      v-if="proposal && !readonly"
      class="sug"
    >
      <span class="small">{{ proposal.isNew ? 'Бот предлагает эскиз' : 'Бот предлагает новый вариант (пунктир)' }}</span>
      <span class="spacer" />
      <button
        class="btn primary sm"
        @click="emit('accept')"
      >
        Принять
      </button>
      <button
        class="btn ghost sm"
        @click="emit('reject')"
      >
        Отклонить
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.sketch {
  position: absolute;
  z-index: 1;
  // outline, а не border: тело рамки начинается ровно в (x, y) доски — пометки и блоки не съезжают на толщину линии
  outline: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  box-shadow: var(--shadow);
  font-size: 12px;
  user-select: none;
  touch-action: none;
  animation: pop 0.35s ease both;
  &.dragging {
    z-index: 3;
    animation: none;
  }
  &.ghost {
    outline: 1.5px dashed var(--accent);
    background: var(--accent-soft);
  }
  &.chg {
    outline-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
}
.bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px 0 10px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--line);
  cursor: grab;
  .name {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-weight: 600;
  }
  button {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--muted);
    padding: 0 3px;
    font-size: 12px;
    &:hover {
      color: var(--text);
    }
  }
}
.headform {
  // поверх тела рамки, чтобы не сдвигать блоки и пометки относительно доски
  position: absolute;
  left: 0;
  right: 0;
  z-index: 4;
  background: var(--card);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px;
  border-bottom: 1px solid var(--line);
  input,
  select {
    flex: 1 1 100%;
    font: inherit;
  }
}
.body {
  position: relative;
  overflow: hidden;
  border-radius: 0 0 10px 10px;
  background: var(--sunk);
}
.shape {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1.5px solid var(--muted);
  border-radius: 4px;
  background: var(--card);
  color: var(--text);
  cursor: move;
  animation: fade 0.3s ease both;
  &.text {
    border: 1px dashed transparent;
    background: none;
    justify-content: flex-start;
    &:hover {
      border-color: var(--line);
    }
  }
  &.button {
    border-radius: 8px;
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: 600;
  }
  &.sel {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    overflow: visible;
  }
  span {
    padding: 0 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  input {
    width: 100%;
    font: inherit;
    user-select: text;
  }
  .x {
    position: absolute;
    top: -10px;
    right: -10px;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: var(--card);
    color: var(--muted);
    font-size: 10px;
    cursor: pointer;
  }
}
.grip {
  position: absolute;
  right: -5px;
  bottom: -5px;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--accent);
  cursor: nwse-resize;
  z-index: 2;
}
.frame-grip {
  right: 2px;
  bottom: 2px;
}
.variant {
  position: absolute;
  inset: 0 auto auto 0;
  pointer-events: none;
  .shape {
    border-style: dashed;
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent-soft) 60%, transparent);
    color: var(--accent-text);
  }
}
.ink {
  position: absolute;
  left: 0;
  overflow: visible;
  pointer-events: none;
  z-index: 2;
  path {
    fill: none;
    stroke: var(--bad);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}
.sug {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px dashed var(--accent);
  .small {
    color: var(--accent-text);
  }
}
.spacer {
  flex: 1;
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.94) translateY(6px);
  }
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sketch,
  .shape {
    animation: none;
  }
}
</style>
