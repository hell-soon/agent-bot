<script setup lang="ts">
// Итог PR в задаче: состояние, проверки, ревью, файлы с diff и быстрые действия
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../lib/api'
import { startJob, store, toast } from '../lib/store'
import Icon from './Icon.vue'

interface Check { name: string, url?: string, state: 'ok' | 'fail' | 'run' | 'skip' }
interface File { name: string, status: string, add: number, del: number, patch: string }
interface Pr {
  number: number
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  conflicts: boolean
  review: 'approved' | 'changes' | null
  comments: number
  additions: number
  deletions: number
  changed: number
  checks: Check[]
  files: File[]
}
const props = defineProps<{ run: any }>()
const pr = ref<Pr | null>(null)
const failed = ref(false)
const open = ref<Record<string, boolean>>({})
const allFiles = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function load(fresh = false) {
  clearTimeout(timer)
  try {
    pr.value = (await api<{ pr: Pr | null }>(`/api/runs/${props.run.id}/pr${fresh ? '?fresh' : ''}`)).pr
    failed.value = !pr.value
  }
  catch { failed.value = true }
  // пока проверки идут — обновляем сами
  if (pr.value?.state === 'open' && pr.value.checks.some(c => c.state === 'run'))
    timer = setTimeout(() => load(true), 30000)
}
watch(() => [props.run.id, props.run.prUrl, props.run.status], () => load(true), { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

const sum = computed(() => {
  const c = pr.value?.checks || []
  return {
    ok: c.filter(x => x.state === 'ok').length,
    fail: c.filter(x => x.state === 'fail'),
    run: c.filter(x => x.state === 'run').length,
  }
})
const STATE = { open: 'Открыт', closed: 'Закрыт', merged: 'Слит' }
const busy = computed(() => ['running', 'queued'].includes(props.run.status))
const shown = computed(() => (allFiles.value ? pr.value?.files : pr.value?.files.slice(0, 8)) || [])

async function fix(text: '@ci' | '@conflicts') {
  try { await startJob({ kind: 'pr', pr: pr.value!.number, text, ai: props.run.ai, repo: props.run.repo || store.curRepo }) }
  catch (e: any) { toast(e.message) }
}
function lineClass(l: string) {
  return l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : ''
}
</script>

<template>
  <section
    v-if="pr"
    class="pr"
  >
    <header>
      <icon
        name="pr"
        :size="16"
      />
      <a
        :href="pr.url"
        target="_blank"
        class="num"
      >PR #{{ pr.number }}</a>
      <span
        class="pill"
        :class="pr.state"
      >{{ pr.draft && pr.state === 'open' ? 'Черновик' : STATE[pr.state] }}</span>
      <span class="stat"><b class="a">+{{ pr.additions }}</b> <b class="d">−{{ pr.deletions }}</b> · {{ pr.changed }} {{ pr.changed === 1 ? 'файл' : pr.changed < 5 ? 'файла' : 'файлов' }}</span>
      <span class="spacer" />
      <button
        class="btn ghost sm icon"
        title="Обновить"
        @click="load(true)"
      >
        <icon
          name="refresh"
          :size="14"
        />
      </button>
      <a
        class="btn sm"
        :href="pr.url"
        target="_blank"
      >На GitHub <icon
        name="ext"
        :size="13"
      /></a>
    </header>

    <div class="rows">
      <div
        v-if="pr.checks.length"
        class="row"
      >
        <span class="k">Проверки</span>
        <span class="v">
          <span
            v-if="sum.fail.length"
            class="c fail"
          ><icon
            name="x"
            :size="13"
          />{{ sum.fail.length }} упало</span>
          <span
            v-if="sum.run"
            class="c run"
          ><icon
            name="dot"
            :size="12"
          />{{ sum.run }} идёт</span>
          <span
            v-if="sum.ok"
            class="c ok"
          ><icon
            name="check"
            :size="13"
          />{{ sum.ok }} прошло</span>
          <a
            v-for="c in sum.fail"
            :key="c.name"
            :href="c.url"
            target="_blank"
            class="failname"
          >{{ c.name }}</a>
        </span>
        <button
          v-if="sum.fail.length && pr.state === 'open'"
          class="btn sm primary"
          :disabled="busy"
          @click="fix('@ci')"
        >
          Починить CI
        </button>
      </div>
      <div
        v-else-if="pr.state === 'open'"
        class="row"
      >
        <span class="k">Проверки</span><span class="v muted">в репозитории их нет</span>
      </div>
      <div
        v-if="pr.conflicts && pr.state === 'open'"
        class="row"
      >
        <span class="k">Слияние</span><span class="v"><span class="c fail">конфликт с базой</span></span>
        <button
          class="btn sm primary"
          :disabled="busy"
          @click="fix('@conflicts')"
        >
          Разрешить
        </button>
      </div>
      <div
        v-if="pr.review || pr.comments"
        class="row"
      >
        <span class="k">Ревью</span>
        <span class="v">
          <span
            v-if="pr.review === 'approved'"
            class="c ok"
          ><icon
            name="check"
            :size="13"
          />одобрено</span>
          <span
            v-else-if="pr.review === 'changes'"
            class="c fail"
          >просят правки</span>
          <span
            v-if="pr.comments"
            class="muted"
          >{{ pr.comments }} комм.</span>
        </span>
      </div>
    </div>

    <div class="files">
      <div
        v-for="f in shown"
        :key="f.name"
        class="file"
      >
        <button
          class="fh"
          :disabled="!f.patch"
          @click="open[f.name] = !open[f.name]"
        >
          <span
            class="chev"
            :class="{ on: open[f.name] }"
          >›</span>
          <span
            class="fname"
            :title="f.name"
          >&lrm;{{ f.name }}</span>
          <span
            v-if="f.status !== 'modified'"
            class="tag"
          >{{ { added: 'новый', removed: 'удалён', renamed: 'переименован' }[f.status] || f.status }}</span>
          <b class="a">+{{ f.add }}</b><b class="d">−{{ f.del }}</b>
        </button>
        <pre
          v-if="open[f.name] && f.patch"
          class="diff"
        ><span
          v-for="(l, i) in f.patch.split('\n')"
          :key="i"
          :class="lineClass(l)"
        >{{ l }}
</span></pre>
      </div>
      <button
        v-if="!allFiles && pr.files.length > 8"
        class="btn ghost sm"
        @click="allFiles = true"
      >
        Ещё {{ pr.files.length - 8 }}
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.pr {
  margin: 14px 0 6px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
  .num {
    font-weight: 600;
    color: var(--text);
    text-decoration: none;
  }
}
.pill {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--ok-soft);
  color: var(--ok);
  &.merged {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  &.closed {
    background: var(--bad-soft);
    color: var(--bad);
  }
}
.stat {
  font-size: 12px;
  color: var(--muted);
}
.a {
  color: var(--ok);
  font-weight: 500;
}
.d {
  color: var(--bad);
  font-weight: 500;
}
.rows {
  padding: 4px 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 12.5px;
  .k {
    color: var(--muted);
    min-width: 72px;
  }
  .v {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
  }
}
.muted {
  color: var(--muted);
}
.c {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  &.ok {
    color: var(--ok);
  }
  &.fail {
    color: var(--bad);
  }
  &.run {
    color: var(--warn);
  }
}
.failname {
  color: var(--bad);
  font-size: 12px;
}
.files {
  border-top: 1px solid var(--line);
  padding: 4px 6px 6px;
  .btn {
    margin: 4px 6px 0;
  }
}
.fh {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 8px;
  font-size: 12.5px;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: var(--sunk);
  }
  &:disabled {
    cursor: default;
  }
  .fname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  b {
    font-size: 11.5px;
  }
}
.chev {
  color: var(--muted);
  transition: transform 0.15s;
  &.on {
    transform: rotate(90deg);
  }
}
.tag {
  font-size: 10.5px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 4px;
}
.diff {
  margin: 2px 6px 8px;
  padding: 8px 0;
  max-height: 420px;
  overflow: auto;
  background: var(--sunk);
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  span {
    display: block;
    padding: 0 10px;
    white-space: pre;
    min-width: max-content;
  }
  .a {
    background: var(--ok-soft);
    font-weight: 400;
  }
  .d {
    background: var(--bad-soft);
    font-weight: 400;
  }
  .h {
    color: var(--muted);
  }
}
</style>
