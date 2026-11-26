<script setup lang="ts">
// Уведомления (macOS, вкладка браузера, Telegram) и сторож, который останавливает зависшие задачи
import { onMounted, ref } from 'vue'
import { api } from '../../lib/api'
import { saveSetting, store, toast } from '../../lib/store'

const EVENTS = [
  ['done', 'Готово', 'задача закончилась, PR открыт'],
  ['waiting', 'Ждёт ответа', 'бот задал вопрос в обсуждении'],
  ['failed', 'Не получилось', 'ошибка, лимит или остановка сторожем'],
] as const
const WATCH = [
  ['watchIdle', 'Без действий, мин', 'бот молчит дольше — считаем, что завис'],
  ['watchMax', 'Задача дольше, мин', 'потолок на одну задачу'],
  ['watchRepeat', 'Повторов подряд', 'одна и та же команда или чтение без правок между ними'],
] as const

const perm = ref(typeof Notification === 'undefined'
  ? 'unsupported'
  : Notification.permission)
async function askPerm() {
  perm.value = await Notification.requestPermission()
  if (perm.value === 'granted')
    new Notification('bot', { body: 'Уведомления в браузере включены' })
}

const tg = ref<{ set: boolean, bot?: string, chat?: string }>({ set: false })
const tgIn = ref('')
const busy = ref(false)
onMounted(async () => { tg.value = await api('/api/telegram') })
async function tgDo(b: Record<string, unknown>, ok?: string) {
  busy.value = true
  try {
    const r = await api('/api/telegram', b)
    if ('set' in r) {
      tg.value = {
        ...tg.value,
        ...r,
      }
    }
    store.cfg.tgChat = tg.value.chat || ''
    tgIn.value = ''
    if (ok)
      toast(ok)
  }
  catch (e: any) { toast(e.message) }
  finally { busy.value = false }
}
const on = (k: string) => (store.cfg.notifyOn || {})[k] !== false
function setOn(k: string, v: boolean) {
  saveSetting('notifyOn', {
    done: on('done'),
    waiting: on('waiting'),
    failed: on('failed'),
    [k]: v,
  })
}
function setNum(k: string, e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  if (v >= 0 && v <= 600)
    saveSetting(k, v)
}
</script>

<template>
  <div class="grp">
    <h4>О чём сообщать</h4>
    <div
      v-for="[k, t, d] in EVENTS"
      :key="k"
      class="set"
    >
      <div class="lbl">
        {{ t }}<small>{{ d }}</small>
      </div>
      <label class="sw"><input
        type="checkbox"
        :checked="on(k)"
        @change="setOn(k, ($event.target as HTMLInputElement).checked)"
      ><span /></label>
    </div>
  </div>

  <div class="grp">
    <h4>Куда</h4>
    <div class="set">
      <div class="lbl">
        macOS<small>системное уведомление на этом Mac</small>
      </div>
      <label class="sw"><input
        type="checkbox"
        :checked="store.cfg.notify"
        @change="saveSetting('notify', ($event.target as HTMLInputElement).checked)"
      ><span /></label>
    </div>
    <div class="set">
      <div class="lbl">
        Браузер<small>{{ perm === 'granted' ? 'когда вкладка панели в фоне; клик откроет задачу' : perm === 'denied' ? 'запрещено в настройках сайта — разрешите для 127.0.0.1' : 'нужно разрешение браузера' }}</small>
      </div>
      <button
        v-if="perm === 'default'"
        class="btn sm"
        @click="askPerm"
      >
        Разрешить
      </button>
      <label
        v-else-if="perm === 'granted'"
        class="sw"
      ><input
        type="checkbox"
        :checked="store.cfg.browserNotify !== false"
        @change="saveSetting('browserNotify', ($event.target as HTMLInputElement).checked)"
      ><span /></label>
    </div>
  </div>

  <div class="grp">
    <h4>Telegram — на телефон</h4>
    <template v-if="!tg.set">
      <ol class="small steps">
        <li>В Telegram откройте <b>@BotFather</b> → <code>/newbot</code> → придумайте имя.</li>
        <li>Он пришлёт токен вида <code>123456:ABC…</code> — вставьте сюда.</li>
      </ol>
      <div class="set">
        <input
          v-model="tgIn"
          class="grow"
          placeholder="токен бота от @BotFather"
          spellcheck="false"
          autocomplete="off"
          @keydown.enter="tgDo({ token: tgIn })"
        >
        <button
          class="btn primary"
          :disabled="busy || !tgIn.trim()"
          @click="tgDo({ token: tgIn })"
        >
          Сохранить
        </button>
      </div>
    </template>
    <template v-else-if="!tg.chat">
      <p class="small">
        Бот <b>@{{ tg.bot }}</b> подключён. Откройте его в Telegram, нажмите «Старт», затем — кнопку ниже: панель найдёт ваш чат.
      </p>
      <div class="line">
        <a
          v-if="tg.bot"
          class="btn sm"
          :href="`https://t.me/${tg.bot}`"
          target="_blank"
        >Открыть @{{ tg.bot }}</a>
        <span class="spacer" />
        <button
          class="btn primary sm"
          :disabled="busy"
          @click="tgDo({ find: true }, 'Чат найден — отправил проверочное сообщение')"
        >
          Найти мой чат
        </button>
      </div>
    </template>
    <template v-else>
      <div class="set">
        <div class="lbl">
          Подключено<small>@{{ tg.bot }} · чат {{ tg.chat }}</small>
        </div>
        <button
          class="btn sm"
          :disabled="busy"
          @click="tgDo({ test: true }, 'Отправил')"
        >
          Проверить
        </button>
        <button
          class="btn ghost sm"
          :disabled="busy"
          @click="tgDo({ remove: true }, 'Отключено')"
        >
          Отключить
        </button>
      </div>
    </template>
    <p class="small">
      Токен хранится в <code>keys/telegram-token</code> (не попадает в git). В сообщении — название задачи, причина и ссылка на PR.
    </p>
  </div>

  <div class="grp">
    <h4>Сторож</h4>
    <p class="small">
      Останавливает задачу, которая зависла, идёт слишком долго или ходит по кругу, — чтобы не жгла лимит. Правки сохраняются WIP-коммитом, «Продолжить» продолжит с того же места. 0 — выключено.
    </p>
    <div
      v-for="[k, t, d] in WATCH"
      :key="k"
      class="set"
    >
      <div class="lbl">
        {{ t }}<small>{{ d }}</small>
      </div>
      <input
        type="number"
        min="0"
        max="600"
        :value="store.cfg[k]"
        @change="setNum(k, $event)"
      >
    </div>
  </div>
</template>

<style scoped lang="scss">
.grow {
  flex: 1;
  width: auto !important;
}
.steps {
  margin: 0 0 8px;
  padding-left: 18px;
  display: grid;
  gap: 3px;
}
</style>
