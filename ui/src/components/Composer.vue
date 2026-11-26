<script setup lang="ts">
import type { Mode } from '../lib/store'
import { computed, nextTick, ref, watch } from 'vue'
import { aiName, modKey } from '../lib/format'
import { bothAi, enabledSkills, loadCodex, MODES, setMode, startJob, store } from '../lib/store'
import { useAttach } from '../lib/upload'
import AttachList from './AttachList.vue'
import Icon from './Icon.vue'

const c = store.compose
const at = useAttach()
const fileIn = ref<HTMLInputElement>()
const dragging = ref(false)
const m = computed(() => MODES[c.mode])
const MAIN: Mode[] = ['task', 'issue', 'feature', 'bug', 'pr']
const EXTRA: Mode[] = ['queue', 'chain', 'triage', 'tickets']
const extraOpen = ref(false)
const ai = ref('') // '' — как по умолчанию
const model = ref('')
const refs = ref<string[]>([])
const err = ref('')
const busy = ref(false)
const ta = ref<HTMLTextAreaElement>()
const issuePick = ref('')

const taskAi = computed(() => ai.value || (store.cfg.ai === 'codex'
  ? 'codex'
  : 'claude'))
const otherAi = computed(() => (store.cfg.ai === 'codex'
  ? 'claude'
  : 'codex'))
const models = computed(() => taskAi.value === 'codex'
  ? (store.codexInfo?.models || []).map(x => [x.slug, x.name])
  : [
      ['haiku', 'Haiku'],
      ['sonnet', 'Sonnet'],
      ['opus', 'Opus'],
    ])
watch(taskAi, () => {
  model.value = ''; if (taskAi.value === 'codex' && !store.codexInfo)
    loadCodex()
})
const otherRepos = computed(() => store.repos.filter(r => r !== store.curRepo))
const issues = computed(() => store.gh.issues.slice().sort((a, b) => a.number - b.number))
const ready = computed(() => issues.value.filter(i => i.labels.includes('ready-for-agent')).map(i => i.number))
const size = (i: any) => i.labels.find((l: string) => l.startsWith('size:'))

function fit() {
  const t = ta.value; if (!t)
    return; t.style.height = 'auto'; t.style.height = `${Math.min(260, t.scrollHeight)}px`
}
watch(() => c.draft, () => nextTick(fit))
watch(() => c.focusTick, async () => { await nextTick(); ta.value?.focus(); fit() })
watch(() => c.mode, () => {
  err.value = ''
  issuePick.value = ''
})
if (c.prPick === '' && store.gh.prs[0])
  c.prPick = String(store.gh.prs[0].number)
watch(() => store.gh.prs, (p) => {
  if (!c.prPick && p[0])
    c.prPick = String(p[0].number)
})

function togglePick(n: number, on: boolean) {
  c.picked = on
    ? [...c.picked, n]
    : c.picked.filter(x => x !== n)
}

async function submit() {
  err.value = ''
  if (at.busy.value)
    return (err.value = 'Файлы ещё загружаются')
  const b: Record<string, any> = { model: model.value, ai: ai.value, refs: refs.value, files: at.paths() }
  const text = c.draft.trim()
  if (c.mode === 'issue') {
    if (!issuePick.value)
      return (err.value = 'Выберите issue'); Object.assign(b, { kind: 'issue', issue: issuePick.value })
  }
  else if (c.mode === 'queue' || c.mode === 'chain') {
    if (!c.picked.length)
      return (err.value = 'Отметьте issue'); Object.assign(b, { kind: c.mode, issues: c.picked })
  }
  else if (c.mode === 'pr') {
    if (!c.prPick)
      return; Object.assign(b, { kind: 'pr', pr: c.prPick, text })
  }
  else {
    if (!text && !at.atts.value.length && ['task', 'feature', 'bug'].includes(c.mode))
      return (err.value = 'Опишите задачу'); Object.assign(b, { kind: c.mode, text: text || 'Посмотри вложения.' })
  }
  busy.value = true
  try { await startJob(b); at.clear() }
  catch (e: any) { err.value = e.message }
  finally { busy.value = false }
}
// Подсказки скиллов: «/» в начале строки ввода → список, ↑↓ / Tab / ↵ — выбрать
const slashSel = ref(0)
const slash = computed(() => {
  const m = c.draft.match(/^\/([\w:-]*)$/)
  if (!m)
    return []
  const q = m[1].toLowerCase()
  return enabledSkills.value
    .filter(s => s.name.toLowerCase().includes(q) || (q.length > 2 && s.description.toLowerCase().includes(q)))
    .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || Number(!a.manual) - Number(!b.manual))
    .slice(0, 8)
})
watch(slash, () => { slashSel.value = 0 })
function pickSlash(name: string) {
  c.draft = `/${name} `
  nextTick(() => {
    ta.value?.focus()
    fit()
  })
}
function onKey(e: KeyboardEvent) {
  if (slash.value.length && (e.target as HTMLElement).tagName === 'TEXTAREA') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = slash.value.length
      slashSel.value = (slashSel.value + (e.key === 'ArrowDown'
        ? 1
        : -1) + n) % n
      return
    }
    if ((e.key === 'Tab' || e.key === 'Enter') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      pickSlash(slash.value[slashSel.value].name)
      return
    }
    if (e.key === 'Escape') {
      c.draft += ' '
      return
    }
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <form
    class="composer"
    :class="{ drag: dragging }"
    @submit.prevent="submit"
    @keydown="onKey"
    @paste="at.onPaste"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop="dragging = false; at.onDrop($event)"
  >
    <select
      v-if="c.mode === 'pr' && store.gh.prs.length"
      v-model="c.prPick"
    >
      <option
        v-for="p in store.gh.prs"
        :key="p.number"
        :value="String(p.number)"
      >
        #{{ p.number }} {{ p.title }}
      </option>
    </select>
    <div
      v-if="c.mode === 'pr' && !store.gh.prs.length"
      class="small pad"
    >
      Открытых PR нет.
    </div>

    <template v-if="c.mode === 'issue' || c.mode === 'queue' || c.mode === 'chain'">
      <div
        v-if="issues.length"
        class="pick"
      >
        <label
          v-for="i in issues"
          :key="i.number"
        >
          <input
            v-if="c.mode === 'issue'"
            v-model="issuePick"
            type="radio"
            name="issue"
            :value="String(i.number)"
          >
          <input
            v-else
            type="checkbox"
            :checked="c.picked.includes(i.number)"
            @change="togglePick(i.number, ($event.target as HTMLInputElement).checked)"
          >
          <span class="num">#{{ i.number }}</span>
          <span>{{ i.title }}<span
            v-if="i.labels.includes('ready-for-agent')"
            class="tag"
          >готово</span><span
            v-if="i.labels.includes('in-progress')"
            class="tag"
          >в работе</span><span
            v-if="size(i)"
            class="tag"
          >{{ size(i) }}</span></span>
        </label>
      </div>
      <div
        v-else
        class="small pad"
      >
        Открытых issue нет — заведите на GitHub или через «Фичу».
      </div>
      <div
        v-if="c.mode !== 'issue' && issues.length"
        class="chips"
      >
        <span class="small">{{ c.picked.length ? `Порядок: ${c.picked.map((n) => `#${n}`).join(' → ')}` : '' }}</span>
        <span class="spacer" />
        <button
          type="button"
          class="btn ghost sm"
          @click="c.picked = [...ready]"
        >
          Все готовые
        </button>
      </div>
    </template>

    <textarea
      v-if="m.ph !== undefined"
      ref="ta"
      v-model="c.draft"
      rows="2"
      :placeholder="`${m.ph}${c.mode === 'task' ? ' · «/» — скиллы' : ''}`"
      @input="fit"
    />
    <attach-list
      :files="at.atts.value"
      :busy="at.busy.value"
      removable
      @remove="at.remove"
    />
    <div
      v-if="slash.length"
      class="slash"
    >
      <button
        v-for="(s, i) in slash"
        :key="s.id"
        type="button"
        class="sk"
        :class="{ on: i === slashSel }"
        @mousemove="slashSel = i"
        @click="pickSlash(s.name)"
      >
        <span class="n">/{{ s.name }}</span><span class="d">{{ s.description }}</span>
      </button>
    </div>

    <div class="chips">
      <button
        v-for="k in MAIN"
        :key="k"
        type="button"
        class="chip"
        :class="{ on: c.mode === k }"
        @click="setMode(k); c.focusTick++"
      >
        <icon
          :name="k"
          :size="15"
        />{{ MODES[k].name }}
      </button>
      <template v-if="c.showMore">
        <button
          v-for="k in EXTRA"
          :key="k"
          type="button"
          class="chip"
          :class="{ on: c.mode === k }"
          @click="setMode(k)"
        >
          <icon
            :name="k"
            :size="15"
          />{{ MODES[k].name }}
        </button>
      </template>
      <button
        v-else
        type="button"
        class="chip"
        @click="c.showMore = true"
      >
        <icon
          name="more"
          :size="15"
        />Ещё
      </button>
    </div>
    <div
      v-if="m.hint"
      class="hint"
    >
      {{ m.hint }}
    </div>

    <div
      v-if="extraOpen"
      class="extra"
    >
      <div
        v-if="bothAi"
        class="row"
      >
        <span class="small">ИИ</span>
        <select v-model="ai">
          <option value="">
            {{ aiName(store.cfg.ai) }} (по умолчанию)
          </option><option :value="otherAi">
            {{ aiName(otherAi) }}
          </option>
        </select>
        <span class="small">Модель</span>
        <select v-model="model">
          <option value="">
            {{ taskAi === 'codex' ? 'как в настройках' : 'авто' }}
          </option><option
            v-for="[v, l] in models"
            :key="v"
            :value="v"
          >
            {{ l }}
          </option>
        </select>
      </div>
      <template v-if="otherRepos.length">
        <div class="small">
          Подсмотреть в других репозиториях (только чтение)
        </div>
        <div class="pick refs">
          <label
            v-for="r in otherRepos"
            :key="r"
          ><input
            v-model="refs"
            type="checkbox"
            :value="r"
          ><span>{{ r }}</span></label>
        </div>
      </template>
    </div>

    <div
      v-if="err"
      class="err"
    >
      {{ err }}
    </div>
    <div class="bottom">
      <button
        type="button"
        class="btn ghost sm"
        @click="extraOpen = !extraOpen"
      >
        Параметры
      </button>
      <button
        type="button"
        class="btn ghost sm icon"
        title="Приложить картинку или файл (можно вставить ⌘V или перетащить)"
        @click="fileIn?.click()"
      >
        <icon
          name="clip"
          :size="15"
        />
      </button>
      <input
        ref="fileIn"
        type="file"
        multiple
        hidden
        @change="at.add(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''"
      >
      <span class="spacer" />
      <span class="small">{{ modKey }}↵</span>
      <button
        class="btn primary"
        :disabled="busy"
      >
        Запустить
      </button>
    </div>
  </form>
</template>

<style scoped lang="scss">
.composer {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: var(--shadow);
  padding: 14px 14px 12px;
  display: grid;
  gap: 10px;
  &:focus-within {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  }
  &.drag {
    border-color: var(--accent);
    border-style: dashed;
  }
}
textarea {
  background: transparent;
  border: 0;
  padding: 4px;
  min-height: 52px;
  resize: none;
  font-size: 15px;
  &:focus {
    border: 0;
  }
}
.pad {
  padding: 4px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border-radius: 99px;
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  transition: 0.12s;
  &:hover {
    color: var(--text);
    background: var(--sunk);
  }
  &.on {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent-text);
  }
}
.hint {
  font-size: 12.5px;
  color: var(--muted);
  padding: 0 4px;
}
.pick {
  max-height: 230px;
  overflow: auto;
  border-radius: 12px;
  background: var(--sunk);
  padding: 4px;
  label {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 7px 9px;
    border-radius: 8px;
    cursor: pointer;
    &:hover {
      background: var(--card);
    }
  }
  input {
    margin-top: 4px;
    accent-color: var(--accent);
  }
  .num {
    color: var(--muted);
    min-width: 32px;
    font-variant-numeric: tabular-nums;
  }
}
.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--card);
  color: var(--muted);
  margin-left: 6px;
  white-space: nowrap;
  border: 1px solid var(--line);
}
.extra {
  display: grid;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
  background: var(--sunk);
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  select {
    width: auto;
    background: var(--card);
  }
  .refs {
    background: var(--card);
    max-height: 120px;
  }
}
.err {
  color: var(--bad);
  font-size: 13px;
  padding: 0 4px;
}
.bottom {
  display: flex;
  align-items: center;
  gap: 8px;
}
@media (max-width: 640px) {
  .bottom .small {
    display: none;
  }
}
.slash {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1px;
  padding: 4px;
  border-radius: 12px;
  background: var(--sunk);
  max-height: 290px;
  overflow: auto;
  .sk {
    min-width: 0;
    overflow: hidden;
    display: flex;
    gap: 10px;
    align-items: baseline;
    text-align: left;
    padding: 7px 10px;
    border-radius: 8px;
    &.on {
      background: var(--card);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    }
  }
  .n {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 500;
    color: var(--accent-text);
    white-space: nowrap;
  }
  .d {
    font-size: 12.5px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
}
</style>
