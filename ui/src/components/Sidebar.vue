<script setup lang="ts">
import { computed, ref } from 'vue'
import { isActive, startOfDay, STATUS } from '../lib/format'
import { checkLimits, newTask, otherActive, repoRuns, select, setRepo, store } from '../lib/store'
import Icon from './Icon.vue'
import Limits from './Limits.vue'

const showAll = ref(false)
const groups = computed(() => {
  const day = startOfDay()
  const active = [...repoRuns.value.filter(isActive), ...otherActive.value]
  const rest = repoRuns.value.filter(r => !isActive(r))
  const today = rest.filter(r => (r.endedAt || r.createdAt) >= day)
  const older = rest.filter(r => (r.endedAt || r.createdAt) < day)
  return {
    active,
    today,
    older,
    olderShown: showAll.value
      ? older
      : older.slice(0, 12),
  }
})
const checking = ref(false)
async function refresh() { checking.value = true; await checkLimits(); checking.value = false }
</script>

<template>
  <aside class="sb">
    <div class="top">
      <span class="logo"><icon
        name="bot"
        :size="18"
      /></span><span class="brand">bot</span>
    </div>
    <select
      class="repo"
      :value="store.curRepo"
      :disabled="store.repos.length < 2"
      title="Репозиторий"
      @change="setRepo(($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="r in store.repos"
        :key="r"
        :value="r"
      >
        {{ r }}
      </option>
    </select>
    <button
      class="btn new"
      @click="newTask()"
    >
      <icon name="plus" />Новая задача<kbd>N</kbd>
    </button>

    <div class="list">
      <template
        v-for="[title, list] in ([['Сейчас', groups.active], ['Сегодня', groups.today], ['Раньше', groups.olderShown]] as const)"
        :key="title"
      >
        <template v-if="list.length">
          <h3>{{ title }}</h3>
          <div
            v-for="r in list"
            :key="r.id"
            class="run"
            :class="{ sel: r.id === store.selected }"
            :title="`${r.title} — ${STATUS[r.status] || ''}`"
            @click="select(r.id)"
          >
            <span
              class="st"
              :class="r.status"
            /><span class="t">{{ r.title }}</span>
            <span
              v-if="r.auto"
              class="tag"
              :title="`Авторабота: ${r.auto}`"
            >авто</span>
            <span
              v-if="r.ai === 'codex'"
              class="tag"
            >Codex</span>
            <span
              v-if="r.repo !== store.curRepo"
              class="tag"
            >{{ r.repo.split('/')[1] }}</span>
          </div>
        </template>
      </template>
      <button
        v-if="groups.older.length > 12 && !showAll"
        class="btn ghost sm more"
        @click="showAll = true"
      >
        Ещё {{ groups.older.length - 12 }}
      </button>
      <div
        v-if="!groups.active.length && !groups.today.length && !groups.older.length"
        class="small empty"
      >
        В {{ store.curRepo.split('/')[1] }} задач пока нет
      </div>
    </div>

    <div class="foot">
      <limits />
      <div class="row">
        <button
          class="btn ghost sm"
          :disabled="checking"
          title="Обновить лимиты"
          @click="refresh"
        >
          <icon
            name="refresh"
            :size="14"
          />
        </button>
        <span class="spacer" />
        <button
          class="btn ghost sm"
          title="Настройки (⌘,)"
          @click="store.drawer = 'main'"
        >
          <icon
            name="gear"
            :size="15"
          />Настройки
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.sb {
  background: var(--side);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
  transition: background 0.25s;
}
.top {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 14px 6px;
}
.logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--accent);
  color: var(--on-accent);
  transition: background 0.25s;
  :deep(.icon) {
    stroke-width: 2;
  }
}
.brand {
  font-weight: 700;
  font-size: 15px;
  letter-spacing: -0.01em;
}
.repo {
  margin: 4px 10px 0;
  width: calc(100% - 20px);
  height: 32px;
  padding: 0 8px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  &:hover:not(:disabled) {
    background: var(--sunk);
  }
  &:disabled {
    appearance: none;
    opacity: 1;
  }
}
.new {
  margin: 8px 10px 6px;
  justify-content: flex-start;
  gap: 9px;
  height: 38px;
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  &:hover {
    background: var(--card);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  }
  kbd {
    margin-left: auto;
  }
}
.list {
  flex: 1;
  overflow: auto;
  padding: 4px 8px 12px;
}
h3 {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  margin: 14px 8px 4px;
}
.run {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13.5px;
  &:hover {
    background: var(--sunk);
  }
  &.sel {
    background: var(--card);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  }
  .t {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
.tag {
  font-size: 10.5px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 4px;
}
.more {
  margin: 4px 8px;
}
.empty {
  padding: 12px 8px;
}
.foot {
  border-top: 1px solid var(--line);
  padding: 12px 14px 12px;
  display: grid;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}

@media (max-width: 820px) {
  .sb {
    position: fixed;
    inset: 0 auto 0 0;
    width: 290px;
    z-index: 40;
    transform: translateX(-100%);
    transition: transform 0.2s;
    box-shadow: var(--shadow);
  }
  :global(.app.sb-open) .sb {
    transform: none;
  }
}
</style>
