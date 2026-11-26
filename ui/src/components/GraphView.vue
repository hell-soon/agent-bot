<script setup lang="ts">
// Граф проекта (как в Obsidian): файлы, которые бот правил, и задачи, в которых правил.
// Узлы двигаются (d3-force), граф можно таскать, приближать колесом, узлы — перетаскивать.
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, triggerRef, watch } from 'vue'
import { api } from '../lib/api'
import { STATUS } from '../lib/format'
import { goHome, select, store } from '../lib/store'
import Icon from './Icon.vue'

interface GRun { id: string, title: string, status: string, ai: 'claude' | 'codex', kind: string, prUrl?: string, at: number, files: { path: string, edits: number }[] }
interface GNode extends SimulationNodeDatum { id: string, type: 'file' | 'run', label: string, r: number, color: string, edits: number, run?: GRun, path?: string, runs: string[] }
type GLink = SimulationLinkDatum<GNode> & { w: number }

const data = ref<GRun[]>([])
const loading = ref(true)
const f = reactive({ days: 'all' as '7' | '30' | '90' | 'all', ai: 'all' as 'all' | 'claude' | 'codex', tasks: true, q: '' })
const picked = ref<GNode | null>(null)
const hover = ref<GNode | null>(null)

async function load() {
  loading.value = true
  try { data.value = (await api<{ runs: GRun[] }>(`/api/graph?repo=${encodeURIComponent(store.curRepo)}`)).runs }
  finally { loading.value = false }
}
watch(() => store.curRepo, () => { picked.value = null; load() })

// цвет файла — по верхней папке (src/, server/, docs/ …)
const top = (p: string) => (p.includes('/') ? p.split('/')[0] : 'корень')
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
const folderColor = (p: string) => `hsl(${hue(top(p))} 58% 56%)`
const runColor = (r: GRun) => (r.status === 'done' ? 'var(--ok)' : ['failed', 'limited'].includes(r.status) ? 'var(--bad)' : ['running', 'waiting', 'queued'].includes(r.status) ? 'var(--accent)' : 'var(--muted)')

const runsShown = computed(() => {
  const since = f.days === 'all' ? 0 : Date.now() - Number(f.days) * 86400000
  return data.value.filter(r => r.at >= since && (f.ai === 'all' || r.ai === f.ai))
})

const nodes = shallowRef<GNode[]>([])
const links = shallowRef<GLink[]>([])
let sim: Simulation<GNode, GLink> | null = null

function rebuild() {
  const old = new Map(nodes.value.map(n => [n.id, n]))
  const files = new Map<string, GNode>()
  const ns: GNode[] = []; const ls: GLink[] = []
  for (const r of runsShown.value) {
    for (const x of r.files) {
      let n = files.get(x.path)
      if (!n) {
        const o = old.get(`f:${x.path}`)
        n = { id: `f:${x.path}`, type: 'file', label: x.path.split('/').pop()!, path: x.path, r: 0, color: folderColor(x.path), edits: 0, runs: [], x: o?.x, y: o?.y }
        files.set(x.path, n); ns.push(n)
      }
      n.edits += x.edits; n.runs.push(r.id)
    }
  }
  for (const n of ns) n.r = 4 + Math.sqrt(n.edits) * 2.2
  if (f.tasks) {
    for (const r of runsShown.value) {
      const o = old.get(`r:${r.id}`)
      ns.push({ id: `r:${r.id}`, type: 'run', label: r.title, run: r, r: 7, color: runColor(r), edits: 0, runs: [r.id], x: o?.x, y: o?.y })
      for (const x of r.files) ls.push({ source: `r:${r.id}`, target: `f:${x.path}`, w: x.edits })
    }
  }
  else { // файлы, которые правились вместе: связь сильнее, чем чаще вместе
    const pair = new Map<string, number>()
    for (const r of runsShown.value) {
      const ps = r.files.slice(0, 25).map(x => x.path).sort()
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const k = `${ps[i]}\n${ps[j]}`
          pair.set(k, (pair.get(k) || 0) + 1)
        }
      }
    }
    for (const [k, w] of pair) {
      const [a, b] = k.split('\n')
      ls.push({ source: `f:${a}`, target: `f:${b}`, w })
    }
  }
  const first = !old.size
  nodes.value = ns; links.value = ls
  if (first)
    setTimeout(fit, 900)
  sim?.stop()
  sim = forceSimulation<GNode, GLink>(ns)
    .force('link', forceLink<GNode, GLink>(ls).id(d => d.id).distance(l => (f.tasks ? 46 : 70 / Math.sqrt(l.w))).strength(l => (f.tasks ? 0.5 : Math.min(1, 0.15 * l.w))))
    .force('charge', forceManyBody<GNode>().strength(d => (d.type === 'run' ? -140 : -60 - d.r * 6)))
    .force('center', forceCenter(0, 0))
    .force('x', forceX(0).strength(0.04))
    .force('y', forceY(0).strength(0.04))
    .force('collide', forceCollide<GNode>(d => d.r + 3))
    .on('tick', () => { triggerRef(nodes); triggerRef(links) })
}
watch([runsShown, () => f.tasks], rebuild)

// ---------- вид: сдвиг и масштаб ----------
const svg = ref<SVGSVGElement>()
const size = reactive({ w: 800, h: 600 })
const view = reactive({ x: 0, y: 0, k: 1 })
let ro: ResizeObserver | undefined
onMounted(async () => {
  ro = new ResizeObserver(([e]) => { size.w = e.contentRect.width; size.h = e.contentRect.height })
  if (svg.value)
    ro.observe(svg.value)
  await load()
})
onBeforeUnmount(() => { sim?.stop(); ro?.disconnect() })

const toWorld = (cx: number, cy: number) => {
  const b = svg.value!.getBoundingClientRect()
  return { x: (cx - b.left - size.w / 2 - view.x) / view.k, y: (cy - b.top - size.h / 2 - view.y) / view.k }
}
function onWheel(e: WheelEvent) {
  const b = svg.value!.getBoundingClientRect()
  const px = e.clientX - b.left - size.w / 2; const py = e.clientY - b.top - size.h / 2
  const k = Math.min(4, Math.max(0.25, view.k * Math.exp(-e.deltaY * 0.0015)))
  view.x = px - (px - view.x) * (k / view.k); view.y = py - (py - view.y) * (k / view.k); view.k = k
}
let drag: { node?: GNode, sx: number, sy: number, vx: number, vy: number, moved: boolean } | null = null
function down(e: PointerEvent, node?: GNode) {
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  drag = { node, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }
  if (node) { node.fx = node.x; node.fy = node.y; sim?.alphaTarget(0.3).restart() }
  e.stopPropagation()
}
function move(e: PointerEvent) {
  if (!drag)
    return
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3)
    drag.moved = true
  if (drag.node) {
    const p = toWorld(e.clientX, e.clientY)
    drag.node.fx = p.x; drag.node.fy = p.y
  }
  else { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy }
}
function up() {
  if (!drag)
    return
  if (drag.node) {
    drag.node.fx = null; drag.node.fy = null; sim?.alphaTarget(0)
    if (!drag.moved)
      picked.value = picked.value === drag.node ? null : drag.node
  }
  else if (!drag.moved) { picked.value = null }
  drag = null
}
function fit() {
  const ns = nodes.value
  if (!ns.length)
    return
  const xs = ns.map(n => n.x || 0); const ys = ns.map(n => n.y || 0)
  const w = Math.max(...xs) - Math.min(...xs) + 120; const h = Math.max(...ys) - Math.min(...ys) + 120
  view.k = Math.min(2, Math.max(0.25, Math.min(size.w / w, size.h / h)))
  view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k; view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k
}

// ---------- подсветка: наведение, выбор, поиск ----------
const focus = computed(() => hover.value || picked.value)
const near = computed(() => {
  const n = focus.value
  if (!n)
    return null
  const s = new Set([n.id])
  for (const l of links.value) {
    const a = (l.source as GNode).id; const b = (l.target as GNode).id
    if (a === n.id)
      s.add(b)
    if (b === n.id)
      s.add(a)
  }
  return s
})
const match = (n: GNode) => !f.q || (n.path || n.label).toLowerCase().includes(f.q.toLowerCase())
const dim = (n: GNode) => (near.value ? !near.value.has(n.id) : !!f.q && !match(n))
const showLabel = (n: GNode) => n === focus.value || (near.value?.has(n.id) ?? false) || (!!f.q && match(n)) || (n.type === 'file' && (n.r > 9 || view.k > 1.6))
const linkDim = (l: GLink) => !!focus.value && (l.source as GNode).id !== focus.value.id && (l.target as GNode).id !== focus.value.id

const legend = computed(() => {
  const c = new Map<string, number>()
  for (const n of nodes.value) if (n.type === 'file') c.set(top(n.path!), (c.get(top(n.path!)) || 0) + 1)
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, n]) => ({ d, n, color: `hsl(${hue(d)} 58% 56%)` }))
})
const stats = computed(() => ({ files: nodes.value.filter(n => n.type === 'file').length, runs: runsShown.value.length }))
const runOf = (id: string) => data.value.find(r => r.id === id)
const ago = (t: number) => new Date(t).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
</script>

<template>
  <div class="graph">
    <header class="top">
      <button
        class="btn ghost icon"
        title="Назад (Esc)"
        @click="goHome"
      >
        <icon name="back" />
      </button>
      <h2>Граф проекта <span class="small">{{ store.curRepo.split('/')[1] }} · {{ stats.files }} файлов · {{ stats.runs }} задач</span></h2>
      <span class="spacer" />
      <input
        v-model="f.q"
        class="q"
        placeholder="Найти файл"
        spellcheck="false"
      >
      <div class="seg">
        <button
          v-for="[v, l] in ([['7', '7 дн'], ['30', '30 дн'], ['90', '90 дн'], ['all', 'всё']] as const)"
          :key="v"
          :class="{ on: f.days === v }"
          @click="f.days = v"
        >
          {{ l }}
        </button>
      </div>
      <div class="seg">
        <button
          v-for="[v, l] in ([['all', 'Все'], ['claude', 'Claude'], ['codex', 'Codex']] as const)"
          :key="v"
          :class="{ on: f.ai === v }"
          @click="f.ai = v"
        >
          {{ l }}
        </button>
      </div>
      <div class="seg">
        <button
          :class="{ on: f.tasks }"
          title="Задачи и их файлы"
          @click="f.tasks = true"
        >
          Задачи
        </button>
        <button
          :class="{ on: !f.tasks }"
          title="Только файлы: связаны, если правились в одной задаче"
          @click="f.tasks = false"
        >
          Связи файлов
        </button>
      </div>
      <button
        class="btn ghost sm"
        title="Показать всё"
        @click="fit"
      >
        Вписать
      </button>
    </header>

    <div class="stage">
      <svg
        ref="svg"
        class="canvas"
        @wheel.prevent="onWheel"
        @pointerdown="down($event)"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
      >
        <g :transform="`translate(${size.w / 2 + view.x},${size.h / 2 + view.y}) scale(${view.k})`">
          <line
            v-for="(l, i) in links"
            :key="i"
            class="link"
            :class="{ dim: linkDim(l) }"
            :x1="(l.source as GNode).x"
            :y1="(l.source as GNode).y"
            :x2="(l.target as GNode).x"
            :y2="(l.target as GNode).y"
            :stroke-width="Math.min(4, 0.8 + l.w * 0.4) / Math.sqrt(view.k)"
          />
          <g
            v-for="n in nodes"
            :key="n.id"
            class="node"
            :class="[n.type, { dim: dim(n), sel: n === picked }]"
            :transform="`translate(${n.x || 0},${n.y || 0})`"
            @pointerdown="down($event, n)"
            @pointerenter="hover = n"
            @pointerleave="hover = null"
          >
            <rect
              v-if="n.type === 'run'"
              :x="-n.r"
              :y="-n.r"
              :width="n.r * 2"
              :height="n.r * 2"
              rx="3"
              :fill="n.color"
            />
            <circle
              v-else
              :r="n.r"
              :fill="n.color"
            />
            <text
              v-if="showLabel(n)"
              :y="n.r + 12 / view.k"
              :font-size="11 / view.k"
            >{{ n.type === 'run' ? n.label.slice(0, 48) : n.label }}</text>
          </g>
        </g>
      </svg>

      <div
        v-if="!loading && !nodes.length"
        class="empty"
      >
        <b>Пока пусто</b>
        <span class="small">Здесь появятся файлы, которые бот правил в {{ store.curRepo.split('/')[1] }}, и задачи, в которых правил. Попробуйте период «всё».</span>
      </div>

      <div
        v-if="legend.length"
        class="legend"
      >
        <span
          v-for="x in legend"
          :key="x.d"
        ><i :style="{ background: x.color }" />{{ x.d }}</span>
        <span v-if="f.tasks"><i class="sq ok" />задача · готово</span>
        <span v-if="f.tasks"><i class="sq bad" />не получилось</span>
        <span v-if="f.tasks"><i class="sq muted" />остановлено</span>
      </div>

      <aside
        v-if="picked"
        class="panel"
      >
        <template v-if="picked.type === 'file'">
          <h4>Файл</h4>
          <code class="path">{{ picked.path }}</code>
          <p class="small">
            {{ picked.edits }} правок в {{ picked.runs.length }} задачах
          </p>
          <button
            v-for="id in picked.runs"
            :key="id"
            class="item"
            @click="select(id)"
          >
            <span
              class="st"
              :class="runOf(id)?.status"
            /><span class="t">{{ runOf(id)?.title }}</span><span class="small">{{ ago(runOf(id)?.at || 0) }}</span>
          </button>
        </template>
        <template v-else-if="picked.run">
          <h4>Задача · {{ STATUS[picked.run.status] || picked.run.status }}</h4>
          <b class="title">{{ picked.run.title }}</b>
          <p class="small">
            {{ picked.run.ai === 'codex' ? 'Codex' : 'Claude' }} · {{ ago(picked.run.at) }} · {{ picked.run.files.length }} файлов
          </p>
          <div class="acts">
            <button
              class="btn sm primary"
              @click="select(picked.run.id)"
            >
              Открыть задачу
            </button>
            <a
              v-if="picked.run.prUrl"
              class="btn sm"
              :href="picked.run.prUrl"
              target="_blank"
            >PR ↗</a>
          </div>
          <code
            v-for="x in picked.run.files"
            :key="x.path"
            class="fl"
          >{{ x.path }} <i>×{{ x.edits }}</i></code>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped lang="scss">
.graph {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 52px);
  padding: 0 18px 18px;
}
.top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 0 12px;
  h2 {
    margin: 0;
    font-size: 17px;
    .small {
      font-weight: 400;
      margin-left: 6px;
    }
  }
  .q {
    width: 170px;
  }
}
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 16px;
  overflow: hidden;
  background:
    radial-gradient(circle, color-mix(in srgb, var(--muted) 22%, transparent) 1px, transparent 1px) 0 0 / 22px 22px,
    var(--card);
}
.canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
  touch-action: none;
  &:active {
    cursor: grabbing;
  }
}
.link {
  stroke: color-mix(in srgb, var(--muted) 45%, transparent);
  transition: opacity 0.15s;
  &.dim {
    opacity: 0.12;
  }
}
.node {
  cursor: pointer;
  transition: opacity 0.15s;
  circle,
  rect {
    stroke: var(--card);
    stroke-width: 1.5;
  }
  text {
    fill: var(--text);
    text-anchor: middle;
    pointer-events: none;
    paint-order: stroke;
    stroke: var(--card);
    stroke-width: 3px;
  }
  &.dim {
    opacity: 0.18;
  }
  &.sel circle,
  &.sel rect {
    stroke: var(--text);
    stroke-width: 2.5;
  }
}
.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
  gap: 6px;
  max-width: 420px;
  margin: auto;
  pointer-events: none;
}
.legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  max-width: 60%;
  font-size: 11.5px;
  color: var(--muted);
  background: color-mix(in srgb, var(--card) 85%, transparent);
  padding: 6px 10px;
  border-radius: 10px;
  span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
    &.sq {
      border-radius: 2px;
    }
    &.ok {
      background: var(--ok);
    }
    &.bad {
      background: var(--bad);
    }
    &.muted {
      background: var(--muted);
    }
  }
}
.panel {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 12px;
  width: 300px;
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  h4 {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    font-weight: 600;
  }
  .path {
    word-break: break-all;
    font-size: 12px;
  }
  .title {
    font-size: 14px;
  }
  p {
    margin: 0 0 4px;
  }
  .acts {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .fl {
    font-size: 11.5px;
    word-break: break-all;
    i {
      color: var(--muted);
      font-style: normal;
    }
  }
}
.item {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 12.5px;
  cursor: pointer;
  &:hover {
    background: var(--sunk);
  }
  .t {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.st {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  &.done {
    background: var(--ok);
  }
  &.failed,
  &.limited {
    background: var(--bad);
  }
  &.running,
  &.waiting {
    background: var(--accent);
  }
}
@media (max-width: 900px) {
  .panel {
    left: 12px;
    width: auto;
    top: auto;
    max-height: 55%;
  }
  .legend {
    display: none;
  }
}
</style>
