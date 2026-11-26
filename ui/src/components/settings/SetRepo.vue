<script setup lang="ts">
// Настройки текущего репозитория: ИИ и модель, базовая ветка, проверки, PR, авторабота
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../../lib/api'
import { ago, aiName } from '../../lib/format'
import { bothAi, loadDocReview, store, toast } from '../../lib/store'

const s = reactive<Record<string, any>>({
  ai: '',
  ticketModel: '',
  codexModel: '',
  base: '',
  checks: '',
  draft: false,
  reviewers: '',
  labels: '',
  map: true,
  impact: true,
  fsd: true,
  screens: true,
  docReviewSince: 0,
  siteUrl: '',
  previewUrl: '',
  pages: '',
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
const docReviewSaving = ref(false)

async function load() {
  const r = await api(`/api/repo-settings?repo=${encodeURIComponent(store.curRepo)}`)
  Object.assign(s, { map: true, impact: true, fsd: true, screens: true }, r.settings, {
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

// ---------- скриншоты: секреты и пробный снимок ----------
const sec = ref<{ cookie: boolean, bypass: boolean }>({ cookie: false, bypass: false })
const secIn = reactive({ cookie: '', bypass: '' })
const test = ref<{ site?: string, files?: any[] } | null>(null)
const testing = ref(false)
onMounted(async () => { sec.value = await api(`/api/repo-secret?repo=${encodeURIComponent(store.curRepo)}`) })
async function saveSecret(kind: 'cookie' | 'bypass', value: string) {
  try {
    sec.value = await api('/api/repo-secret', { repo: store.curRepo, kind, value })
    secIn[kind] = ''
    toast(value ? 'Сохранено в keys/' : 'Удалено')
  }
  catch (e: any) { toast(e.message) }
}
async function runTest() {
  testing.value = true; test.value = null
  try { test.value = await api('/api/screens/test', { repo: store.curRepo }) }
  catch (e: any) { toast(e.message) }
  finally { testing.value = false }
}
const BLOCK: Record<string, string> = { vercel: 'закрыто защитой Vercel — нужен секрет обхода', login: 'страница входа — нужен cookie' }

async function save(patch: Record<string, any>) {
  const repo = store.curRepo
  try {
    const r = await api('/api/repo-settings', { repo, ...patch })
    store.cfg.repos = {
      ...(store.cfg.repos || {}),
      [repo]: r.settings,
    }
    if (repo === store.curRepo) {
      Object.assign(s, { docReviewSince: 0 }, r.settings)
      if (typeof patch.docReview === 'boolean')
        void loadDocReview()
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
async function setDocReview(event: Event) {
  const input = event.target as HTMLInputElement
  docReviewSaving.value = true
  try {
    await save({ docReview: input.checked })
    input.checked = Boolean(s.docReviewSince)
  }
  finally {
    docReviewSaving.value = false
  }
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
      <h4>Знание проекта</h4>
      <div class="set">
        <div class="lbl">
          Карта проекта перед задачей<small>Слои, слайсы, общие модули и что похоже на задачу — из графа импортов, без ИИ. Меньше поиска — меньше токенов</small>
        </div>
        <label class="sw"><input
          type="checkbox"
          :checked="s.map"
          @change="save({ map: ($event.target as HTMLInputElement).checked })"
        ><span /></label>
      </div>
      <div class="set">
        <div class="lbl">
          Проверять документацию после слияния<small>Находки по README.md и Markdown в docs/ появятся на главной. Проверка охватывает слияния в базовую ветку с момента включения.</small>
        </div>
        <label class="sw"><input
          type="checkbox"
          aria-label="Проверять документацию после слияния"
          :checked="!!s.docReviewSince"
          :disabled="docReviewSaving"
          @change="setDocReview"
        ><span /></label>
      </div>
      <div class="set">
        <div class="lbl">
          Проверка FSD в PR<small>Новые нарушения правил слоёв (ветка PR против базовой) — в комментарии; в панели — «Починить»</small>
        </div>
        <label class="sw"><input
          type="checkbox"
          :checked="s.fsd"
          @change="save({ fsd: ($event.target as HTMLInputElement).checked })"
        ><span /></label>
      </div>
      <div class="set">
        <div class="lbl">
          «Что может задеть» в PR<small>Комментарий: кто использует изменённые слайсы — их стоит проверить</small>
        </div>
        <label class="sw"><input
          type="checkbox"
          :checked="s.impact"
          @change="save({ impact: ($event.target as HTMLInputElement).checked })"
        ><span /></label>
      </div>
    </div>

    <div class="grp">
      <h4>Скриншоты интерфейса в PR</h4>
      <div class="set">
        <div class="lbl">
          До и после<small>PR с правками интерфейса: страницы, которые используют изменённое, — на телефоне и десктопе. «До» — сайт, «после» — превью PR</small>
        </div>
        <label class="sw"><input
          type="checkbox"
          :checked="s.screens"
          @change="save({ screens: ($event.target as HTMLInputElement).checked })"
        ><span /></label>
      </div>
      <template v-if="s.screens">
        <div class="set">
          <div class="lbl">
            Адрес сайта<small>Пусто — Website репозитория или продакшен-деплой</small>
          </div>
          <input
            :value="s.siteUrl"
            placeholder="https://example.app"
            @change="save({ siteUrl: ($event.target as HTMLInputElement).value.trim() })"
          >
        </div>
        <div class="set">
          <div class="lbl">
            Адрес превью<small>Пусто — из деплоев GitHub (Vercel, Netlify). Шаблон: {branch}</small>
          </div>
          <input
            :value="s.previewUrl"
            placeholder="https://app-git-{branch}-team.vercel.app"
            @change="save({ previewUrl: ($event.target as HTMLInputElement).value.trim() })"
          >
        </div>
        <div class="set">
          <div class="lbl">
            Страницы<small>Пусто — сам по графу (страницы, которые используют изменённое)</small>
          </div>
          <input
            :value="s.pages"
            placeholder="/, /library"
            @change="save({ pages: ($event.target as HTMLInputElement).value.trim() })"
          >
        </div>
        <div
          v-for="[k, t, d, ph] in ([['bypass', 'Обход защиты Vercel', 'Vercel → Settings → Deployment Protection → Protection Bypass for Automation', 'секрет'], ['cookie', 'Cookie входа', 'Если сайт требует входа: «имя=значение; …» из DevTools → Application → Cookies', 'nuxt-session=…']] as const)"
          :key="k"
          class="set"
        >
          <div class="lbl">
            {{ t }}<small>{{ sec[k] ? 'сохранён в keys/ · ' : '' }}{{ d }}</small>
          </div>
          <input
            v-model="secIn[k]"
            type="password"
            autocomplete="off"
            :placeholder="sec[k] ? '•••••• (заменить)' : ph"
            @keydown.enter="saveSecret(k, secIn[k])"
          >
          <button
            v-if="secIn[k]"
            class="btn sm"
            @click="saveSecret(k, secIn[k])"
          >
            Сохранить
          </button>
          <button
            v-else-if="sec[k]"
            class="btn ghost sm"
            @click="saveSecret(k, '')"
          >
            Удалить
          </button>
        </div>
        <div class="line">
          <span class="small">Проверить, что сайт открывается без страницы входа</span>
          <span class="spacer" />
          <button
            class="btn sm"
            :disabled="testing"
            @click="runTest"
          >
            {{ testing ? 'Снимаю…' : 'Пробный снимок' }}
          </button>
        </div>
        <div
          v-if="test?.files"
          class="shots"
        >
          <figure
            v-for="x in test.files"
            :key="x.key"
          >
            <img
              v-if="x.file"
              :src="`/api/file?p=${encodeURIComponent(x.file)}`"
            >
            <figcaption class="small">
              {{ x.url }}<br><b :class="{ bad: x.blocked || x.error }">{{ x.error || (x.blocked ? BLOCK[x.blocked] : 'открылось') }}</b>
            </figcaption>
          </figure>
        </div>
      </template>
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
.shots {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
  figure {
    margin: 0;
    width: 150px;
  }
  img {
    width: 150px;
    border-radius: 10px;
    border: 1px solid var(--line);
  }
  figcaption {
    word-break: break-all;
    .bad {
      color: var(--bad);
    }
  }
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
