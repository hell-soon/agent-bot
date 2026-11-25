<script setup lang="ts">
// Настройки — только для выбранного ИИ (Claude / Codex) + общее (память, уведомления, клавиши)
import { computed, ref, watch } from 'vue'
import { store, setAi, saveSetting, loadCodex, toast } from '../lib/store'
import { aiName, modKey } from '../lib/format'
import { api } from '../lib/api'
import Icon from './Icon.vue'

const dlg = ref<HTMLDialogElement>()
const token = ref<{ set: boolean; hint?: string }>({ set: false })
const tokIn = ref(''), tokMsg = ref(''), tokOk = ref(true), tokBusy = ref(false)
const mem = ref(''), memLoaded = ref(false)

const ai = computed(() => (store.cfg.ai === 'codex' ? 'codex' : 'claude'))
watch(() => store.drawer, async (v) => {
  if (!v) { dlg.value?.open && dlg.value.close(); return }
  if (!dlg.value?.open) dlg.value?.showModal()
  try { const s = await api('/api/settings'); store.cfg = s.config; token.value = s.token } catch (e: any) { toast(e.message) }
  if (ai.value === 'codex') loadCodex()
  if (v === 'memory') { memLoaded.value = false; const m = await api(`/api/memory?repo=${encodeURIComponent(store.curRepo)}`); mem.value = m.text; memLoaded.value = true }
})
watch(ai, (a) => { if (a === 'codex' && store.drawer) loadCodex() })
function close() { store.drawer = null }

const MODELS = [['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus']]
const EFF = [['low', 'Низк.'], ['medium', 'Сред.'], ['high', 'Выс.']]
const EN: Record<string, string> = { minimal: 'Минимальные', low: 'Низкие', medium: 'Средние', high: 'Высокие', xhigh: 'Очень высокие', max: 'Максимальные', ultra: 'Ультра' }
const codexModels = computed(() => store.codexInfo?.models || [])
const effortsOf = (slug: string) => (codexModels.value.find((m) => m.slug === slug) || codexModels.value[0] || { efforts: ['low', 'medium', 'high'] }).efforts as string[]
const win = (w: any) => (w?.windowMin >= 10000 ? 'неделя' : `${Math.round((w?.windowMin || 300) / 60)} ч`)

async function saveToken() {
  if (!tokIn.value.trim()) return
  tokBusy.value = true; tokOk.value = true; tokMsg.value = 'Проверяю токен…'
  try { const r = await api('/api/settings/token', { token: tokIn.value.trim() }); token.value = r.token; tokIn.value = ''; tokMsg.value = '✓ Токен сохранён' }
  catch (e: any) { tokOk.value = false; tokMsg.value = e.message } finally { tokBusy.value = false }
}
async function checkToken() { tokOk.value = true; tokMsg.value = 'Проверяю…'; const r = await api('/api/settings/token', { check: true }).catch((e) => ({ ok: false, error: e.message })); tokOk.value = r.ok; tokMsg.value = r.ok ? '✓ Работает' : 'Не работает: ' + r.error }
async function delToken() { if (!confirm('Удалить токен? Бот вернётся к обычному входу.')) return; const r = await api('/api/settings/token', { remove: true }); token.value = r.token }
async function saveMem() { try { await api('/api/memory', { text: mem.value, repo: store.curRepo }); toast('Память сохранена') } catch (e: any) { toast(e.message) } }
</script>

<template>
  <dialog ref="dlg" class="drawer" @close="close" @click.self="close">
    <div class="inner">
      <div class="head">
        <h2 v-if="store.drawer === 'memory'">Память · {{ store.curRepo.split('/')[1] }}</h2>
        <h2 v-else>Настройки · {{ aiName(ai) }}</h2>
        <button class="btn ghost icon" title="Закрыть" @click="close"><Icon name="close" /></button>
      </div>

      <div v-if="store.drawer === 'memory'" class="body">
        <p class="small">Что бот узнал в прошлых задачах — подмешивается в каждый запуск (и Claude, и Codex). Бот дописывает сам; можно добавить свои правила.</p>
        <textarea v-model="mem" class="mem" spellcheck="false" :placeholder="memLoaded ? '' : 'Загружаю…'" />
        <div class="set"><span class="small lbl">~{{ Math.round(mem.length / 3.5) }} токенов на запуск</span><button class="btn" @click="store.drawer = 'main'">Назад</button><button class="btn primary" @click="saveMem">Сохранить</button></div>
      </div>

      <div v-else-if="store.drawer" class="body">
        <div class="grp">
          <div class="set"><div class="lbl">Кто работает<small>Настройки ниже — для выбранного ИИ</small></div>
            <div class="seg"><button :class="{ on: ai === 'claude' }" @click="setAi('claude')">Claude</button><button :class="{ on: ai === 'codex' }" @click="setAi('codex')">Codex</button></div></div>
        </div>

        <template v-if="ai === 'codex'">
          <div class="grp"><h4>Codex</h4>
            <div class="line">
              <span v-if="store.codexInfo?.login?.ok" class="ok-t">✓ Вход через {{ store.codexInfo.login.text }}</span>
              <span v-else class="bad-t">Не выполнен вход — в терминале: <code>codex login</code></span>
              <span class="spacer" />
              <span v-if="store.codexInfo?.limits" class="small">{{ [store.codexInfo.limits.primary, store.codexInfo.limits.secondary].filter(Boolean).map((w) => `${win(w)}: ${w.pct}%`).join(' · ') }}</span>
            </div>
            <p class="small">Платит подписка ChatGPT — цены в $ нет, считаются токены. Правила, память и запреты — те же, что у Claude.</p>
          </div>
          <div class="grp"><h4>Задачи</h4>
            <div class="set"><div class="lbl">Модель</div>
              <select :value="store.cfg.codexModel || ''" @change="saveSetting('codexModel', ($event.target as HTMLSelectElement).value)">
                <option value="">по умолчанию Codex</option><option v-for="m in codexModels" :key="m.slug" :value="m.slug">{{ m.name }}</option></select></div>
            <div class="set"><div class="lbl">Усилия<small>Сколько модель думает</small></div>
              <select :value="store.cfg.codexEffort || ''" @change="saveSetting('codexEffort', ($event.target as HTMLSelectElement).value)">
                <option value="">по умолчанию модели</option><option v-for="e in effortsOf(store.cfg.codexModel)" :key="e" :value="e">{{ EN[e] || e }}</option></select></div>
            <div class="set"><div class="lbl">Усилия по размеру<small>size:s → низкие, m → средние, l → высокие</small></div>
              <label class="sw"><input type="checkbox" :checked="store.cfg.sizeModels" @change="saveSetting('sizeModels', ($event.target as HTMLInputElement).checked)"><span /></label></div>
          </div>
          <div class="grp"><h4>Обсуждения и баги</h4>
            <div class="set"><div class="lbl">Модель</div>
              <select :value="store.cfg.codexChatModel || ''" @change="saveSetting('codexChatModel', ($event.target as HTMLSelectElement).value)">
                <option value="">как для задач</option><option v-for="m in codexModels" :key="m.slug" :value="m.slug">{{ m.name }}</option></select></div>
            <div class="set"><div class="lbl">Усилия</div>
              <select :value="store.cfg.codexChatEffort || ''" @change="saveSetting('codexChatEffort', ($event.target as HTMLSelectElement).value)">
                <option value="">по умолчанию модели</option><option v-for="e in effortsOf(store.cfg.codexChatModel || store.cfg.codexModel)" :key="e" :value="e">{{ EN[e] || e }}</option></select></div>
          </div>
        </template>

        <template v-else>
          <div class="grp"><h4>Задачи</h4>
            <div class="set"><div class="lbl">Модель по размеру<small>size:s → Haiku, m → Sonnet, l → Opus</small></div>
              <label class="sw"><input type="checkbox" :checked="store.cfg.sizeModels" @change="saveSetting('sizeModels', ($event.target as HTMLInputElement).checked)"><span /></label></div>
            <div class="set"><div class="lbl">Модель<small>Без метки размера</small></div>
              <div class="seg"><button v-for="[v, l] in MODELS" :key="v" :class="{ on: store.cfg.ticketModel === v }" @click="saveSetting('ticketModel', v)">{{ l }}</button></div></div>
            <div class="set"><div class="lbl">Усилия</div>
              <div class="seg"><button v-for="[v, l] in EFF" :key="v" :class="{ on: store.cfg.ticketEffort === v }" @click="saveSetting('ticketEffort', v)">{{ l }}</button></div></div>
            <div class="set"><div class="lbl">Предел на задачу, $<small>Дальше — остановится, можно «Продолжить»</small></div>
              <input type="number" min="0.5" max="100" step="0.5" class="num" :value="store.cfg.budget" @change="saveSetting('budget', ($event.target as HTMLInputElement).value)"></div>
          </div>
          <div class="grp"><h4>Обсуждения и баги</h4>
            <div class="set"><div class="lbl">Модель</div>
              <div class="seg"><button v-for="[v, l] in [['', 'Авто'], ...MODELS]" :key="v" :class="{ on: (store.cfg.chatModel || '') === v }" @click="saveSetting('chatModel', v)">{{ l }}</button></div></div>
            <div class="set"><div class="lbl">Усилия</div>
              <div class="seg"><button v-for="[v, l] in [['', 'Авто'], ...EFF]" :key="v" :class="{ on: (store.cfg.chatEffort || '') === v }" @click="saveSetting('chatEffort', v)">{{ l }}</button></div></div>
          </div>
          <div class="grp"><h4>Вход в Claude</h4>
            <div class="line">
              <template v-if="token.set"><span class="ok-t">✓ Токен задан</span><span class="small">…{{ token.hint?.slice(-4) }}</span><span class="spacer" />
                <button class="btn sm" @click="checkToken">Проверить</button><button class="btn ghost sm" @click="delToken">Удалить</button></template>
              <span v-else class="bad-t">Токен не задан — используется обычный вход</span>
            </div>
            <div class="set"><input v-model="tokIn" type="password" :placeholder="token.set ? 'Заменить: sk-ant-…' : 'Токен из claude setup-token'" autocomplete="off" spellcheck="false" @keydown.enter="saveToken"><button class="btn primary" :disabled="tokBusy" @click="saveToken">Сохранить</button></div>
            <div v-if="tokMsg" class="small" :class="tokOk ? 'ok-t' : 'bad-t'">{{ tokMsg }}</div>
          </div>
          <div class="grp"><h4>Терминал</h4>
            <div class="set"><div class="lbl">Code Mode<small>Экспериментально, только для bot в терминале</small></div>
              <label class="sw"><input type="checkbox" :checked="store.cfg.codeMode" @change="saveSetting('codeMode', ($event.target as HTMLInputElement).checked)"><span /></label></div>
          </div>
        </template>

        <div class="grp"><h4>Память бота</h4>
          <div class="set"><div class="lbl">{{ store.curRepo }}<small>Что бот помнит об этом репозитории — общая для Claude и Codex</small></div><button class="btn" @click="store.drawer = 'memory'">Открыть</button></div>
        </div>
        <div class="grp"><h4>Уведомления</h4>
          <div class="set"><div class="lbl">Уведомления macOS<small>Когда задачи закончились</small></div>
            <label class="sw"><input type="checkbox" :checked="store.cfg.notify" @change="saveSetting('notify', ($event.target as HTMLInputElement).checked)"><span /></label></div>
        </div>
        <div class="grp"><h4>Клавиши</h4>
          <div class="small keys">
            <span><kbd>{{ modKey }}K</kbd> или <kbd>/</kbd> — поиск и команды</span>
            <span><kbd>N</kbd> — новая задача · <kbd>{{ modKey }},</kbd> — настройки</span>
            <span><kbd>{{ modKey }}↵</kbd> — запустить / ответить · <kbd>1–9</kbd> — вариант · <kbd>Esc</kbd> — назад</span>
          </div>
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped lang="scss">
.drawer { margin: 0 0 0 auto; height: 100%; max-height: 100%; width: min(440px, 100%); max-width: 100%; border: 0; padding: 0; background: var(--card); color: inherit; box-shadow: var(--shadow); &::backdrop { background: rgba(0, 0, 0, .25); } }
.inner { display: flex; flex-direction: column; height: 100%; }
.head { display: flex; align-items: center; gap: 8px; padding: 16px 18px; border-bottom: 1px solid var(--line); h2 { margin: 0; font-size: 16px; font-weight: 600; flex: 1; } }
.body { overflow: auto; padding: 6px 18px 30px; }
.grp { padding: 16px 0 6px; & + & { border-top: 1px solid var(--line); } h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; } }
.set { display: flex; align-items: center; gap: 12px; padding: 8px 0; min-height: 44px; .lbl { flex: 1; min-width: 0; small { display: block; color: var(--muted); font-size: 12px; } } select { width: 190px; } }
.num { width: 80px !important; }
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; padding: 4px 0 8px; }
.sw {
  position: relative; width: 38px; height: 22px; flex: none;
  input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; z-index: 1; }
  span { position: absolute; inset: 0; border-radius: 99px; background: var(--line); transition: background .2s;
    &::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .2s; box-shadow: 0 1px 2px rgba(0, 0, 0, .2); } }
  input:checked + span { background: var(--accent); &::after { transform: translateX(16px); background: var(--on-accent); } }
}
.mem { min-height: 300px; margin: 10px 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
.keys { display: grid; gap: 6px; }
</style>
