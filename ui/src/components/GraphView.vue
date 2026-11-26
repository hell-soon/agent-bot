<script setup lang="ts">
// Граф проекта (как в Obsidian): файлы и импорты из кода базовой ветки, без ИИ.
// Уровни: слайсы/папки или файлы. FSD — слои сверху вниз (app → shared), нарушения правил слоёв красным.
// Слой «Работа бота» подсвечивает файлы, которые бот правил (все задачи или одна).
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, triggerRef, watch } from 'vue'
import { api } from '../lib/api'
import { STATUS } from '../lib/format'
import { goHome, select, store } from '../lib/store'
import Icon from './Icon.vue'

interface CEdge { from: string, to: string, bad?: string }
interface BotRun { id: string, title: string, status: string, ai: string, at: number, files: string[] }
interface Data { ref: string, sha: string, files: string[], edges: CEdge[], fsd: { root: string, layers: string[], segmented: string[] } | null, bot: BotRun[], error?: string }
interface GNode extends SimulationNodeDatum { id: string, label: string, files: string[], r: number, color: string, ins: number, layer: number }
type GLink = SimulationLinkDatum<GNode> & { w: number, bad: string[] }

const d = ref<Data | null>(null)
const loading = ref(false)
const err = ref('')
const f = reactive({ level: 'groups' as 'groups' | 'files', bot: false, task: '', bad: false, q: '' })
const picked = ref<GNode | null>(null)
const hover = ref<GNode | null>(null)

async function load(fresh = false) {
  loading.value = true; err.value = ''
  try { d.value = await api<Data>(`/api/codegraph?repo=${encodeURIComponent(store.curRepo)}${fresh ? '&fresh' : ''}`) }
  catch (e: any) { err.value = e.message }
  finally { loading.value = false }
}
watch(() => store.curRepo, () => { picked.value = null; f.task = ''; load() })

// ---------- группы: слайс FSD или папка (большие папки дробятся глубже, пока в группе не ≤ 40 файлов) ----------
let folderOf = new Map<string, string>()
function buildFolders(files: string[]) {
  const key = (file: string, depth: number) => {
    const dir = file.split('/').slice(0, -1)
    return dir.slice(0, depth).join('/') || '(корень)'
  }
  const depth = new Map(files.map(x => [x, 2]))
  for (let round = 0; round < 3; round++) {
    const count = new Map<string, number>()
    for (const x of files) count.set(key(x, depth.get(x)!), (count.get(key(x, depth.get(x)!)) || 0) + 1)
    let split = false
    for (const x of files) {
      const k = key(x, depth.get(x)!)
      if (count.get(k)! > 40 && x.split('/').length - 1 > depth.get(x)!) { depth.set(x, depth.get(x)! + 1); split = true }
    }
    if (!split)
      break
  }
  folderOf = new Map(files.map(x => [x, key(x, depth.get(x)!)]))
}
function groupOf(file: string) {
  if (f.level === 'files')
    return file
  const fsd = d.value?.fsd
  if (fsd && file.startsWith(fsd.root)) {
    const [layer, slice] = file.slice(fsd.root.length).split('/')
    if (fsd.layers.includes(layer))
      return !slice || slice.includes('.') ? `${fsd.root}${layer}` : `${fsd.root}${layer}/${slice}`
  }
  return folderOf.get(file) || file
}
function layerOf(id: string) {
  const fsd = d.value?.fsd
  if (!fsd || !id.startsWith(fsd.root))
    return -1
  return fsd.layers.indexOf(id.slice(fsd.root.length).split('/')[0])
}
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
// цвет слоя — по имени (и для «02.features»)
const LAYER_HUE: Record<string, number> = { app: 280, processes: 300, pages: 330, layouts: 0, widgets: 25, features: 210, entities: 150, kit: 110, shared: 45 }
const bare = (l: string) => l.replace(/^\d+[.\-_]/, '')
const layerColor = (l: string) => `hsl(${LAYER_HUE[bare(l)] ?? hue(l)} 62% 56%)`
function colorOf(id: string) {
  const l = layerOf(id)
  return l >= 0 ? layerColor(d.value!.fsd!.layers[l]) : `hsl(${hue(id.split('/')[0])} 50% 55%)`
}
function shortName(id: string) {
  const fsd = d.value?.fsd
  const s = fsd && id.startsWith(fsd.root) ? id.slice(fsd.root.length) : id
  return f.level === 'files' ? s.split('/').slice(-2).join('/') : s
}

// ---------- работа бота ----------
const botRuns = computed(() => (d.value?.bot || []).slice().sort((a, b) => b.at - a.at))
const touched = computed(() => {
  const m = new Set<string>()
  for (const r of botRuns.value) {
    if (!f.task || r.id === f.task)
      r.files.forEach(x => m.add(x))
  }
  return m
})

// ---------- узлы и связи ----------
const nodes = shallowRef<GNode[]>([])
const links = shallowRef<GLink[]>([])
let sim: Simulation<GNode, GLink> | null = null

function rebuild() {
  const data = d.value
  if (!data)
    return
  const old = new Map(nodes.value.map(n => [n.id, n]))
  buildFolders(data.files)
  const groups = new Map<string, GNode>()
  for (const file of data.files) {
    const g = groupOf(file)
    let n = groups.get(g)
    if (!n) {
      const o = old.get(g)
      n = { id: g, label: shortName(g), files: [], r: 4, color: colorOf(g), ins: 0, layer: layerOf(g), x: o?.x, y: o?.y }
      groups.set(g, n)
    }
    n.files.push(file)
  }
  const ls = new Map<string, GLink>()
  const importers = new Map<string, Set<string>>()
  for (const e of data.edges) {
    const a = groupOf(e.from); const b = groupOf(e.to)
    if (a === b)
      continue
    const k = `${a}\n${b}`
    const l = ls.get(k) || { source: a, target: b, w: 0, bad: [] }
    l.w++
    if (e.bad)
      l.bad.push(`${e.from} → ${e.to}: ${e.bad}`)
    ls.set(k, l)
    importers.set(b, (importers.get(b) || new Set()).add(a))
  }
  let ns = [...groups.values()]
  let lks = [...ls.values()]
  { // без одиночек — у них нет связей, а «Вписать» из-за них мельчит граф
    const linked = new Set(lks.flatMap(l => [l.source as string, l.target as string]))
    ns = ns.filter(n => linked.has(n.id))
  }
  if (f.bad) {
    lks = lks.filter(l => l.bad.length)
    const keep = new Set(lks.flatMap(l => [l.source as string, l.target as string]))
    ns = ns.filter(n => keep.has(n.id))
  }
  const small = f.level === 'files'
  for (const n of ns) {
    n.ins = importers.get(n.id)?.size || 0
    n.r = (small ? 3 : 5) + Math.sqrt(n.ins) * (small ? 1.6 : 2.4)
  }
  const first = !old.size
  nodes.value = ns; links.value = lks
  const fsd = !!data.fsd
  const layers = data.fsd?.layers.length || 6
  sim?.stop()
  sim = forceSimulation<GNode, GLink>(ns)
    .force('link', forceLink<GNode, GLink>(lks).id(x => x.id).distance(small ? 40 : 110).strength(small ? 0.2 : 0.08))
    .force('charge', forceManyBody<GNode>().strength(x => -(small ? 30 : 260) - x.r * (small ? 4 : 10)))
    .force('center', forceCenter(0, 0))
    .force('x', forceX(0).strength(0.03))
    // FSD: слои полосами сверху вниз (app → shared)
    .force('y', forceY<GNode>(x => (fsd && x.layer >= 0 ? (x.layer - (layers - 1) / 2) * (small ? 260 : 210) : 0)).strength(x => (fsd && x.layer >= 0 ? 0.35 : 0.03)))
    .force('collide', forceCollide<GNode>(x => x.r + (small ? 3 : 16)))
    .on('tick', () => { triggerRef(nodes); triggerRef(links) })
  if (first)
    setTimeout(fit, 1100)
}
watch([d, () => f.level, () => f.bad], rebuild)

// ---------- вид ----------
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

function toWorld(cx: number, cy: number) {
  const b = svg.value!.getBoundingClientRect()
  return { x: (cx - b.left - size.w / 2 - view.x) / view.k, y: (cy - b.top - size.h / 2 - view.y) / view.k }
}
function onWheel(e: WheelEvent) {
  const b = svg.value!.getBoundingClientRect()
  const px = e.clientX - b.left - size.w / 2; const py = e.clientY - b.top - size.h / 2
  const k = Math.min(5, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0015)))
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
      picked.value = picked.value?.id === drag.node.id ? null : drag.node
  }
  else if (!drag.moved) { picked.value = null }
  drag = null
}
function fit() {
  const ns = nodes.value
  if (!ns.length)
    return
  const xs = ns.map(n => n.x || 0); const ys = ns.map(n => n.y || 0)
  const w = Math.max(...xs) - Math.min(...xs) + 140; const h = Math.max(...ys) - Math.min(...ys) + 140
  view.k = Math.min(2, Math.max(0.15, Math.min(size.w / w, size.h / h)))
  view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k; view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k
}

// ---------- подсветка ----------
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
const botHit = (n: GNode) => n.files.some(x => touched.value.has(x))
const match = (n: GNode) => !f.q || n.id.toLowerCase().includes(f.q.toLowerCase())
const dim = (n: GNode) => (near.value ? !near.value.has(n.id) : (f.bot && !botHit(n)) || (!!f.q && !match(n)))
function showLabel(n: GNode) {
  if (n === focus.value || near.value?.has(n.id) || (f.q && match(n)) || (f.bot && botHit(n)))
    return true
  return f.level === 'groups' ? n.r > 10 || view.k > 1.1 : n.r > 9 || view.k > 1.8
}
const linkDim = (l: GLink) => (focus.value ? (l.source as GNode).id !== focus.value.id && (l.target as GNode).id !== focus.value.id : f.bot)

// ---------- панель и легенда ----------
const outOf = (id: string) => links.value.filter(l => (l.source as GNode).id === id)
const inTo = (id: string) => links.value.filter(l => (l.target as GNode).id === id)
const badOf = (id: string) => [...outOf(id), ...inTo(id)].flatMap(l => l.bad)
const tasksOf = (n: GNode) => botRuns.value.filter(r => r.files.some(x => n.files.includes(x)))
const totalBad = computed(() => (d.value?.edges || []).filter(e => e.bad).length)
const legend = computed(() => {
  const fsd = d.value?.fsd
  if (fsd)
    return fsd.layers.map(l => ({ t: bare(l), color: layerColor(l) }))
  const c = new Map<string, number>()
  for (const n of nodes.value) c.set(n.id.split('/')[0], (c.get(n.id.split('/')[0]) || 0) + 1)
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => ({ t, color: `hsl(${hue(t)} 50% 55%)` }))
})
const ago = (t: number) => new Date(t).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
const nodeOf = (x: unknown) => x as GNode
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
      <h2>
        Граф проекта <span class="small">{{ store.curRepo.split('/')[1] }}<template v-if="d"> · {{ d.files.length }} файлов · {{ d.edges.length }} импортов · {{ d.ref.replace('origin/', '') }} @ {{ d.sha }}</template></span>
      </h2>
      <span class="spacer" />
      <button
        class="btn ghost sm"
        :disabled="loading"
        title="Заново прочитать код"
        @click="load(true)"
      >
        <icon
          name="refresh"
          :size="14"
        />Обновить
      </button>
    </header>

    <div class="tools">
      <input
        v-model="f.q"
        class="q"
        placeholder="Найти файл или папку"
        spellcheck="false"
      >
      <div class="seg">
        <button
          :class="{ on: f.level === 'groups' }"
          @click="f.level = 'groups'"
        >
          {{ d?.fsd ? 'Слайсы' : 'Папки' }}
        </button>
        <button
          :class="{ on: f.level === 'files' }"
          @click="f.level = 'files'"
        >
          Файлы
        </button>
      </div>
      <button
        v-if="d?.fsd || totalBad"
        class="tg"
        :class="{ on: f.bad, warn: totalBad }"
        title="Связи против правил FSD: импорт верхнего слоя, соседнего слайса или мимо index"
        @click="f.bad = !f.bad"
      >
        Нарушения слоёв · {{ totalBad }}
      </button>
      <button
        class="tg"
        :class="{ on: f.bot }"
        :disabled="!botRuns.length"
        :title="botRuns.length ? 'Подсветить файлы, которые правил бот' : 'Бот в этом репозитории ещё ничего не правил'"
        @click="f.bot = !f.bot"
      >
        Работа бота
      </button>
      <select
        v-if="f.bot"
        v-model="f.task"
      >
        <option value="">
          все задачи · {{ botRuns.length }}
        </option>
        <option
          v-for="r in botRuns"
          :key="r.id"
          :value="r.id"
        >
          {{ r.title.slice(0, 60) }}
        </option>
      </select>
      <span class="spacer" />
      <button
        class="btn ghost sm"
        @click="fit"
      >
        Вписать
      </button>
    </div>

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
        <defs>
          <marker
            id="cg-ar"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          ><path
            d="M0,0 L10,5 L0,10 z"
            class="arrow"
          /></marker>
        </defs>
        <g :transform="`translate(${size.w / 2 + view.x},${size.h / 2 + view.y}) scale(${view.k})`">
          <line
            v-for="(l, i) in links"
            :key="i"
            class="link"
            :class="{ dim: linkDim(l), bad: l.bad.length }"
            :x1="nodeOf(l.source).x"
            :y1="nodeOf(l.source).y"
            :x2="nodeOf(l.target).x"
            :y2="nodeOf(l.target).y"
            :stroke-width="(l.bad.length ? 2 : Math.min(3, 0.6 + Math.sqrt(l.w) * 0.35)) / Math.sqrt(view.k)"
            :marker-end="focus && !linkDim(l) ? 'url(#cg-ar)' : undefined"
          />
          <g
            v-for="n in nodes"
            :key="n.id"
            class="node"
            :class="{ dim: dim(n), sel: n.id === picked?.id, bot: f.bot && botHit(n) }"
            :transform="`translate(${n.x || 0},${n.y || 0})`"
            @pointerdown="down($event, n)"
            @pointerenter="hover = n"
            @pointerleave="hover = null"
          >
            <circle
              :r="n.r"
              :fill="n.color"
            />
            <text
              v-if="showLabel(n)"
              :y="n.r + 12 / view.k"
              :font-size="11 / view.k"
            >{{ n.label }}</text>
          </g>
        </g>
      </svg>

      <div
        v-if="err || (loading && !d) || (d && !nodes.length)"
        class="empty"
      >
        <b>{{ err ? 'Не получилось прочитать код' : loading ? 'Читаю код…' : f.bad ? 'Нарушений нет' : 'Связей не нашлось' }}</b>
        <span class="small">{{ err || (f.bad ? 'Все импорты соблюдают правила слоёв.' : '') }}</span>
      </div>

      <div
        v-if="legend.length"
        class="legend"
      >
        <span
          v-for="x in legend"
          :key="x.t"
        ><i :style="{ background: x.color }" />{{ x.t }}</span>
        <span v-if="d?.fsd"><i class="ln" />нарушение</span>
        <span v-if="f.bot"><i class="ring" />правил бот</span>
      </div>

      <aside
        v-if="picked"
        class="panel"
      >
        <h4>{{ f.level === 'files' ? 'Файл' : d?.fsd ? 'Слайс' : 'Папка' }}</h4>
        <code class="path">{{ picked.id }}</code>
        <p class="small">
          {{ picked.files.length > 1 ? `${picked.files.length} файлов · ` : '' }}используют {{ picked.ins }} · импортирует {{ outOf(picked.id).length }}
        </p>
        <template v-if="badOf(picked.id).length">
          <h4 class="bad-h">
            Нарушения
          </h4>
          <code
            v-for="b in badOf(picked.id).slice(0, 12)"
            :key="b"
            class="fl bad"
          >{{ b }}</code>
        </template>
        <h4>Импортирует</h4>
        <button
          v-for="l in outOf(picked.id)"
          :key="nodeOf(l.target).id"
          class="item"
          @click="picked = nodeOf(l.target)"
        >
          <i :style="{ background: nodeOf(l.target).color }" /><span class="t">{{ shortName(nodeOf(l.target).id) }}</span><span class="small">×{{ l.w }}</span>
        </button>
        <span
          v-if="!outOf(picked.id).length"
          class="small"
        >—</span>
        <h4>Используют</h4>
        <button
          v-for="l in inTo(picked.id)"
          :key="nodeOf(l.source).id"
          class="item"
          @click="picked = nodeOf(l.source)"
        >
          <i :style="{ background: nodeOf(l.source).color }" /><span class="t">{{ shortName(nodeOf(l.source).id) }}</span><span class="small">×{{ l.w }}</span>
        </button>
        <span
          v-if="!inTo(picked.id).length"
          class="small"
        >—</span>
        <template v-if="tasksOf(picked).length">
          <h4>Правил бот</h4>
          <button
            v-for="r in tasksOf(picked)"
            :key="r.id"
            class="item"
            @click="select(r.id)"
          >
            <span
              class="st"
              :class="r.status"
            /><span class="t">{{ r.title }}</span><span class="small">{{ ago(r.at) }} · {{ STATUS[r.status] || r.status }}</span>
          </button>
        </template>
        <template v-if="picked.files.length > 1">
          <h4>Файлы</h4>
          <code
            v-for="x in picked.files.slice(0, 40)"
            :key="x"
            class="fl"
          >{{ x.split('/').slice(-2).join('/') }}</code>
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
  gap: 10px;
}
.top {
  display: flex;
  align-items: center;
  gap: 8px;
  h2 {
    margin: 0;
    font-size: 17px;
    .small {
      font-weight: 400;
      margin-left: 6px;
    }
  }
}
.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  .q {
    width: 220px;
  }
  select {
    max-width: 280px;
  }
}
.tg {
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text);
  border-radius: 999px;
  padding: 5px 12px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  &.on {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  &.warn:not(.on) {
    border-color: color-mix(in srgb, var(--bad) 50%, var(--line));
    color: var(--bad);
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
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
.arrow {
  fill: var(--muted);
}
.link {
  stroke: color-mix(in srgb, var(--muted) 40%, transparent);
  transition: opacity 0.15s;
  &.bad {
    stroke: var(--bad);
    opacity: 0.9;
  }
  &.dim {
    opacity: 0.08;
  }
}
.node {
  cursor: pointer;
  transition: opacity 0.15s;
  circle {
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
    opacity: 0.15;
  }
  &.bot circle {
    stroke: var(--accent);
    stroke-width: 3;
  }
  &.sel circle {
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
    &.ln {
      width: 14px;
      height: 2px;
      border-radius: 0;
      background: var(--bad);
    }
    &.ring {
      background: transparent;
      border: 2px solid var(--accent);
    }
  }
}
.panel {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 12px;
  width: 320px;
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  h4 {
    margin: 8px 0 2px;
    font-size: 12px;
    color: var(--muted);
    font-weight: 600;
    &:first-child {
      margin-top: 0;
    }
    &.bad-h {
      color: var(--bad);
    }
  }
  .path {
    word-break: break-all;
    font-size: 12px;
  }
  p {
    margin: 0;
  }
  .fl {
    font-size: 11.5px;
    word-break: break-all;
    &.bad {
      color: var(--bad);
    }
  }
}
.item {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 8px;
  font-size: 12.5px;
  cursor: pointer;
  &:hover {
    background: var(--sunk);
  }
  i {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
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
