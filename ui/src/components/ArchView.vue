<script setup lang="ts">
// Схема архитектуры проекта: колонки (клиенты → вход → сервисы → платформа → внешние системы),
// связи по типам, виды-вкладки, поиск, схема/список, масштаб. Источник — docs/architecture.json
// из базовой ветки; если его нет — каркас сканера (без ИИ). «Обновить с ИИ» — задача боту с PR.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { api } from '../lib/api'
import { goHome, select, store, toast } from '../lib/store'
import Icon from './Icon.vue'

interface ANode { id: string, label: string, sub?: string, column: string, kind: string, repo?: string, manual?: boolean }
interface AEdge { from: string, to: string, type: string, label?: string }
interface AView { id: string, title: string, edgeTypes?: string[], kinds?: string[], nodes?: string[] }
interface Arch { title?: string, columns: { id: string, title: string }[], nodes: ANode[], edges: AEdge[], views?: AView[], error?: string }

const d = ref<{ repo: string, ref: string, sha: string, saved: Arch | null, scan: Arch } | null>(null)
const loading = ref(false)
const err = ref('')
const useScan = ref(false)
const viewId = ref('all')
const mode = ref<'schema' | 'list'>('schema')
const q = ref('')
const zoom = ref(1)
const focus = ref<string | null>(null)
const hover = ref<string | null>(null)

async function load(fresh = false) {
  loading.value = true; err.value = ''
  try {
    d.value = await api(`/api/arch?repo=${encodeURIComponent(store.curRepo)}${fresh ? '&fresh' : ''}`)
    useScan.value = !d.value!.saved || !!d.value!.saved.error
  }
  catch (e: any) { err.value = e.message }
  finally { loading.value = false }
}
onMounted(() => load())
watch(() => store.curRepo, () => { viewId.value = 'all'; focus.value = null; load() })

const arch = computed<Arch | null>(() => (d.value ? (useScan.value ? d.value.scan : d.value.saved) : null))
const views = computed<AView[]>(() => {
  const v = arch.value?.views || []
  return v.some(x => x.id === 'all') ? v : [{ id: 'all', title: 'Общая карта' }, ...v]
})
const view = computed(() => views.value.find(v => v.id === viewId.value) || views.value[0])

// ---------- что показать в этом виде ----------
const shown = computed(() => {
  const a = arch.value
  if (!a)
    return { nodes: [] as ANode[], edges: [] as AEdge[] }
  const byId = new Map(a.nodes.map(n => [n.id, n]))
  let edges = a.edges.filter(e => byId.has(e.from) && byId.has(e.to))
  let ids: Set<string>
  const v = view.value
  if (v?.edgeTypes?.length) {
    edges = edges.filter(e => v.edgeTypes!.includes(e.type))
    ids = new Set(edges.flatMap(e => [e.from, e.to]))
  }
  else if (v?.kinds?.length) {
    const core = new Set(a.nodes.filter(n => v.kinds!.includes(n.kind)).map(n => n.id))
    edges = edges.filter(e => core.has(e.from) || core.has(e.to))
    ids = new Set([...core, ...edges.flatMap(e => [e.from, e.to])])
  }
  else if (v?.nodes?.length) {
    ids = new Set(v.nodes)
    edges = edges.filter(e => ids.has(e.from) && ids.has(e.to))
  }
  else {
    ids = new Set(a.nodes.map(n => n.id))
  }
  return { nodes: a.nodes.filter(n => ids.has(n.id)), edges }
})

// ---------- раскладка: колонки, порядок по соседям слева (меньше пересечений) ----------
const W = 250; const H = 54; const GX = 160; const GY = 18; const PAD = 28; const TOP = 52
const layout = computed(() => {
  const a = arch.value
  const pos = new Map<string, { x: number, y: number, col: number }>()
  if (!a)
    return { pos, cols: [] as { title: string, x: number }[], w: 0, h: 0 }
  const order = [...a.columns.map(c => c.id), ...new Set(shown.value.nodes.map(n => n.column).filter(c => !a.columns.some(x => x.id === c)))]
  const cols = order.map(id => ({ id, title: a.columns.find(c => c.id === id)?.title || id, nodes: shown.value.nodes.filter(n => n.column === id) })).filter(c => c.nodes.length)
  const nb = new Map<string, string[]>()
  for (const e of shown.value.edges) {
    nb.set(e.from, [...(nb.get(e.from) || []), e.to]); nb.set(e.to, [...(nb.get(e.to) || []), e.from])
  }
  const rank = new Map<string, number>()
  cols.forEach((c, ci) => {
    if (ci > 0) {
      const score = (n: ANode) => {
        const r = (nb.get(n.id) || []).map(x => rank.get(x)).filter((x): x is number => x !== undefined)
        return r.length ? r.reduce((s, x) => s + x, 0) / r.length : Number.POSITIVE_INFINITY
      }
      c.nodes = c.nodes.map((n, i) => ({ n, s: score(n), i })).sort((p, q) => (p.s === q.s ? p.i - q.i : p.s - q.s)).map(x => x.n)
    }
    c.nodes.forEach((n, i) => rank.set(n.id, i / Math.max(1, c.nodes.length - 1)))
  })
  const maxN = Math.max(...cols.map(c => c.nodes.length))
  const colH = maxN * (H + GY) - GY
  cols.forEach((c, ci) => {
    const h = c.nodes.length * (H + GY) - GY
    const y0 = TOP + (colH - h) / 2
    c.nodes.forEach((n, i) => pos.set(n.id, { x: PAD + ci * (W + GX), y: y0 + i * (H + GY), col: ci }))
  })
  return {
    pos,
    cols: cols.map((c, ci) => ({ title: c.title, x: PAD + ci * (W + GX) + W / 2 })),
    w: PAD * 2 + cols.length * (W + GX) - GX,
    h: TOP + colH + PAD,
  }
})

function path(e: AEdge) {
  const a = layout.value.pos.get(e.from); const b = layout.value.pos.get(e.to)
  if (!a || !b)
    return ''
  const ay = a.y + H / 2; const by = b.y + H / 2
  if (a.col === b.col) { // в одной колонке — дугой справа
    const x = a.x + W
    return `M${x},${ay} C${x + 60},${ay} ${x + 60},${by} ${x},${by}`
  }
  const fwd = a.col < b.col
  const x1 = fwd ? a.x + W : a.x; const x2 = fwd ? b.x : b.x + W
  const dx = Math.max(50, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1)
  return `M${x1},${ay} C${x1 + dx},${ay} ${x2 - dx},${by} ${x2},${by}`
}

// ---------- подсветка ----------
const active = computed(() => hover.value || focus.value)
const near = computed(() => {
  const id = active.value
  if (!id)
    return null
  return new Set([id, ...shown.value.edges.flatMap(e => (e.from === id ? [e.to] : e.to === id ? [e.from] : []))])
})
const hit = (n: ANode) => !q.value || `${n.label} ${n.sub || ''}`.toLowerCase().includes(q.value.toLowerCase())
const dimNode = (n: ANode) => (near.value ? !near.value.has(n.id) : !hit(n))
const dimEdge = (e: AEdge) => (active.value ? e.from !== active.value && e.to !== active.value : !!q.value)

const EDGE: Record<string, { label: string, color: string }> = {
  http: { label: 'HTTP', color: 'hsl(218 85% 66%)' },
  data: { label: 'Данные', color: 'hsl(182 60% 48%)' },
  event: { label: 'События', color: 'hsl(40 90% 58%)' },
  metrics: { label: 'Метрики', color: 'hsl(262 70% 68%)' },
}
const KIND: Record<string, { label: string, color: string }> = {
  client: { label: 'Клиент', color: 'hsl(220 8% 35%)' },
  gateway: { label: 'Вход', color: 'hsl(182 60% 42%)' },
  service: { label: 'Сервис', color: 'hsl(222 80% 58%)' },
  neighbor: { label: 'Соседний репозиторий', color: 'hsl(262 70% 58%)' },
  storage: { label: 'Хранилище', color: 'hsl(150 60% 45%)' },
  queue: { label: 'Очередь', color: 'hsl(40 90% 52%)' },
  observability: { label: 'Наблюдаемость', color: 'hsl(190 70% 45%)' },
  external: { label: 'Внешняя система', color: 'hsl(355 70% 55%)' },
}
const edgeColor = (t: string) => EDGE[t]?.color || 'var(--muted)'
const kindColor = (k: string) => KIND[k]?.color || 'var(--muted)'
const usedEdges = computed(() => Object.keys(EDGE).filter(t => shown.value.edges.some(e => e.type === t)))
const usedKinds = computed(() => Object.keys(KIND).filter(k => shown.value.nodes.some(n => n.kind === k)))

// список: узел → куда ходит и кто ходит к нему
const label = (id: string) => arch.value?.nodes.find(n => n.id === id)?.label || id
const outOf = (id: string) => shown.value.edges.filter(e => e.from === id)
const inTo = (id: string) => shown.value.edges.filter(e => e.to === id)
const focused = computed(() => shown.value.nodes.find(n => n.id === focus.value) || null)

function onWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey)
    return
  e.preventDefault()
  zoom.value = Math.min(2, Math.max(0.4, +(zoom.value * Math.exp(-e.deltaY * 0.002)).toFixed(2)))
}
// при открытии и смене вида — вписать по ширине (не крупнее 100%)
const canvas = ref<HTMLElement>()
watch(() => [layout.value.w, mode.value, viewId.value, useScan.value], async () => {
  await nextTick()
  const w = canvas.value?.clientWidth
  if (w && layout.value.w)
    zoom.value = Math.max(0.4, Math.min(1, +((w - 16) / layout.value.w).toFixed(2)))
})
const step = (k: number) => { zoom.value = Math.min(2, Math.max(0.4, +(zoom.value + k).toFixed(2))) }

const busy = ref(false)
async function aiUpdate() {
  busy.value = true
  try {
    const r = await api<{ ids: string[] }>('/api/arch/ai', { repo: store.curRepo })
    toast('Бот проверит схему по коду и принесёт PR')
    select(r.ids[0])
  }
  catch (e: any) { toast(e.message) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="arch">
    <header class="top">
      <button
        class="btn ghost icon"
        title="Назад (Esc)"
        @click="goHome"
      >
        <icon name="back" />
      </button>
      <div class="ttl">
        <h2>Архитектура</h2>
        <span class="small">Из чего состоит {{ store.curRepo.split('/')[1] }} и как части связаны между собой</span>
      </div>
      <span class="spacer" />
      <button
        class="btn ghost sm"
        :disabled="loading"
        title="Заново прочитать репозиторий"
        @click="load(true)"
      >
        <icon
          name="refresh"
          :size="14"
        />Пересканировать
      </button>
      <button
        class="btn primary sm"
        :disabled="busy || !d"
        @click="aiUpdate"
      >
        {{ d?.saved ? 'Обновить с ИИ' : 'Создать с ИИ' }}
      </button>
    </header>

    <div
      v-if="d"
      class="src small"
    >
      <template v-if="d.saved && !d.saved.error">
        <div class="seg">
          <button
            :class="{ on: !useScan }"
            @click="useScan = false"
          >
            Из репозитория
          </button>
          <button
            :class="{ on: useScan }"
            @click="useScan = true"
          >
            Черновик сканера
          </button>
        </div>
        <span><code>docs/architecture.json</code> · {{ d.ref.replace('origin/', '') }} @ {{ d.sha }}</span>
      </template>
      <span v-else-if="d.saved?.error">⚠ {{ d.saved.error }} — показан черновик сканера.</span>
      <span v-else>В репозитории схемы ещё нет — это черновик сканера (без ИИ). «Создать с ИИ» — бот проверит по коду, допишет связи и принесёт PR с <code>docs/architecture.json</code>.</span>
    </div>

    <div class="views">
      <button
        v-for="v in views"
        :key="v.id"
        class="chip"
        :class="{ on: view?.id === v.id }"
        @click="viewId = v.id; focus = null"
      >
        {{ v.title }}
      </button>
    </div>

    <div class="board">
      <div class="tools">
        <label class="find"><icon
          name="search"
          :size="14"
        /><input
          v-model="q"
          placeholder="Найти узел…"
          spellcheck="false"
        ></label>
        <span class="spacer" />
        <div class="seg">
          <button
            :class="{ on: mode === 'schema' }"
            @click="mode = 'schema'"
          >
            Схема
          </button>
          <button
            :class="{ on: mode === 'list' }"
            @click="mode = 'list'"
          >
            Список
          </button>
        </div>
        <div
          v-if="mode === 'schema'"
          class="zoom"
        >
          <button @click="step(-0.1)">
            −
          </button><span>{{ Math.round(zoom * 100) }}%</span><button @click="step(0.1)">
            +
          </button>
        </div>
      </div>

      <div
        v-if="err"
        class="msg"
      >
        {{ err }}
      </div>
      <div
        v-else-if="loading && !d"
        class="msg"
      >
        Читаю репозиторий…
      </div>
      <div
        v-else-if="arch && !shown.nodes.length"
        class="msg"
      >
        В этом виде пусто
      </div>

      <div
        v-else-if="mode === 'schema' && arch"
        ref="canvas"
        class="canvas"
        @wheel="onWheel"
        @click.self="focus = null"
      >
        <div
          class="sized"
          :style="{ width: `${layout.w * zoom}px`, height: `${layout.h * zoom}px` }"
        >
          <div
            class="plane"
            :style="{ width: `${layout.w}px`, height: `${layout.h}px`, transform: `scale(${zoom})` }"
            @click.self="focus = null"
          >
            <span
              v-for="c in layout.cols"
              :key="c.title"
              class="colh"
              :style="{ left: `${c.x}px` }"
            >{{ c.title }}</span>
            <svg
              class="edges"
              :width="layout.w"
              :height="layout.h"
            >
              <defs>
                <marker
                  v-for="(v, t) in EDGE"
                  :id="`ar-${t}`"
                  :key="t"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                ><path
                  d="M0,0 L10,5 L0,10 z"
                  :fill="v.color"
                /></marker>
              </defs>
              <path
                v-for="(e, i) in shown.edges"
                :key="i"
                :d="path(e)"
                class="edge"
                :class="{ dim: dimEdge(e), on: active && !dimEdge(e) }"
                :stroke="edgeColor(e.type)"
                :marker-end="`url(#ar-${EDGE[e.type] ? e.type : 'http'})`"
              ><title>{{ label(e.from) }} → {{ label(e.to) }}{{ e.label ? ` · ${e.label}` : '' }}</title></path>
            </svg>
            <button
              v-for="n in shown.nodes"
              :key="n.id"
              class="node"
              :class="{ dim: dimNode(n), sel: focus === n.id }"
              :style="{ left: `${layout.pos.get(n.id)?.x}px`, top: `${layout.pos.get(n.id)?.y}px`, width: `${W}px`, height: `${H}px`, '--k': kindColor(n.kind) }"
              @click="focus = focus === n.id ? null : n.id"
              @mouseenter="hover = n.id"
              @mouseleave="hover = null"
            >
              <b>{{ n.label }}</b>
              <small v-if="n.sub">{{ n.sub }}</small>
            </button>
          </div>
        </div>
      </div>

      <div
        v-else-if="arch"
        class="list"
      >
        <template
          v-for="c in arch.columns"
          :key="c.id"
        >
          <h4 v-if="shown.nodes.some(n => n.column === c.id)">
            {{ c.title }}
          </h4>
          <div
            v-for="n in shown.nodes.filter(n => n.column === c.id && hit(n))"
            :key="n.id"
            class="li"
            :style="{ '--k': kindColor(n.kind) }"
          >
            <div class="nm">
              <b>{{ n.label }}</b><small>{{ n.sub }}</small>
            </div>
            <div class="links">
              <span
                v-for="(e, i) in outOf(n.id)"
                :key="`o${i}`"
                :style="{ color: edgeColor(e.type) }"
              >→ {{ label(e.to) }}</span>
              <span
                v-for="(e, i) in inTo(n.id)"
                :key="`i${i}`"
                class="in"
              >← {{ label(e.from) }}</span>
            </div>
          </div>
        </template>
      </div>

      <div
        v-if="focused && mode === 'schema'"
        class="info"
      >
        <b>{{ focused.label }}</b>
        <small>{{ KIND[focused.kind]?.label || focused.kind }}{{ focused.sub ? ` · ${focused.sub}` : '' }}</small>
        <a
          v-if="focused.repo"
          :href="`https://github.com/${focused.repo}`"
          target="_blank"
          class="small"
        >{{ focused.repo }} ↗</a>
        <span
          v-for="(e, i) in outOf(focused.id)"
          :key="`o${i}`"
          class="small"
        >→ {{ label(e.to) }} <i>{{ EDGE[e.type]?.label || e.type }}{{ e.label ? ` · ${e.label}` : '' }}</i></span>
        <span
          v-for="(e, i) in inTo(focused.id)"
          :key="`i${i}`"
          class="small"
        >← {{ label(e.from) }} <i>{{ EDGE[e.type]?.label || e.type }}</i></span>
      </div>

      <footer class="legend">
        <span
          v-for="t in usedEdges"
          :key="t"
          class="pill"
        ><i
          class="ln"
          :style="{ background: EDGE[t].color }"
        />{{ EDGE[t].label }}</span>
        <span class="sep" />
        <span
          v-for="k in usedKinds"
          :key="k"
        ><i
          class="bar"
          :style="{ background: KIND[k].color }"
        />{{ KIND[k].label }}</span>
        <span class="spacer" />
        <span class="hint">Ctrl + колесо — масштаб</span>
      </footer>
    </div>
  </div>
</template>

<style scoped lang="scss">
.arch {
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
  .ttl {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  h2 {
    margin: 0;
    font-size: 20px;
  }
}
.src {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.views {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text);
  border-radius: 999px;
  padding: 6px 14px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  &.on {
    border-color: var(--accent);
    color: var(--accent-text);
    background: var(--accent-soft);
  }
}
.board {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--sunk);
  overflow: hidden;
}
.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  background: var(--card);
}
.find {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 300px;
  max-width: 50%;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--muted);
  input {
    border: 0;
    background: transparent;
    padding: 7px 0;
    width: 100%;
    &:focus {
      border: 0;
      outline: none;
    }
  }
}
.zoom {
  display: flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 10px;
  button {
    all: unset;
    cursor: pointer;
    padding: 4px 10px;
  }
  span {
    font-size: 12.5px;
    min-width: 44px;
    text-align: center;
  }
}
.msg {
  margin: auto;
  color: var(--muted);
}
.canvas {
  flex: 1;
  overflow: auto;
}
.sized {
  position: relative;
  margin: 0 auto;
}
.plane {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
}
.colh {
  position: absolute;
  top: 18px;
  transform: translateX(-50%);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}
.edges {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
.edge {
  fill: none;
  stroke-width: 1.4;
  opacity: 0.85;
  transition: opacity 0.15s;
  &.dim {
    opacity: 0.1;
  }
  &.on {
    stroke-width: 2.2;
    opacity: 1;
  }
}
.node {
  all: unset;
  box-sizing: border-box;
  position: absolute;
  display: grid;
  align-content: center;
  gap: 1px;
  padding: 0 12px 0 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  cursor: pointer;
  transition: opacity 0.15s, box-shadow 0.15s;
  &::before {
    content: '';
    position: absolute;
    left: 6px;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 2px;
    background: var(--k);
  }
  b {
    font-size: 13.5px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  small {
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  &:hover,
  &.sel {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--k) 55%, transparent);
  }
  &.dim {
    opacity: 0.3;
  }
}
.list {
  flex: 1;
  overflow: auto;
  padding: 12px 16px;
  h4 {
    margin: 14px 0 6px;
    font-size: 11.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
}
.li {
  display: grid;
  grid-template-columns: minmax(0, 260px) minmax(0, 1fr);
  gap: 14px;
  padding: 8px 10px 8px 14px;
  margin-bottom: 6px;
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--k);
  border-radius: 10px;
  .nm {
    display: grid;
    small {
      color: var(--muted);
      font-size: 12px;
    }
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 12.5px;
    align-content: center;
    .in {
      color: var(--muted);
    }
  }
}
.info {
  position: absolute;
  right: 12px;
  top: 60px;
  width: 260px;
  max-height: 60%;
  overflow: auto;
  display: grid;
  gap: 4px;
  padding: 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
  i {
    color: var(--muted);
    font-style: normal;
  }
}
.legend {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  background: var(--card);
  font-size: 12px;
  color: var(--muted);
  span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .pill {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 10px;
    color: var(--text);
  }
  .ln {
    width: 14px;
    height: 2px;
  }
  .bar {
    width: 3px;
    height: 12px;
    border-radius: 2px;
  }
  .sep {
    width: 1px;
    height: 14px;
    background: var(--line);
  }
}
</style>
