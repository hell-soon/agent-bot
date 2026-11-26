<script setup lang="ts">
// Граф проекта (как в Obsidian): файлы и импорты из кода базовой ветки, без ИИ.
// Уровни: слайсы/папки или файлы. FSD — слои сверху вниз (app → shared), нарушения правил слоёв красным.
// Слой «Работа бота» подсвечивает файлы, которые бот правил (все задачи или одна).
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, triggerRef, watch } from 'vue'
import { api, ls as storage } from '../lib/api'
import { STATUS } from '../lib/format'
import { goHome, select, store } from '../lib/store'
import Icon from './Icon.vue'

interface CEdge { from: string, to: string, bad?: string }
interface BotRun { id: string, title: string, status: string, ai: string, at: number, files: string[] }
interface Data { repo: string, ref: string, sha: string, files: string[], edges: CEdge[], fsd: { root: string, layers: string[], segmented: string[] } | null, bot: BotRun[], error?: string }
interface GNode extends SimulationNodeDatum { id: string, label: string, files: string[], r: number, color: string, ins: number, layer: number, anchor?: 'start' | 'end' | 'middle', parent?: string }
type GLink = SimulationLinkDatum<GNode> & { w: number, bad: string[] }

const d = ref<Data | null>(null)
const loading = ref(false)
const err = ref('')
const f = reactive({
  level: 'groups' as 'groups' | 'files',
  layout: 'layers' as 'layers' | 'net',
  bot: false,
  task: '',
  bad: false,
  q: '',
})
// настройки вида — запоминаются в браузере
const OPT0 = {
  labels: 'auto' as 'auto' | 'all' | 'none',
  edgeAlpha: 0.16,
  hoverOnly: false,
  nodeSize: 1,
  spacing: 1,
  perRow: 9,
  hideOther: false,
  hideHubs: true,
  hubPct: 30,
}
const opt = reactive({
  ...OPT0,
  ...(() => {
    try { return JSON.parse(storage.get('bot:graph') || '{}') }
    catch { return {} }
  })(),
})
watch(opt, () => storage.set('bot:graph', JSON.stringify(opt)), { deep: true })
const showOpt = ref(false)
const picked = ref<GNode | null>(null)
const hover = ref<GNode | null>(null)

async function load(fresh = false) {
  loading.value = true; err.value = ''
  try {
    const r = await api<Data>(`/api/codegraph?repo=${encodeURIComponent(store.curRepo)}${fresh ? '&fresh' : ''}`)
    if (!d.value || d.value.repo !== r.repo)
      f.layout = r.fsd ? 'layers' : 'net' // FSD — слоями, остальное — сетью
    d.value = r
  }
  catch (e: any) { err.value = e.message }
  finally { loading.value = false }
}
watch(() => store.curRepo, () => { picked.value = null; fstack.value = []; expanded.value = []; f.task = ''; load() })

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
  folderOf = new Map(files.map(x => [
    x,
    key(x, depth.get(x)!),
  ]))
}
// раскрытые по месту слайсы/папки: вместо узла-группы — её файлы, в том же слое
const expanded = ref<string[]>([])
function groupOf(file: string) {
  if (f.level === 'files')
    return file
  const g = groupKey(file)
  return expanded.value.includes(g)
    ? file
    : g
}
function groupKey(file: string) {
  const fsd = d.value?.fsd
  if (fsd && file.startsWith(fsd.root)) {
    const [layer, slice] = file.slice(fsd.root.length).split('/')
    if (fsd.layers.includes(layer)) {
      return !slice || slice.includes('.')
        ? `${fsd.root}${layer}`
        : `${fsd.root}${layer}/${slice}`
    }
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
const LAYER_HUE: Record<string, number> = {
  app: 280,
  processes: 300,
  pages: 330,
  layouts: 0,
  widgets: 25,
  features: 210,
  entities: 150,
  kit: 110,
  shared: 45,
}
const bare = (l: string) => l.replace(/^\d+[.\-_]/, '')
const layerColor = (l: string) => `hsl(${LAYER_HUE[bare(l)] ?? hue(l)} 62% 56%)`
function colorOf(id: string) {
  const l = layerOf(id)
  return l >= 0
    ? layerColor(d.value!.fsd!.layers[l])
    : `hsl(${hue(id.split('/')[0])} 50% 55%)`
}
function shortName(id: string) {
  const fsd = d.value?.fsd
  const s = fsd && id.startsWith(fsd.root)
    ? id.slice(fsd.root.length)
    : id
  return f.level === 'files' || /\.[a-z0-9]+$/i.test(id)
    ? s.split('/').slice(-2).join('/')
    : s
}
const SEGMENTS = new Set([
  'ui',
  'model',
  'lib',
  'api',
  'config',
  'types',
  'store',
  'stores',
  'utils',
  'hooks',
  'composables',
])
// подпись на узле: в слоях слой и так виден — только имя слайса / файла; index.* — по папке («map/index.ts» → «map»)
function nodeLabel(n: GNode) {
  const parts = n.id.split('/')
  let t = f.layout === 'layers' && n.layer >= 0
    ? parts.at(-1)!
    : n.label
  if ((f.level === 'files' || n.parent) && /^index\.[^.]+$/.test(parts.at(-1)!)) {
    t = parts.at(-2) || t
    // сегменты слайса (ui, model, lib…) сами по себе ни о чём не говорят — с именем слайса: «LegalPolicy/ui»
    if (SEGMENTS.has(t) && parts.length > 2)
      t = `${parts.at(-3)}/${t}`
  }
  const max = focusId.value ? 28 : 18
  return t.length > max
    ? `${t.slice(0, max - 1)}…`
    : t
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
const all = shallowRef<{ byId: Map<string, GNode>, links: { a: string, b: string, w: number, bad: string[] }[] }>({
  byId: new Map(),
  links: [],
})
const hubs = ref<string[]>([])
// доля узлов, которые должны использовать модуль, чтобы он считался общим (у файлов — втрое меньше: их сотни)
const hubShare = computed(() => opt.hubPct / 100 / (f.level === 'files'
  ? 3
  : 1))

// ---------- фокус: узел в центре, слева — кто использует, справа — что импортирует ----------
const fstack = ref<string[]>([])
const fNodes = shallowRef<GNode[]>([])
const fLinks = shallowRef<GLink[]>([])
const focusId = computed(() => fstack.value.at(-1) || '')
function buildFocus() {
  const id = focusId.value
  const c = all.value.byId.get(id)
  if (!c) { fNodes.value = []; fLinks.value = []; return }
  const center: GNode = {
    ...c,
    x: 0,
    y: 0,
    fx: 0,
    fy: 0,
    anchor: 'middle',
    r: Math.max(c.r, 9),
  }
  const ins = all.value.links.filter(l => l.b === id); const outs = all.value.links.filter(l => l.a === id)
  const order = (a: GNode, b: GNode) => (a.layer - b.layer) || a.id.localeCompare(b.id)
  const left = ins.map(l => all.value.byId.get(l.a)!).filter(Boolean).sort(order)
  const leftIds = new Set(left.map(n => n.id))
  const right = outs.map(l => all.value.byId.get(l.b)!).filter(n => n && !leftIds.has(n.id)).sort(order)
  const PER = 18; const DY = 30; const X0 = 300; const DXC = 250
  const place = (list: GNode[], side: -1 | 1) => list.map((n, i) => {
    const col = Math.floor(i / PER); const inCol = Math.min(PER, list.length - col * PER)
    const x = side * (X0 + col * DXC); const y = ((i % PER) - (inCol - 1) / 2) * DY
    return {
      ...n,
      x,
      y,
      fx: x,
      fy: y,
      anchor: side < 0
        ? 'end'
        : 'start',
      r: Math.min(n.r, 8),
    } as GNode
  })
  const ns = [
    center,
    ...place(left, -1),
    ...place(right, 1),
  ]
  const by = new Map(ns.map(n => [n.id, n]))
  fNodes.value = ns
  fLinks.value = [
    ...ins,
    ...outs,
  ].filter(l => by.has(l.a) && by.has(l.b)).map(l => ({
    source: by.get(l.a)!,
    target: by.get(l.b)!,
    w: l.w,
    bad: l.bad,
  }))
  picked.value = center
  setTimeout(fit, 20)
}
function focusOn(id: string) {
  if (focusId.value !== id)
    fstack.value = [...fstack.value, id]
  buildFocus()
}
function focusBack() {
  fstack.value = fstack.value.slice(0, -1)
  if (fstack.value.length) {
    buildFocus()
  }
  else { picked.value = null; setTimeout(fit, 20) }
}
function focusExit() { fstack.value = []; picked.value = null; setTimeout(fit, 20) }
// на экране: фокус или весь граф
const shownNodes = computed(() => (focusId.value ? fNodes.value : nodes.value))
const shownLinks = computed(() => (focusId.value ? fLinks.value : links.value))
let sim: Simulation<GNode, GLink> | null = null

function rebuild() {
  const data = d.value
  if (!data)
    return
  const old = new Map(nodes.value.map(n => [n.id, n]))
  hover.value = null // старый узел исчезнет — pointerleave уже не придёт
  buildFolders(data.files)
  const groups = new Map<string, GNode>()
  for (const file of data.files) {
    const g = groupOf(file)
    let n = groups.get(g)
    if (!n) {
      const o = old.get(g)
      n = {
        id: g,
        label: shortName(g),
        files: [],
        r: 4,
        color: colorOf(g),
        ins: 0,
        layer: layerOf(g),
        x: o?.x,
        y: o?.y,
        parent: g === file && f.level === 'groups'
          ? groupKey(file)
          : undefined,
      }
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
  let ns = [
    ...groups.values(),
  ]
  let lks = [
    ...ls.values(),
  ]
  { // без одиночек — у них нет связей, а «Вписать» из-за них мельчит граф
    const linked = new Set(lks.flatMap(l => [l.source as string, l.target as string]))
    ns = ns.filter(n => linked.has(n.id))
  }
  if (opt.hideOther && data.fsd) { // скрыть «вне слоёв»
    ns = ns.filter(n => n.layer >= 0)
    const keep = new Set(ns.map(n => n.id))
    lks = lks.filter(l => keep.has(l.source as string) && keep.has(l.target as string))
  }
  if (f.bad) {
    lks = lks.filter(l => l.bad.length)
    const keep = new Set(lks.flatMap(l => [l.source as string, l.target as string]))
    ns = ns.filter(n => keep.has(n.id))
  }
  const small = f.level === 'files'
  for (const n of ns) {
    n.ins = importers.get(n.id)?.size || 0
    const fileNode = small || !!n.parent
    n.r = ((fileNode ? 3 : 5) + Math.sqrt(n.ins) * (fileNode ? 1.6 : 2.4)) * opt.nodeSize
  }
  // полный граф (с хабами) — для фокуса и панели
  all.value = {
    byId: new Map(ns.map(n => [n.id, n])),
    links: lks.map(l => ({
      a: l.source as string,
      b: l.target as string,
      w: l.w,
      bad: l.bad,
    })),
  }
  // хабы — модули, которые импортирует большая часть проекта: на общем графе их связи — клубок
  hubs.value = ns.length > 12
    ? ns.filter(n => n.ins / ns.length >= hubShare.value).map(n => n.id)
    : []
  if (opt.hideHubs && hubs.value.length && !f.bad) {
    const h = new Set(hubs.value)
    ns = ns.filter(n => !h.has(n.id))
    lks = lks.filter(l => !h.has(l.source as string) && !h.has(l.target as string))
  }
  const first = !old.size
  sim?.stop()
  if (f.layout === 'layers') {
    // без силовой раскладки концы связей остаются id — заменить на узлы
    const byId = new Map(ns.map(n => [n.id, n]))
    for (const l of lks) {
      l.source = byId.get(typeof l.source === 'string'
        ? l.source
        : (l.source as GNode).id)!
      l.target = byId.get(typeof l.target === 'string'
        ? l.target
        : (l.target as GNode).id)!
    }
    lks = lks.filter(l => l.source && l.target)
    layoutLayers(ns, lks)
    nodes.value = ns; links.value = lks
    setTimeout(fit, 30)
    return
  }
  bands.value = []
  for (const n of ns) { n.fx = null; n.fy = null }
  nodes.value = ns; links.value = lks
  const fsd = !!data.fsd
  const layers = data.fsd?.layers.length || 6
  sim?.stop()
  sim = forceSimulation<GNode, GLink>(ns)
    .force('link', forceLink<GNode, GLink>(lks).id(x => x.id).distance((small ? 40 : 110) * opt.spacing).strength(small ? 0.2 : 0.08))
    .force('charge', forceManyBody<GNode>().strength(x => (-(small ? 30 : 260) - x.r * (small ? 4 : 10)) * opt.spacing))
    .force('center', forceCenter(0, 0))
    .force('x', forceX(0).strength(0.03))
    // FSD: слои полосами сверху вниз (app → shared)
    .force('y', forceY<GNode>(x => (fsd && x.layer >= 0
      ? (x.layer - (layers - 1) / 2) * (small ? 260 : 210)
      : 0)).strength(x => (fsd && x.layer >= 0
      ? 0.35
      : 0.03)))
    .force('collide', forceCollide<GNode>(x => x.r + (small ? 3 : 16)))
    .on('tick', () => { triggerRef(nodes); triggerRef(links) })
  if (first)
    setTimeout(fit, 1100)
}
watch([
  d,
  () => f.level,
  () => expanded.value,
  () => f.bad,
  () => f.layout,
  () => opt.hideOther,
  () => opt.nodeSize,
  () => opt.spacing,
  () => opt.perRow,
  () => opt.hideHubs,
  () => opt.hubPct,
], () => {
  rebuild(); if (fstack.value.length)
    buildFocus()
})

// ---------- раскладка «Слои»: полоса на слой, ряды, порядок по соседям (меньше пересечений) ----------
const bands = shallowRef<{ title: string, y: number, color: string }[]>([])
function layoutLayers(ns: GNode[], lks: GLink[]) {
  const small = f.level === 'files'
  const sp = opt.spacing
  const DX = (small ? 110 : 168) * sp; const DY = (small ? 50 : 62) * sp; const GAP = (small ? 70 : 80) * sp; const PER = Math.max(3, Math.round(small
    ? opt.perRow * 1.6
    : opt.perRow))
  const fsd = d.value?.fsd
  const rows = new Map<number, GNode[]>()
  for (const n of ns) {
    rows.set(n.layer, [
      ...(rows.get(n.layer) || []),
      n,
    ])
  }
  const keys = [
    ...rows.keys(),
  ].sort((a, b) => (a < 0
    ? 1
    : b < 0
      ? -1
      : a - b)) // вне слоёв — внизу
  const nb = new Map<string, string[]>()
  for (const l of lks) {
    const a = (l.source as GNode).id; const b = (l.target as GNode).id
    nb.set(a, [
      ...(nb.get(a) || []),
      b,
    ]); nb.set(b, [
      ...(nb.get(b) || []),
      a,
    ])
  }
  const xOf = new Map<string, number>()
  const place = () => {
    for (const k of keys) {
      const row = rows.get(k)!
      row.forEach((n, i) => xOf.set(n.id, (i % PER) - (Math.min(PER, row.length) - 1) / 2))
    }
  }
  for (const k of keys) rows.get(k)!.sort((a, b) => b.ins - a.ins || a.id.localeCompare(b.id))
  place()
  for (let pass = 0; pass < 4; pass++) { // по соседям: вниз, потом вверх
    for (const k of pass % 2
      ? [...keys].reverse()
      : keys) {
      const row = rows.get(k)!
      const score = (n: GNode) => {
        const xs = (nb.get(n.id) || []).map(x => xOf.get(x)).filter((x): x is number => x !== undefined)
        return xs.length
          ? xs.reduce((s, x) => s + x, 0) / xs.length
          : 0
      }
      row.sort((a, b) => score(a) - score(b))
      place()
    }
  }
  let y = 0
  const out: typeof bands.value = []
  for (const k of keys) {
    const row = rows.get(k)!
    const lines = Math.ceil(row.length / PER)
    out.push({
      title: k >= 0 && fsd
        ? bare(fsd.layers[k])
        : 'вне слоёв',
      y,
      color: k >= 0 && fsd
        ? layerColor(fsd.layers[k])
        : 'var(--muted)',
    })
    row.forEach((n, i) => {
      const line = Math.floor(i / PER)
      const inLine = Math.min(PER, row.length - line * PER)
      n.x = n.fx = ((i % PER) - (inLine - 1) / 2) * DX + (line % 2
        ? DX / 4
        : 0)
      n.y = n.fy = y + line * DY
    })
    y += (lines - 1) * DY + DY + GAP
  }
  bands.value = out
}
const bandX = computed(() => Math.min(0, ...nodes.value.map(n => n.x || 0)) - 110)
// связь: в слоях — плавная дуга сверху вниз, в сети — прямая
function edgePath(l: GLink) {
  const a = l.source as GNode; const b = l.target as GNode
  const x1 = a.x || 0; const y1 = a.y || 0; const x2 = b.x || 0; const y2 = b.y || 0
  if (focusId.value) { // фокус: слева направо
    const mx = (x1 + x2) / 2
    return `M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2},${y2}`
  }
  if (f.layout !== 'layers')
    return `M${x1},${y1}L${x2},${y2}`
  if (Math.abs(y1 - y2) < 8) // в одном ряду — дугой над рядом, а не по узлам
    return `M${x1},${y1}Q${(x1 + x2) / 2},${y1 - 24 - Math.abs(x2 - x1) * 0.18} ${x2},${y2}`
  const my = (y1 + y2) / 2
  return `M${x1},${y1}C${x1},${my} ${x2},${my} ${x2},${y2}`
}

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
// Esc в фокусе — шаг назад (раньше, чем общий Esc «на главную»)
function onEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !focusId.value || (e.target as HTMLElement).closest('input, textarea, select'))
    return
  e.stopImmediatePropagation(); e.preventDefault()
  focusBack()
}
onMounted(() => window.addEventListener('keydown', onEsc, true))
onBeforeUnmount(() => { sim?.stop(); ro?.disconnect(); window.removeEventListener('keydown', onEsc, true) })

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
  drag = {
    node,
    sx: e.clientX,
    sy: e.clientY,
    vx: view.x,
    vy: view.y,
    moved: false,
  }
  if (node && f.layout === 'net') { node.fx = node.x; node.fy = node.y; sim?.alphaTarget(0.3).restart() }
  e.stopPropagation()
}
function move(e: PointerEvent) {
  if (!drag)
    return
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3)
    drag.moved = true
  if (drag.node) {
    if (f.layout === 'net') {
      const p = toWorld(e.clientX, e.clientY)
      drag.node.fx = p.x; drag.node.fy = p.y
    }
  }
  else { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy }
}
// ⇧/⌥-клик — раскрыть слайс по месту (или свернуть обратно), обычный — фокус
function toggleExpand(n: GNode) {
  const key = n.parent || n.id
  if (expanded.value.includes(key))
    expanded.value = expanded.value.filter(x => x !== key)
  else if (f.level === 'groups' && !n.parent && n.files.length > 1)
    expanded.value = [...expanded.value, key]
}
function up(e?: PointerEvent) {
  if (!drag)
    return
  if (drag.node) {
    if (f.layout === 'net') { drag.node.fx = null; drag.node.fy = null; sim?.alphaTarget(0) }
    if (!drag.moved && (e?.shiftKey || e?.altKey) && !focusId.value)
      toggleExpand(drag.node)
    else if (!drag.moved)
      focusOn(drag.node.id)
  }
  else if (!drag.moved && !focusId.value) { picked.value = null }
  drag = null
}
function fit() {
  const ns = shownNodes.value
  if (!ns.length)
    return
  const xs = ns.map(n => n.x || 0); const ys = ns.map(n => n.y || 0)
  if (focusId.value) // место под подписи по бокам
    xs.push(Math.min(...xs) - 180, Math.max(...xs) + 180)
  else if (f.layout === 'layers')
    xs.push(bandX.value)
  const w = Math.max(...xs) - Math.min(...xs) + 160; const h = Math.max(...ys) - Math.min(...ys) + 200 // снизу — место под легенду
  const side = picked.value ? 340 : 0 // справа — панель узла
  view.k = Math.min(2, Math.max(0.15, Math.min((size.w - side) / w, size.h / h)))
  view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k - side / 2; view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k
}

// ---------- подсветка ----------
const focus = computed(() => hover.value || (focusId.value ? null : picked.value))
const near = computed(() => {
  const n = focus.value
  if (!n)
    return null
  const s = new Set([n.id])
  for (const l of shownLinks.value) {
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
function dim(n: GNode) {
  return near.value
    ? !near.value.has(n.id)
    : (f.bot && !botHit(n)) || (!!f.q && !match(n))
}
function showLabel(n: GNode) {
  if (focusId.value)
    return true
  if (opt.labels === 'none')
    return n === focus.value || n.id === picked.value?.id
  if (opt.labels === 'all')
    return true
  if (f.layout === 'layers' && f.level === 'groups') // авто: слайсы — все, файлы — крупные и при приближении
    return true
  if (n === focus.value || near.value?.has(n.id) || (f.q && match(n)) || (f.bot && botHit(n)))
    return true
  return f.level === 'groups'
    ? n.r > 10 * opt.nodeSize || view.k > 1.1
    : n.r > 9 * opt.nodeSize || view.k > 1.6
}
// подписи без наложений: кандидаты по важности (выбранный, наведённый, крупные), налезающая — не ставится
const labelSet = computed(() => {
  const k = view.k; const fs = 11 / k
  const cand = shownNodes.value.filter(showLabel)
  const prio = (n: GNode) => (n.id === picked.value?.id || n === hover.value
    ? 1e6
    : 0) + (n.id === focusId.value
    ? 1e6
    : 0) + n.r
  cand.sort((a, b) => prio(b) - prio(a))
  const grid = new Map<string, number[][]>(); const C = 60 / k
  const ok = new Set<string>()
  for (const n of cand) {
    const w = nodeLabel(n).length * fs * 0.62; const h = fs * 1.25
    const x = n.x || 0; const y = n.y || 0
    const x0 = n.anchor === 'end'
      ? x - n.r - 6 - w
      : n.anchor === 'start'
        ? x + n.r + 6
        : x - w / 2
    const y0 = n.anchor === 'start' || n.anchor === 'end'
      ? y - h / 2
      : y + n.r + 2 / k
    const box = [x0, y0, x0 + w, y0 + h]
    const cells: string[] = []
    for (let gx = Math.floor(box[0] / C); gx <= Math.floor(box[2] / C); gx++) {
      for (let gy = Math.floor(box[1] / C); gy <= Math.floor(box[3] / C); gy++) cells.push(`${gx},${gy}`)
    }
    const hit = cells.some(c => (grid.get(c) || []).some(b => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]))
    if (hit && prio(n) < 1e6)
      continue
    ok.add(n.id)
    for (const c of cells) {
      grid.set(c, [
        ...(grid.get(c) || []),
        box,
      ])
    }
  }
  return ok
})
// связи бледные; ярко — только у наведённого/выбранного узла (hot) и нарушения
const linkHot = (l: GLink) => !!focus.value && ((l.source as GNode).id === focus.value.id || (l.target as GNode).id === focus.value.id)
// «только при наведении» прячет и нарушения — для них есть кнопка «Нарушения слоёв»
function linkDim(l: GLink) {
  return focus.value
    ? !linkHot(l)
    : !focusId.value && (f.bot || (opt.hoverOnly && !f.bad))
}

// ---------- панель и легенда ----------
// панель — по полному графу (с хабами)
function outOf(id: string) {
  return all.value.links.filter(l => l.a === id).map(l => ({
    node: all.value.byId.get(l.b)!,
    w: l.w,
    bad: l.bad,
  })).filter(x => x.node)
}
function inTo(id: string) {
  return all.value.links.filter(l => l.b === id).map(l => ({
    node: all.value.byId.get(l.a)!,
    w: l.w,
    bad: l.bad,
  })).filter(x => x.node)
}
function badOf(id: string) {
  return [
    ...outOf(id),
    ...inTo(id),
  ].flatMap(l => l.bad)
}
const tasksOf = (n: GNode) => botRuns.value.filter(r => r.files.some(x => n.files.includes(x)))
const totalBad = computed(() => (d.value?.edges || []).filter(e => e.bad).length)
const legend = computed(() => {
  const fsd = d.value?.fsd
  if (fsd) {
    return fsd.layers.map(l => ({
      t: bare(l),
      color: layerColor(l),
    }))
  }
  const c = new Map<string, number>()
  for (const n of nodes.value) c.set(n.id.split('/')[0], (c.get(n.id.split('/')[0]) || 0) + 1)
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => ({ t, color: `hsl(${hue(t)} 50% 55%)` }))
})
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
      <div class="seg">
        <button
          :class="{ on: f.layout === 'layers' }"
          :disabled="!d?.fsd"
          :title="d?.fsd ? 'Слои FSD полосами' : 'Только для FSD'"
          @click="f.layout = 'layers'"
        >
          Слои
        </button>
        <button
          :class="{ on: f.layout === 'net' }"
          title="Сеть, как в Obsidian: узлы можно таскать"
          @click="f.layout = 'net'"
        >
          Сеть
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
      <span
        v-if="f.level === 'groups'"
        class="small tip"
      >⇧-клик — раскрыть</span>
      <span class="spacer" />
      <button
        class="btn ghost sm"
        :class="{ on: showOpt }"
        @click="showOpt = !showOpt"
      >
        <icon
          name="gear"
          :size="14"
        />Вид
      </button>
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
        @pointerup="up($event)"
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
          <g v-if="f.layout === 'layers' && !focusId">
            <g
              v-for="b in bands"
              :key="b.title"
              class="band"
            >
              <line
                :x1="bandX - 10"
                :x2="-bandX + 10"
                :y1="b.y - 34"
                :y2="b.y - 34"
              />
              <text
                :x="bandX"
                :y="b.y + 4"
                :fill="b.color"
                :font-size="12 / Math.sqrt(view.k)"
              >{{ b.title }}</text>
            </g>
          </g>
          <path
            v-for="(l, i) in shownLinks"
            :key="i"
            class="link"
            :class="{ dim: linkDim(l), hot: linkHot(l), bad: l.bad.length }"
            :d="edgePath(l)"
            :stroke-width="(linkHot(l) || l.bad.length ? 1.8 : Math.min(2.2, 0.6 + Math.sqrt(l.w) * 0.3)) / Math.sqrt(view.k)"
            :marker-end="linkHot(l) ? 'url(#cg-ar)' : undefined"
            :style="linkHot(l) || linkDim(l) ? undefined : focusId ? { opacity: 0.55 } : l.bad.length ? { opacity: Math.min(0.9, opt.edgeAlpha * 3.5) } : { opacity: opt.edgeAlpha }"
          />
          <g
            v-for="n in shownNodes"
            :key="n.id"
            class="node"
            :class="{ dim: dim(n), sel: n.id === picked?.id, bot: f.bot && botHit(n), exp: !!n.parent }"
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
              v-if="labelSet.has(n.id)"
              :class="{ center: n.id === focusId }"
              :x="n.anchor === 'start' ? n.r + 6 : n.anchor === 'end' ? -n.r - 6 : 0"
              :y="n.anchor === 'start' || n.anchor === 'end' ? 4 / view.k : n.r + (n.id === focusId ? 15 : 12) / view.k"
              :text-anchor="n.anchor || 'middle'"
              :font-size="(n.id === focusId ? 13 : 11) / view.k"
            >{{ nodeLabel(n) }}</text>
          </g>
        </g>
      </svg>

      <div
        v-if="err || (loading && !d) || (d && !shownNodes.length)"
        class="empty"
      >
        <b>{{ err ? 'Не получилось прочитать код' : loading ? 'Читаю код…' : f.bad ? 'Нарушений нет' : 'Связей не нашлось' }}</b>
        <span class="small">{{ err || (f.bad ? 'Все импорты соблюдают правила слоёв.' : '') }}</span>
      </div>

      <div
        v-if="focusId"
        class="crumbs"
        :class="{ narrow: picked }"
      >
        <button
          class="btn sm"
          @click="focusBack"
        >
          ← Назад
        </button>
        <button
          class="btn ghost sm"
          @click="focusExit"
        >
          Весь граф
        </button>
        <span class="path small">
          <template
            v-for="(x, i) in fstack"
            :key="i"
          ><span v-if="i"> › </span><b v-if="i === fstack.length - 1">{{ shortName(x) }}</b><a
            v-else
            @click="fstack = fstack.slice(0, i + 1); buildFocus()"
          >{{ shortName(x) }}</a></template>
        </span>
        <span class="small hint">слева — кто использует · справа — что импортирует · клик — шаг дальше</span>
      </div>
      <div
        v-else-if="expanded.length || (hubs.length && opt.hideHubs && !f.bad)"
        class="crumbs plain"
      >
        <div
          v-if="expanded.length"
          class="hubs small"
        >
          Раскрыто:
          <span
            v-for="x in expanded"
            :key="x"
            class="exp"
          >{{ shortName(x) }}<button
            title="Свернуть"
            @click="expanded = expanded.filter(y => y !== x)"
          >×</button></span>
          <button
            v-if="expanded.length > 1"
            class="btn ghost sm"
            @click="expanded = []"
          >
            Свернуть все
          </button>
        </div>
        <div
          v-if="hubs.length && opt.hideHubs && !f.bad"
          class="hubs small"
        >
          Скрыты общие модули:
          <a
            v-for="h in hubs"
            :key="h"
            title="Открыть в фокусе"
            @click="focusOn(h)"
          >{{ shortName(h) }}</a>
          <button
            class="btn ghost sm"
            @click="opt.hideHubs = false"
          >
            Показать
          </button>
        </div>
      </div>

      <div
        v-if="showOpt"
        class="opts"
      >
        <div class="row">
          <span>Подписи</span>
          <div class="seg">
            <button
              v-for="[v, l] in ([['auto', 'Авто'], ['all', 'Все'], ['none', 'Нет']] as const)"
              :key="v"
              :class="{ on: opt.labels === v }"
              @click="opt.labels = v"
            >
              {{ l }}
            </button>
          </div>
        </div>
        <label class="row"><span>Яркость связей</span><input
          v-model.number="opt.edgeAlpha"
          type="range"
          min="0.03"
          max="0.6"
          step="0.01"
        ></label>
        <label class="row"><span>Связи только при наведении</span><input
          v-model="opt.hoverOnly"
          type="checkbox"
        ></label>
        <label class="row"><span>Размер узлов</span><input
          v-model.number="opt.nodeSize"
          type="range"
          min="0.5"
          max="2"
          step="0.1"
        ></label>
        <label class="row"><span>Расстояние</span><input
          v-model.number="opt.spacing"
          type="range"
          min="0.6"
          max="2.2"
          step="0.1"
        ></label>
        <label
          v-if="f.layout === 'layers'"
          class="row"
        ><span>Узлов в ряду · {{ f.level === 'files' ? Math.round(opt.perRow * 1.6) : opt.perRow }}</span><input
          v-model.number="opt.perRow"
          type="range"
          min="3"
          max="20"
          step="1"
        ></label>
        <label class="row"><span>Скрыть общие модули</span><input
          v-model="opt.hideHubs"
          type="checkbox"
        ></label>
        <label
          v-if="opt.hideHubs"
          class="row"
        ><span>Общий — если используют ≥ {{ Math.round(hubShare * 100) }}%</span><input
          v-model.number="opt.hubPct"
          type="range"
          min="10"
          max="70"
          step="5"
        ></label>
        <label
          v-if="d?.fsd"
          class="row"
        ><span>Скрыть «вне слоёв»</span><input
          v-model="opt.hideOther"
          type="checkbox"
        ></label>
        <button
          class="btn ghost sm"
          @click="Object.assign(opt, OPT0)"
        >
          Сбросить
        </button>
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
        <h4>{{ f.level === 'files' || picked.parent ? 'Файл' : d?.fsd ? 'Слайс' : 'Папка' }}</h4>
        <code class="path">{{ picked.id }}</code>
        <div
          v-if="f.level === 'groups' && (picked.parent || picked.files.length > 1)"
          class="acts"
        >
          <button
            class="btn sm"
            @click="toggleExpand(picked); focusExit()"
          >
            {{ picked.parent ? `Свернуть ${shortName(picked.parent)}` : expanded.includes(picked.id) ? 'Свернуть' : 'Раскрыть по месту' }}
          </button>
        </div>
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
          :key="l.node.id"
          class="item"
          @click="focusOn(l.node.id)"
        >
          <i :style="{ background: l.node.color }" /><span class="t">{{ shortName(l.node.id) }}</span><span class="small">×{{ l.w }}</span>
        </button>
        <span
          v-if="!outOf(picked.id).length"
          class="small"
        >—</span>
        <h4>Используют</h4>
        <button
          v-for="l in inTo(picked.id)"
          :key="l.node.id"
          class="item"
          @click="focusOn(l.node.id)"
        >
          <i :style="{ background: l.node.color }" /><span class="t">{{ shortName(l.node.id) }}</span><span class="small">×{{ l.w }}</span>
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
  fill: none;
  stroke: var(--muted);
  opacity: 0.16;
  transition: opacity 0.15s;
  &.bad {
    stroke: var(--bad);
    opacity: 0.55;
  }
  &.hot {
    stroke: var(--accent);
    opacity: 0.9;
  }
  &.dim {
    opacity: 0.04;
  }
}
.tip {
  color: var(--muted);
}
.panel .acts {
  display: flex;
  gap: 6px;
  margin: 4px 0;
}
.crumbs .exp {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--text);
  button {
    all: unset;
    cursor: pointer;
    color: var(--muted);
    padding: 0 3px;
  }
}
.node.exp circle {
  stroke: color-mix(in srgb, var(--text) 45%, transparent);
  stroke-dasharray: 2 2;
}
.crumbs.narrow {
  right: 344px;
}
.crumbs {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  z-index: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  pointer-events: none;
  > * {
    pointer-events: auto;
  }
  .path {
    padding: 4px 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--card) 90%, transparent);
    a {
      cursor: pointer;
      color: var(--accent-text);
    }
  }
  .hint {
    color: var(--muted);
  }
  .hubs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 6px 4px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--card) 90%, transparent);
    border: 1px solid var(--line);
    color: var(--muted);
    a {
      cursor: pointer;
      color: var(--accent-text);
    }
  }
}
.opts {
  position: absolute;
  top: 56px;
  left: 12px;
  z-index: 2;
  width: 280px;
  display: grid;
  gap: 10px;
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  font-size: 12.5px;
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  input[type='range'] {
    width: 120px;
    accent-color: var(--accent);
  }
  .btn {
    justify-self: start;
  }
}
.band {
  line {
    stroke: var(--line);
    stroke-dasharray: 3 5;
  }
  text {
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    text-anchor: end;
    dominant-baseline: middle;
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
    pointer-events: none;
    &.center {
      font-weight: 700;
    }
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
