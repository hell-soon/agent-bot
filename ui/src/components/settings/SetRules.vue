<script setup lang="ts">
// Правила владельца: общие для всех репозиториев и для текущего — добавляются в инструкции бота
import { onMounted, ref } from 'vue'
import { api } from '../../lib/api'
import { store, toast } from '../../lib/store'

const tab = ref<'global' | 'repo'>('repo')
const text = ref({ global: '', repo: '' })
const loaded = ref(false)
onMounted(async () => {
  text.value = await api(`/api/rules?repo=${encodeURIComponent(store.curRepo)}`)
  loaded.value = true
})
async function save() {
  try {
    text.value = await api('/api/rules', { repo: store.curRepo, [tab.value]: text.value[tab.value] })
    toast('Правила сохранены — со следующего запуска')
  }
  catch (e: any) { toast(e.message) }
}
const EXAMPLES = [
  '- Описание PR — по-английски',
  '- Не трогать папку legacy/',
  '- Новые компоненты — только на Composition API',
  '- UI проверять на ширине 390 px (iPhone)',
]
</script>

<template>
  <div class="grp">
    <p class="small">
      Ваши инструкции боту — он читает их в начале каждой задачи (и Claude, и Codex). Обязательные правила — не пушить в базовую ветку, не сливать PR, не трогать секреты — действуют всегда и здесь не меняются.
    </p>
    <div class="seg">
      <button
        :class="{ on: tab === 'repo' }"
        @click="tab = 'repo'"
      >
        Для {{ store.curRepo.split('/')[1] }}
      </button>
      <button
        :class="{ on: tab === 'global' }"
        @click="tab = 'global'"
      >
        Для всех репозиториев
      </button>
    </div>
    <textarea
      v-if="loaded"
      v-model="text[tab]"
      class="mono-area tall"
      spellcheck="false"
      :placeholder="tab === 'repo' ? `Например:\n${EXAMPLES.join('\n')}` : ''"
    />
    <div class="set">
      <span class="small lbl">{{ tab === 'repo' ? 'Добавляются после общих — могут их уточнять' : 'Начальные правила созданы ботом — правьте как удобно' }}</span>
      <button
        class="btn primary"
        @click="save"
      >
        Сохранить
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.seg {
  margin: 4px 0 10px;
}
.tall {
  min-height: 320px;
}
</style>
