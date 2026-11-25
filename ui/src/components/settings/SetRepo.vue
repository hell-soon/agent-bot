<script setup lang="ts">
// Настройки текущего репозитория: ИИ и модель, базовая ветка, проверки, PR, авторабота
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../../lib/api'
import { ago, aiName } from '../../lib/format'
import { bothAi, store, toast } from '../../lib/store'

const s = reactive<Record<string, any>>({
  ai: '',
  ticketModel: '',
  codexModel: '',
  base: '',
  checks: '',
  draft: false,
  reviewers: '',
  labels: '',
  auto: {
    issues: false,
    ci: false,
    reviews: false,
    conflicts: false,
  },
})
const loaded = ref(false)
const log = ref<any[]>([])
const autoInfo = ref<{ count: number, max: number, lastAt: number }>({ count: 0, max: 10, lastAt: 0 })
const checking = ref(false)

async function load() {
  const r = await api(`/api/repo-settings?repo=${encodeURIComponent(store.curRepo)}`)
  Object.assign(s, r.settings, {
    auto: {
      ...s.auto,
      ...(r.settings.auto || {}),
    },
  })
  loaded.value = true
  loadLog()
}
async function loadLog() {
  const a = await api('/api/auto')
  log.value = a.log.filter((x: any) => !x.repo || x.repo === store.curRepo).slice(0, 12)
  autoInfo.value = a
}
onMounted(load)

async function save(patch: Record<string, any>) {
  try {
    const r = await api('/api/repo-settings', { repo: store.curRepo, ...patch })
    Object.assign(s, r.settings)
    store.cfg.repos = {
      ...(store.cfg.repos || {}),
      [store.curRepo]: r.settings,
    }
    toast('Сохранено')
  }
  catch (e: any) { toast(e.message) }
}
function setAuto(k: string, v: boolean) {
  return save({
    auto: { ...s.auto, [k]: v },
  })
}
async function runNow() {
  checking.value = true
  try {
    await api('/api/auto/run', {})
    await loadLog()
  }
  finally { checking.value = false }
}
const repoAi = computed(() => (store.ais[s.ai as 'claude' | 'codex'] ? s.ai : store.cfg.ai) || 'claude')
const AUTO = [
  ['issues', 'Брать готовые issue', 'с меткой ready-for-agent — сам делает и открывает PR'],
  ['ci', 'Чинить упавший CI', 'в своих PR; не больше 3 попыток подряд'],
  ['conflicts', 'Разрешать конфликты', 'вливает свежую базу в ветку PR, без force push'],
  ['reviews', 'Отвечать на ревью', 'новые комментарии и «Request changes» в своих PR'],
]
</script>

<template>
  <template v-if="loaded">
    <div class="grp">
      <h4>Кто и как работает здесь</h4>
      <div
        v-if="bothAi"
        class="set"
      >
        <div class="lbl">
          ИИ<small>Для этого репозитория, иначе — общий</small>
        </div>
        <div class="seg">
          <button
            :class="{ on: !s.ai }"
            @click="save({ ai: '' })"
          >
            Общий
          </button>
          <button
            :class="{ on: s.ai === 'claude' }"
            @click="save({ ai: 'claude' })"
          >
            Claude
          </button>
          <button
            :class="{ on: s.ai === 'codex' }"
            @click="save({ ai: 'codex' })"
          >
            Codex
          </button>
        </div>
      </div>
      <div
        v-if="repoAi === 'claude'"
        class="set"
      >
        <div class="lbl">
          Модель для задач<small>Если у issue нет метки размера</small>
        </div>
        <select
          :value="s.ticketModel"
          @change="save({ ticketModel: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">
            как в общих
          </option>
          <option value="haiku">
            Haiku
          </option>
          <option value="sonnet">
            Sonnet
          </option>
          <option value="opus">
            Opus
          </option>
        </select>
      </div>
      <div
        v-else
        class="set"
      >
        <div class="lbl">
          Модель Codex
        </div>
        <select
          :value="s.codexModel"
          @change="save({ codexModel: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">
            как в общих
          </option>
          <option
            v-for="m in store.codexInfo?.models || []"
            :key="m.slug"
            :value="m.slug"
          >
            {{ m.name }}
          </option>
        </select>
      </div>
    </div>

    <div class="grp">
      <h4>Ветки и проверки</h4>
      <div class="set">
        <div class="lbl">
          Базовая ветка<small>Пусто — ветка по умолчанию на GitHub</small>
        </div>
        <input
          :value="s.base"
          placeholder="main"
          @change="save({ base: ($event.target as HTMLInputElement).value })"
        >
      </div>
      <div class="lbl-top">
        Команды проверки<small>Пусто — из AGENTS.md / CLAUDE.md или package.json</small>
      </div>
      <textarea
        class="mono-area short"
        :value="s.checks"
        placeholder="bun run typecheck, bun run lint, bun run build"
        spellcheck="false"
        @change="save({ checks: ($event.target as HTMLTextAreaElement).value })"
      />
    </div>

    <div class="grp">
      <h4>Pull request</h4>
      <div class="set">
        <div class="lbl">
          Черновиком<small>PR открывается как draft — готовым помечаете вы</small>
        </div>
        <label class="sw"><input
          type="checkbox"
          :checked="s.draft"
          @change="save({ draft: ($event.target as HTMLInputElement).checked })"
        ><span /></label>
      </div>
      <div class="set">
        <div class="lbl">
          Ревьюеры<small>логины через запятую</small>
        </div>
        <input
          :value="s.reviewers"
          placeholder="hell-soon"
          @change="save({ reviewers: ($event.target as HTMLInputElement).value })"
        >
      </div>
      <div class="set">
        <div class="lbl">
          Метки PR
        </div>
        <input
          :value="s.labels"
          placeholder="bot"
          @change="save({ labels: ($event.target as HTMLInputElement).value })"
        >
      </div>
    </div>

    <div class="grp">
      <h4>Авторабота · {{ aiName(repoAi) }}</h4>
      <p class="small">
        Раз в {{ store.cfg.autoEvery || 5 }} мин панель смотрит репозиторий и сама ставит задачи. Работает, пока запущен <code>bot ui</code>.
      </p>
      <div
        v-for="[k, t, d] in AUTO"
        :key="k"
        class="set"
      >
        <div class="lbl">
          {{ t }}<small>{{ d }}</small>
        </div>
        <label class="sw"><input
          type="checkbox"
          :checked="s.auto[k]"
          @change="setAuto(k, ($event.target as HTMLInputElement).checked)"
        ><span /></label>
      </div>
      <div class="set">
        <div class="lbl">
          Не больше задач в день<small>на все репозитории · сегодня {{ autoInfo.count }}</small>
        </div>
        <input
          type="number"
          min="1"
          max="100"
          :value="store.cfg.autoMaxPerDay || 10"
          @change="api('/api/settings', { autoMaxPerDay: ($event.target as HTMLInputElement).value }).then(() => toast('Сохранено'))"
        >
      </div>
      <div class="set">
        <div class="lbl">
          Проверять каждые, мин
        </div>
        <input
          type="number"
          min="2"
          max="120"
          :value="store.cfg.autoEvery || 5"
          @change="api('/api/settings', { autoEvery: ($event.target as HTMLInputElement).value }).then(() => toast('Сохранено'))"
        >
      </div>
      <div class="line">
        <span class="small">{{ autoInfo.lastAt ? `Последняя проверка ${ago(autoInfo.lastAt)} назад` : 'Ещё не проверял' }}</span>
        <span class="spacer" />
        <button
          class="btn sm"
          :disabled="checking"
          @click="runNow"
        >
          Проверить сейчас
        </button>
      </div>
      <ul
        v-if="log.length"
        class="log"
      >
        <li
          v-for="(l, i) in log"
          :key="i"
        >
          <span class="t">{{ ago(l.at) }}</span>{{ l.text }}
        </li>
      </ul>
    </div>
  </template>
  <div
    v-else
    class="small"
    style="padding: 16px 0"
  >
    Загружаю…
  </div>
</template>

<style scoped lang="scss">
.lbl-top {
  padding: 8px 0 6px;
  small {
    display: block;
    color: var(--muted);
    font-size: 12px;
  }
}
.short {
  min-height: 64px;
}
.log {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: grid;
  gap: 4px;
  font-size: 12.5px;
  li {
    display: flex;
    gap: 8px;
  }
  .t {
    color: var(--muted);
    min-width: 48px;
  }
}
</style>
