<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { api } from '../../lib/api'

interface Schedule {
  packages: string[]
  day: number
  time: string
  mode: 'patch' | 'minor'
}

interface Status {
  settings?: Schedule
  timezone: string
  nextAt: number | null
  last: {
    at: number
    result: 'running' | 'current' | 'created' | 'failed'
    url?: string
    error?: string
    skipped?: string[]
  } | null
}

const props = defineProps<{ repo: string }>()
const form = reactive({
  packages: '',
  day: 1,
  time: '09:00',
  mode: 'patch' as Schedule['mode'],
})
const days = [
  'Воскресенье',
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
]
const outcomes = {
  running: 'Проверка выполняется',
  current: 'Подходящих обновлений нет',
  created: 'Открыт черновик PR',
  failed: 'Проверка завершилась с ошибкой',
}
const status = ref<Status>()
const loadError = ref('')
const saveMessage = ref('')
const saving = ref(false)
const apiPath = `/api/dependency-updates?repo=${encodeURIComponent(props.repo)}`
let timer: ReturnType<typeof setInterval>
let loading = false

function format(at: number) {
  return new Intl.DateTimeFormat('ru', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: status.value?.timezone,
  }).format(at)
}

async function refresh() {
  if (loading)
    return
  loading = true
  try {
    const next = await api<Status>(apiPath)
    if (!status.value && next.settings) {
      Object.assign(form, next.settings, {
        packages: next.settings.packages.join('\n'),
      })
    }
    status.value = next
    loadError.value = ''
  }
  catch (error) {
    loadError.value = (error as Error).message
  }
  finally {
    loading = false
  }
}

async function save() {
  saving.value = true
  saveMessage.value = ''
  try {
    await api('/api/repo-settings', {
      repo: props.repo,
      dependencyUpdates: {
        ...form,
        packages: form.packages.split(/[,\s]+/).filter(Boolean),
      },
    })
    saveMessage.value = 'Расписание сохранено'
    await refresh()
  }
  catch (error) {
    saveMessage.value = (error as Error).message
  }
  finally {
    saving.value = false
  }
}

onMounted(() => {
  void refresh()
  timer = setInterval(refresh, 10000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="grp">
    <h4>Обновление зависимостей</h4>
    <form
      v-if="status"
      @submit.prevent="save"
    >
      <label
        class="lbl-top"
        for="dependency-packages"
      >
        npm-пакеты<small>По одному на строку или через запятую. Пустой список выключает проверки.</small>
      </label>
      <textarea
        id="dependency-packages"
        v-model="form.packages"
        class="mono-area short"
        spellcheck="false"
      />
      <div class="set">
        <label
          class="lbl"
          for="dependency-day"
        >День недели</label>
        <select
          id="dependency-day"
          v-model="form.day"
        >
          <option
            v-for="(day, index) in days"
            :key="day"
            :value="index"
          >
            {{ day }}
          </option>
        </select>
      </div>
      <div class="set">
        <label
          class="lbl"
          for="dependency-time"
        >Время<small>{{ status.timezone }}</small></label>
        <input
          id="dependency-time"
          v-model="form.time"
          type="time"
          required
        >
      </div>
      <div class="set">
        <label
          class="lbl"
          for="dependency-mode"
        >Режим обновления</label>
        <select
          id="dependency-mode"
          v-model="form.mode"
        >
          <option value="patch">
            Только patch
          </option>
          <option value="minor">
            Patch и minor
          </option>
        </select>
      </div>
      <div class="set">
        <span
          class="small"
          role="status"
        >{{ saveMessage }}</span>
        <button
          class="btn"
          type="submit"
          :disabled="saving"
        >
          Сохранить расписание
        </button>
      </div>
    </form>
    <p
      v-if="loadError"
      class="small"
      role="status"
    >
      Не удалось загрузить расписание. {{ loadError }}
    </p>
    <template v-if="status">
      <p class="small">
        {{ status.nextAt ? `Следующая проверка · ${format(status.nextAt)}` : 'Расписание выключено' }}
      </p>
      <p class="small">
        <template v-if="status.last">
          {{ format(status.last.at) }} · {{ outcomes[status.last.result] }}
          <a
            v-if="status.last.url"
            :href="status.last.url"
            target="_blank"
            rel="noopener noreferrer"
          >Открыть PR</a>
          <span
            v-if="status.last.error"
            class="run-error"
          >{{ status.last.error }}</span>
          <template v-if="status.last.skipped?.length">
            <br>
            Пропущены пакеты без поддерживаемой записи · {{ status.last.skipped.join(', ') }}
          </template>
        </template>
        <template v-else>
          Проверок ещё не было
        </template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.run-error {
  display: block;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
