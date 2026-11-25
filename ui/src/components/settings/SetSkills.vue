<script setup lang="ts">
// Скиллы бота: источники (mattpocock, установленные из GitHub, сам репозиторий), вкл/выкл, установка
import type { Skill } from '../../lib/store'
import { computed, onMounted, ref } from 'vue'
import { api } from '../../lib/api'
import { enabledSkills, loadSkills, store, toast } from '../../lib/store'

const sources = ref<any[]>([])
const q = ref('')
const spec = ref('')
const busy = ref('')
const open = ref<Record<string, boolean>>({})

async function load() {
  const r = await api(`/api/skills?repo=${encodeURIComponent(store.curRepo)}`)
  store.skills = r.skills
  sources.value = r.sources
}
onMounted(load)

const bySource = computed(() => sources.value.map(src => ({
  ...src,
  skills: store.skills.filter(s => s.source === src.id && (!q.value || `${s.name} ${s.description}`.toLowerCase().includes(q.value.toLowerCase()))),
})))
async function toggle(s: Skill, on: boolean) {
  s.enabled = on
  try { await api('/api/skills/toggle', { id: s.id, on }) }
  catch (e: any) {
    s.enabled = !on
    toast(e.message)
  }
}
async function toggleAll(src: any, on: boolean) {
  for (const s of src.skills.filter((x: Skill) => x.enabled !== on))
    await api('/api/skills/toggle', { id: s.id, on })
  await load()
}
async function install() {
  if (!spec.value.trim())
    return
  busy.value = 'install'
  try {
    const r = await api('/api/skills/install', { spec: spec.value })
    toast(`Установлено: ${r.repo} — ${r.count} скиллов`)
    spec.value = ''
    await load()
  }
  catch (e: any) { toast(e.message) }
  finally { busy.value = '' }
}
async function act(kind: 'update' | 'remove', src: any) {
  if (kind === 'remove' && !confirm(`Удалить ${src.label}?`))
    return
  busy.value = src.id
  try {
    await api(`/api/skills/${kind}`, { source: src.id })
    toast(kind === 'update'
      ? 'Обновлено'
      : 'Удалено')
    await load()
    loadSkills()
  }
  catch (e: any) { toast(e.message) }
  finally { busy.value = '' }
}
</script>

<template>
  <div class="grp">
    <p class="small">
      Скиллы — инструкции, которые бот подгружает по мере надобности. Ручные запускаются через <code>/имя</code> в строке ввода. Чем меньше включено — тем меньше стартовый контекст. Включено: <b>{{ enabledSkills.length }}</b>.
    </p>
    <div class="set">
      <input
        v-model="spec"
        class="grow"
        placeholder="owner/repo или ссылка на GitHub"
        spellcheck="false"
        @keydown.enter="install"
      >
      <button
        class="btn primary"
        :disabled="busy === 'install'"
        @click="install"
      >
        {{ busy === 'install' ? 'Ставлю…' : 'Установить' }}
      </button>
    </div>
    <p class="small">
      Например <code>antfu/skills</code>. Это чужие инструкции, которым бот будет следовать — ставьте из источников, которым доверяете.
    </p>
    <input
      v-model="q"
      class="search"
      placeholder="Найти скилл"
    >
  </div>

  <div
    v-for="src in bySource"
    :key="src.id"
    class="grp"
  >
    <div class="src">
      <h4>{{ src.label }} · {{ src.skills.length }}</h4>
      <span class="spacer" />
      <template v-if="!src.readonly">
        <button
          class="btn ghost sm"
          @click="toggleAll(src, true)"
        >
          Все
        </button>
        <button
          class="btn ghost sm"
          @click="toggleAll(src, false)"
        >
          Ничего
        </button>
      </template>
      <button
        v-if="src.removable"
        class="btn ghost sm"
        :disabled="busy === src.id"
        @click="act('update', src)"
      >
        Обновить
      </button>
      <button
        v-if="src.removable"
        class="btn ghost sm"
        :disabled="busy === src.id"
        @click="act('remove', src)"
      >
        Удалить
      </button>
    </div>
    <p
      v-if="src.readonly"
      class="small"
    >
      Скиллы самого репозитория — Claude подхватывает их всегда.
    </p>
    <div
      v-for="s in (open[src.id] || q ? src.skills : src.skills.slice(0, 12))"
      :key="s.id"
      class="skill"
    >
      <div class="lbl">
        <span class="name">/{{ s.name }}</span><span
          v-if="s.manual"
          class="tag"
          title="Запускается только вручную: /имя"
        >вручную</span><span
          v-if="s.group && s.group !== 'skills'"
          class="tag"
        >{{ s.group }}</span>
        <small :title="s.description">{{ s.description }}</small>
      </div>
      <label
        v-if="!s.readonly"
        class="sw"
      ><input
        type="checkbox"
        :checked="s.enabled"
        @change="toggle(s, ($event.target as HTMLInputElement).checked)"
      ><span /></label>
    </div>
    <button
      v-if="!q && !open[src.id] && src.skills.length > 12"
      class="btn ghost sm more"
      @click="open[src.id] = true"
    >
      Ещё {{ src.skills.length - 12 }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.grow {
  flex: 1;
  width: auto !important;
}
.search {
  margin-top: 4px;
}
.src {
  display: flex;
  align-items: center;
  gap: 4px;
  h4 {
    margin: 0;
  }
}
.skill {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid var(--line);
  &:first-of-type {
    border-top: 0;
  }
  .lbl {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 500;
  }
  small {
    display: block;
    color: var(--muted);
    font-size: 12px;
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
  margin-left: 6px;
}
.more {
  margin-top: 6px;
}
</style>
