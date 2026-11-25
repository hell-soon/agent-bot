<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import CommandPalette from './components/CommandPalette.vue'
import Home from './components/Home.vue'
import Icon from './components/Icon.vue'
import RunView from './components/RunView.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import Sidebar from './components/Sidebar.vue'
import { isMac, modKey } from './lib/format'
import { bothAi, goHome, init, newTask, setAi, shownAi, store } from './lib/store'

onMounted(init)

// Горячие клавиши: ⌘K / «/» — поиск, N — новая задача, ⌘, — настройки, Esc — назад
function onKey(e: KeyboardEvent) {
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (mod && e.code === 'KeyK') {
    e.preventDefault()
    store.palette = !store.palette; return
  }
  if (mod && e.key === ',') {
    e.preventDefault()
    store.drawer = 'main'; return
  }
  const t = e.target as HTMLElement
  if (t.closest('textarea, input, select, dialog') || e.metaKey || e.ctrlKey || e.altKey)
    return
  if (e.key === '/') {
    e.preventDefault()
    store.palette = true
  }
  else if (e.code === 'KeyN') {
    e.preventDefault()
    newTask()
  }
  else if (e.key === 'Escape' && store.selected) {
    goHome()
  }
}
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <div
    class="app"
    :class="{ 'sb-open': store.sbOpen }"
  >
    <sidebar />
    <section class="main">
      <header class="bar">
        <button
          class="btn ghost icon menu"
          title="Меню"
          @click.stop="store.sbOpen = !store.sbOpen"
        >
          <icon name="menu" />
        </button>
        <button
          class="search"
          @click="store.palette = true"
        >
          <icon
            name="search"
            :size="16"
          /><span class="l">Поиск и команды</span><kbd>{{ modKey }}K</kbd>
        </button>
        <span class="spacer" />
        <div
          v-if="bothAi"
          class="seg ai"
          title="Кто работает по умолчанию"
        >
          <button
            :class="{ on: store.cfg.ai !== 'codex' }"
            @click="setAi('claude')"
          >
            Claude
          </button>
          <button
            :class="{ on: store.cfg.ai === 'codex' }"
            @click="setAi('codex')"
          >
            Codex
          </button>
        </div>
      </header>
      <div
        v-if="store.ready"
        id="scroll"
        class="scroll"
      >
        <run-view
          v-if="store.selected"
          :key="store.selected"
        />
        <home v-else />
      </div>
    </section>
    <div
      v-if="store.sbOpen"
      class="veil"
      @click="store.sbOpen = false"
    />
  </div>

  <settings-drawer />
  <command-palette />
  <transition name="toast">
    <div
      v-if="store.toast"
      class="toast"
    >
      <span>{{ store.toast }}</span>
    </div>
  </transition>
  <span hidden>{{ shownAi }}</span>
</template>

<style scoped lang="scss">
.app {
  display: grid;
  grid-template-columns: 272px minmax(0, 1fr);
  height: 100vh;
}
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 18px;
  flex: none;
}
.menu {
  display: none;
}
.search {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px 0 10px;
  border-radius: 9px;
  background: var(--sunk);
  color: var(--muted);
  font-size: 13px;
  min-width: 240px;
  &:hover {
    color: var(--text);
  }
  kbd {
    margin-left: auto;
  }
}
.ai button.on {
  color: var(--accent-text);
}
.scroll {
  flex: 1;
  overflow: auto;
}
.veil {
  display: none;
}
.toast {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: 22px;
  display: grid;
  justify-items: center;
  pointer-events: none;
  z-index: 100;
  span {
    background: var(--text);
    color: var(--bg);
    padding: 8px 14px;
    border-radius: 10px;
    font-size: 13px;
  }
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.toast-enter-active,
.toast-leave-active {
  transition: 0.2s;
}

@media (max-width: 820px) {
  .app {
    grid-template-columns: minmax(0, 1fr);
  }
  .menu {
    display: inline-flex;
  }
  .search {
    min-width: 0;
    .l,
    kbd {
      display: none;
    }
  }
  .veil {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.25);
    z-index: 30;
  }
}
</style>
