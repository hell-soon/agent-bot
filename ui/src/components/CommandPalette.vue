<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ago, aiName, isMac, kindIcon, STATUS } from '../lib/format'
import { bothAi, checkLimits, enabledSkills, goHome, newTask, openArch, openGraph, repoRuns, select, setAi, setRepo, startJob, store, toast } from '../lib/store'
import Icon from './Icon.vue'

interface Item { icon: string, dot?: string, title: string, em?: string, hint?: string, keys?: string, run: () => void }
const dlg = ref<HTMLDialogElement>()
const input = ref<HTMLInputElement>()
const list = ref<HTMLElement>()
const q = ref('')
const sel = ref(0)

watch(() => store.palette, async (v) => {
  if (v) {
    q.value = ''; sel.value = 0; if (store.drawer)
      store.drawer = null; dlg.value?.showModal(); await nextTick(); input.value?.focus()
  }
  else if (dlg.value?.open) {
    dlg.value.close()
  }
})
function close() { store.palette = false }
const go = (fn: () => void) => () => { close(); fn() }
const job = (b: Record<string, any>) => go(() => startJob(b).catch(e => toast(e.message)))

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/ё/g, 'е')
function matches(query: string, ...f: unknown[]) { const hay = norm(f.join(' ')); return norm(query).split(/\s+/).filter(Boolean).every(w => hay.includes(w)) }

const groups = computed(() => {
  const query = q.value.trim()
  const out: { title: string, items: Item[] }[] = []
  const push = (title: string, items: Item[]) => {
    if (items.length)
      out.push({ title, items })
  }
  // «/имя» — сразу скиллы; иначе скиллы ищутся среди прочего
  const sq = query.replace(/^\//, '')
  const skillItems = query
    ? enabledSkills.value.filter(s => matches(sq, s.name, query.startsWith('/')
        ? ''
        : s.description)).slice(0, query.startsWith('/')
        ? 10
        : 4).map(s => ({
        icon: 'idea',
        title: `/${s.name}`,
        hint: s.description.slice(0, 60),
        run: go(() => newTask('task', `/${s.name} `)),
      }))
    : []
  if (query.startsWith('/')) {
    push('Скиллы', skillItems)
    return out
  }
  if (query) {
    push('Поручить боту', [
      {
        icon: 'task',
        title: 'Новая задача: ',
        em: `«${query}»`,
        hint: aiName(store.cfg.ai),
        run: job({ kind: 'task', text: query }),
      },
      {
        icon: 'idea',
        title: 'Обсудить как фичу: ',
        em: `«${query}»`,
        run: job({ kind: 'idea', text: query }),
      },
      {
        icon: 'bug',
        title: 'Разобрать как баг: ',
        em: `«${query}»`,
        run: job({ kind: 'bug', text: query }),
      },
    ])
  }
  push('Скиллы', skillItems)
  push(query ? 'Задачи' : 'Недавние задачи', (query ? store.runs : repoRuns.value).filter(r => !query || matches(query, r.title, STATUS[r.status], r.ai, r.repo)).slice(0, query ? 8 : 5)
    .map(r => ({
      icon: kindIcon(r.kind),
      dot: r.status,
      title: r.title,
      hint: `${r.repo !== store.curRepo ? `${r.repo?.split('/')[1]} · ` : ''}${STATUS[r.status] || ''} · ${ago(r.endedAt || r.startedAt || r.createdAt)}`,
      run: go(() => select(r.id)),
    })))
  if (query) {
    push('Issue — сделать', store.gh.issues.filter(i => matches(query, `#${i.number}`, i.title)).slice(0, 5)
      .map(i => ({
        icon: 'issue',
        title: `#${i.number} ${i.title}`,
        hint: i.labels.includes('ready-for-agent')
          ? 'готово для бота'
          : '',
        run: job({
          kind: 'issue',
          issue: String(i.number),
        }),
      })))
    push('Pull requests', store.gh.prs.filter(p => matches(query, `#${p.number}`, p.title, 'pr')).slice(0, 4).flatMap(p => [
      {
        icon: 'pr',
        title: `#${p.number} ${p.title}`,
        hint: 'открыть на GitHub',
        run: go(() => window.open(p.url, '_blank')),
      },
      {
        icon: 'pr',
        title: 'Поправить ',
        em: `#${p.number}`,
        hint: 'правки PR',
        run: go(() => { store.compose.prPick = String(p.number); newTask('pr') }),
      },
    ]))
  }
  const other = store.cfg.ai === 'codex'
    ? 'claude'
    : 'codex'
  const acts: (Item & { k?: string })[] = [
    {
      icon: 'task',
      title: 'Новая задача',
      keys: 'N',
      k: 'создать',
      run: go(() => newTask()),
    },
    {
      icon: 'issue',
      title: 'Сделать задачу из issue…',
      k: 'issue',
      run: go(() => newTask('issue')),
    },
    {
      icon: 'idea',
      title: 'Обсудить фичу…',
      k: 'идея',
      run: go(() => newTask('idea')),
    },
    {
      icon: 'feature',
      title: 'Разработка фичи: план на доске…',
      k: 'план доска',
      run: go(() => newTask('feature')),
    },
    {
      icon: 'bug',
      title: 'Разобрать баг…',
      k: 'ошибка',
      run: go(() => newTask('bug')),
    },
    {
      icon: 'pr',
      title: 'Поправить PR…',
      k: 'ревью',
      run: go(() => newTask('pr')),
    },
    {
      icon: 'queue',
      title: 'Очередь из нескольких issue…',
      run: go(() => newTask('queue')),
    },
    {
      icon: 'chain',
      title: 'Цепочка задач…',
      k: 'зависимые',
      run: go(() => newTask('chain')),
    },
    {
      icon: 'triage',
      title: 'Разобрать новые issue',
      k: 'triage метки',
      run: job({ kind: 'triage' }),
    },
    ...(bothAi.value
      ? [{
          icon: 'swap',
          title: `Переключить на ${aiName(other)}`,
          k: 'ии claude codex',
          run: go(() => setAi(other)),
        }]
      : []),
    {
      icon: 'arch',
      title: 'Архитектура проекта',
      k: 'архитектура схема сервисы инфраструктура',
      run: go(openArch),
    },
    {
      icon: 'graph',
      title: 'Граф проекта',
      k: 'граф файлы связи obsidian карта',
      run: go(openGraph),
    },
    {
      icon: 'gear',
      title: 'Настройки',
      keys: isMac ? '⌘,' : 'Ctrl ,',
      k: 'модель токен',
      run: go(() => { store.drawer = 'main' }),
    },
    {
      icon: 'mem',
      title: 'Память бота',
      k: 'memory',
      run: go(() => { store.drawer = 'memory' }),
    },
    {
      icon: 'idea',
      title: 'Скиллы бота',
      k: 'skills установить github',
      run: go(() => { store.drawer = 'skills' }),
    },
    {
      icon: 'tickets',
      title: 'Правила бота',
      k: 'rules инструкции',
      run: go(() => { store.drawer = 'rules' }),
    },
    {
      icon: 'limit',
      title: 'Разрешения команд',
      k: 'permissions bun pnpm',
      run: go(() => { store.drawer = 'perms' }),
    },
    {
      icon: 'home',
      title: 'Настройки репозитория',
      k: 'ветка проверки pr авторабота auto',
      run: go(() => { store.drawer = 'repo' }),
    },
    {
      icon: 'limit',
      title: 'Обновить лимиты',
      k: 'лимит неделя',
      run: go(() => checkLimits()),
    },
    {
      icon: 'home',
      title: 'На главную',
      k: 'домой',
      run: go(() => goHome()),
    },
    ...store.repos.filter(r => r !== store.curRepo).map(r => ({
      icon: 'swap',
      title: `Перейти в ${r}`,
      k: 'репозиторий',
      run: go(() => setRepo(r)),
    })),
  ]
  push(
    query ? 'Команды' : 'Действия',
    acts.filter(a => !query || matches(query, a.title, a.k)).slice(0, query ? 6 : 8),
  )
  return out
})
const flat = computed(() => groups.value.flatMap(g => g.items))
watch(q, () => {
  sel.value = 0
})
const idx = (gi: number, ii: number) => groups.value.slice(0, gi).reduce((n, g) => n + g.items.length, 0) + ii
async function move(d: number) {
  const n = flat.value.length
  if (!n)
    return
  sel.value = (sel.value + d + n) % n
  await nextTick()
  list.value?.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' })
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); flat.value[sel.value]?.run() }
}
</script>

<template>
  <dialog
    ref="dlg"
    class="pal"
    @close="close"
    @click.self="close"
  >
    <div class="box">
      <div class="in">
        <icon
          name="search"
          :size="22"
        /><input
          ref="input"
          v-model="q"
          placeholder="Поиск или новая задача"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKey"
        >
      </div>
      <div
        v-if="flat.length"
        ref="list"
        class="list"
      >
        <template
          v-for="(g, gi) in groups"
          :key="g.title"
        >
          <div class="g">
            {{ g.title }}
          </div>
          <div
            v-for="(it, ii) in g.items"
            :key="ii"
            class="item"
            :class="{ on: idx(gi, ii) === sel }"
            @mousemove="sel = idx(gi, ii)"
            @click="it.run()"
          >
            <span class="pi"><span
              v-if="it.dot"
              class="st"
              :class="it.dot"
            /><icon
              v-else
              :name="it.icon"
              :size="15"
            /></span>
            <span class="t">{{ it.title }}<span
              v-if="it.em"
              class="em"
            >{{ it.em }}</span></span>
            <span
              v-if="it.hint || it.keys"
              class="h"
            >{{ it.keys || it.hint }}</span>
          </div>
        </template>
      </div>
      <div class="foot">
        <span><kbd>↑</kbd> <kbd>↓</kbd> выбрать</span><span><kbd>↵</kbd> открыть</span><span><kbd>esc</kbd> закрыть</span>
      </div>
    </div>
  </dialog>
</template>

<style scoped lang="scss">
.pal {
  margin: 16vh auto auto;
  width: min(660px, calc(100% - 24px));
  max-width: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  overflow: visible;
  &::backdrop {
    background: transparent;
  }
}
.box {
  border-radius: 18px;
  overflow: hidden;
  background: color-mix(in srgb, var(--card) 80%, transparent);
  backdrop-filter: blur(40px) saturate(1.8);
  border: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.1),
    0 24px 70px -10px rgba(0, 0, 0, 0.45);
}
.in {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 18px;
  height: 58px;
  color: var(--muted);
  input,
  input:focus {
    flex: 1;
    height: 100%;
    border: 0;
    outline: none;
    background: transparent;
    border-radius: 0;
    padding: 0;
    font-size: 21px;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  input::placeholder {
    color: var(--muted);
    opacity: 0.8;
  }
}
.list {
  max-height: min(52vh, 460px);
  overflow: auto;
  padding: 6px;
  border-top: 1px solid var(--line);
}
.g {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  padding: 8px 10px 4px;
}
.item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 10px;
  height: 40px;
  border-radius: 9px;
  cursor: default;
  .pi {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    background: var(--sunk);
    color: var(--muted);
    flex: none;
  }
  .t {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .em,
  .h {
    color: var(--muted);
  }
  .h {
    font-size: 12px;
    white-space: nowrap;
  }
  &.on {
    background: var(--accent);
    color: var(--on-accent);
    .pi {
      background: color-mix(in srgb, var(--on-accent) 20%, transparent);
      color: var(--on-accent);
    }
    .em,
    .h {
      color: color-mix(in srgb, var(--on-accent) 75%, transparent);
    }
  }
}
.foot {
  display: flex;
  gap: 14px;
  padding: 8px 16px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--muted);
  kbd {
    background: transparent;
  }
}
@media (max-width: 820px) {
  .pal {
    margin-top: 10vh;
  }
}
</style>
