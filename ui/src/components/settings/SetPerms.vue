<script setup lang="ts">
// Разрешения фонового режима: базовые (видны, не меняются) + свои разрешённые и запрещённые команды
import { ref } from 'vue'
import { api } from '../../lib/api'
import { store, toast } from '../../lib/store'

const BASE_ALLOW = [
  'git',
  'gh',
  'npm',
  'npx',
  'node',
  'ls',
  'cat',
  'grep',
  'rg',
  'find',
  'sed -n',
  'head',
  'tail',
  'wc',
  'mkdir',
  'jq',
  'sort',
  'uniq',
  'diff',
  'test',
  'echo',
  'pwd',
  'curl -s http://127.0.0.1',
]
const BASE_DENY = [
  'git push --force',
  'git push -f',
  'git push --force-with-lease',
  'git push origin <база>',
  'gh pr merge',
  'gh repo delete',
  'gh api -X DELETE',
]
const SUGGEST = [
  'bun',
  'bunx',
  'pnpm',
  'yarn',
  'make',
  'docker compose',
  'python3',
  'cargo',
  'go',
]
const input = ref({ allowCmds: '', denyCmds: '' })

async function save(k: 'allowCmds' | 'denyCmds', list: string[]) {
  try {
    store.cfg = (await api('/api/settings', { [k]: list })).config
    toast('Сохранено — со следующего запуска')
  }
  catch (e: any) { toast(e.message) }
}
function add(k: 'allowCmds' | 'denyCmds', v = input.value[k]) {
  const c = v.trim()
  if (!c)
    return
  if (!/^[\w@./:=+ -]{1,80}$/.test(c))
    return toast('Только начало команды: без ; & | $ и кавычек')
  save(k, [
    ...(store.cfg[k] || []),
    c,
  ])
  input.value[k] = ''
}
const del = (k: 'allowCmds' | 'denyCmds', c: string) => save(k, (store.cfg[k] || []).filter((x: string) => x !== c))
</script>

<template>
  <div class="grp">
    <p class="small">
      В фоне (панель, очереди, авторабота) бот запускает только разрешённые команды — остальные ему недоступны. Указывайте начало команды: <code>bun</code> разрешит <code>bun run build</code>, <code>bun install</code> и т. д. Правка файлов — только в копии репозитория.
    </p>
  </div>
  <div class="grp">
    <h4>Разрешить ещё</h4>
    <div class="chips-in">
      <span
        v-for="c in store.cfg.allowCmds || []"
        :key="c"
        class="c"
      >{{ c }}<button
        title="Убрать"
        @click="del('allowCmds', c)"
      >×</button></span>
      <input
        v-model="input.allowCmds"
        placeholder="bun, pnpm, make…"
        @keydown.enter="add('allowCmds')"
      >
    </div>
    <div class="sugg">
      <button
        v-for="c in SUGGEST.filter(x => !(store.cfg.allowCmds || []).includes(x))"
        :key="c"
        class="btn ghost sm"
        @click="add('allowCmds', c)"
      >
        + {{ c }}
      </button>
    </div>
  </div>
  <div class="grp">
    <h4>Запретить</h4>
    <div class="chips-in">
      <span
        v-for="c in store.cfg.denyCmds || []"
        :key="c"
        class="c"
      >{{ c }}<button
        title="Убрать"
        @click="del('denyCmds', c)"
      >×</button></span>
      <input
        v-model="input.denyCmds"
        placeholder="npm publish, gh release…"
        @keydown.enter="add('denyCmds')"
      >
    </div>
    <p class="small">
      Запрет сильнее разрешения. Codex команды по списку не ограничивает — ему запреты передаются как правило.
    </p>
  </div>
  <div class="grp">
    <h4>Всегда разрешено</h4>
    <div class="fixed">
      <code
        v-for="c in BASE_ALLOW"
        :key="c"
      >{{ c }}</code>
    </div>
    <h4 style="margin-top: 14px">
      Всегда запрещено
    </h4>
    <div class="fixed">
      <code
        v-for="c in BASE_DENY"
        :key="c"
      >{{ c }}</code>
    </div>
  </div>
</template>

<style scoped lang="scss">
.sugg {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 6px;
}
.fixed {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  code {
    font-size: 11.5px;
  }
}
</style>
