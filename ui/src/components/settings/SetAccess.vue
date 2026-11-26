<script setup lang="ts">
// Установки GitHub App: где стоит бот, чьи установки ему можно использовать (BOT_OWNERS), чужие — удалить
import { onMounted, ref } from 'vue'
import { api } from '../../lib/api'
import { store, toast } from '../../lib/store'

interface Inst { id: number, owner: string, type: string, selection: string, allowed: boolean }
const list = ref<Inst[]>([])
const owners = ref('')
const loaded = ref(false)
const busy = ref(false)

async function call(b?: Record<string, unknown>, ok?: string) {
  busy.value = true
  try {
    const r = await api<{ list: Inst[], owners: string }>('/api/installations', b)
    list.value = r.list; owners.value = r.owners; loaded.value = true
    if (b) {
      const s = await api<any>('/api/state')
      store.repos = s.repos?.length ? s.repos : store.repos
    }
    if (ok)
      toast(ok)
  }
  catch (e: any) { toast(e.message) }
  finally { busy.value = false }
}
onMounted(() => call())
function remove(i: Inst) {
  if (confirm(`Удалить бота из ${i.owner}? Установку сделал не вы — у вас пропадёт доступ туда, у них — бот.`))
    call({ remove: i.id }, 'Удалено')
}
</script>

<template>
  <div class="grp">
    <p class="small">
      Приложение бота публичное — поставить его себе может кто угодно, но без вашего ключа бот там ничего не делает. Бот работает только в установках разрешённых владельцев (<code>BOT_OWNERS</code> в <code>bot.env</code>); остальные не попадают в панель.
    </p>
    <p
      v-if="loaded && !owners"
      class="small warn"
    >
      Список пуст — сейчас разрешены любые установки. Разрешите свои ниже.
    </p>
  </div>
  <div class="grp">
    <h4>Где установлен</h4>
    <div
      v-for="i in list"
      :key="i.id"
      class="set"
    >
      <div class="lbl">
        {{ i.owner }}<small>{{ i.type === 'Organization' ? 'организация' : 'аккаунт' }} · {{ i.selection === 'all' ? 'все репозитории' : 'выбранные репозитории' }}{{ i.allowed ? '' : ' · не разрешено' }}</small>
      </div>
      <button
        v-if="!i.allowed"
        class="btn ghost sm"
        :disabled="busy"
        @click="remove(i)"
      >
        Удалить
      </button>
      <label
        class="sw"
        :title="i.allowed ? 'Разрешено' : 'Не разрешено'"
      ><input
        type="checkbox"
        :checked="i.allowed && !!owners"
        :disabled="busy"
        @change="call({ owner: i.owner, allow: ($event.target as HTMLInputElement).checked }, 'Сохранено')"
      ><span /></label>
    </div>
    <div
      v-if="loaded && !list.length"
      class="small"
    >
      Приложение никуда не установлено
    </div>
    <p class="small">
      Какие репозитории внутри установки доступны боту — меняется на GitHub: страница приложения → Install App → Configure.
    </p>
  </div>
</template>

<style scoped lang="scss">
.warn {
  color: var(--warn);
}
</style>
