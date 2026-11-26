<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '../../lib/api'

interface PanelUpdate {
  supported: boolean
  current: string
  available: string
  phase: string
  error: string
}

const state = ref<PanelUpdate>()
const initial = ref('')
const pending = ref(false)
const error = ref('')
const updated = computed(() => Boolean(initial.value && state.value?.current && initial.value !== state.value.current))
const busy = computed(() => pending.value || !['idle', 'error'].includes(state.value?.phase || 'idle'))
const labels: Record<string, string> = {
  checking: 'Проверяем версию…',
  building: 'Собираем новую версию…',
  waiting: 'Ждём завершения текущей работы…',
  restarting: 'Перезапускаем панель…',
}

async function refresh() {
  try {
    state.value = await api<PanelUpdate>('/api/panel-update')
    if (!initial.value)
      initial.value = state.value.current
    error.value = ''
  }
  catch (e) {
    error.value = e instanceof Error
      ? e.message
      : String(e)
  }
}

async function run(action: 'check' | 'install') {
  pending.value = true
  try {
    await api('/api/panel-update', { action })
    await refresh()
  }
  catch (e) {
    error.value = e instanceof Error
      ? e.message
      : String(e)
  }
  finally {
    pending.value = false
  }
}

function reload() {
  window.location.reload()
}

let timer: ReturnType<typeof setInterval>
onMounted(() => {
  void refresh()
  timer = setInterval(refresh, 2000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="grp">
    <h4>Версия панели</h4>
    <p v-if="state">
      Текущая версия · {{ state.current.slice(0, 8) || 'неизвестна' }}
    </p>
    <p v-if="state?.available">
      Доступна версия · {{ state.available.slice(0, 8) }}
    </p>
    <p v-if="state && !state.supported">
      Для обновления запустите панель командой <code>bot ui</code>.
    </p>
    <p v-if="state && labels[state.phase]">
      {{ labels[state.phase] }}
    </p>
    <p
      v-if="state?.error || error"
      role="status"
    >
      {{ state?.error || error }}
    </p>
    <div
      v-if="state?.supported"
      class="seg"
    >
      <button
        :disabled="busy"
        @click="run('check')"
      >
        Проверить сейчас
      </button>
      <button
        :disabled="busy || !state.available"
        @click="run('install')"
      >
        Обновить
      </button>
      <button
        v-if="updated"
        @click="reload"
      >
        Перезагрузить страницу
      </button>
    </div>
  </div>
</template>
