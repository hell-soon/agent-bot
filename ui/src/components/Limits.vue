<script setup lang="ts">
// Лимиты подписки того ИИ, что на экране: Claude — окна из rate_limit_event, Codex — из его журналов сессий
import { computed } from 'vue'
import { money, tok, until } from '../lib/format'
import { shownAi, store } from '../lib/store'

const NAMES: Record<string, string> = {
  five_hour: '5 часов',
  seven_day: 'Неделя',
  seven_day_opus: 'Неделя · Opus',
  seven_day_sonnet: 'Неделя · Sonnet',
}
interface Row { name: string, pct: number | null, rejected: boolean, resetsAt?: number }

const rows = computed<Row[]>(() => {
  if (shownAi.value === 'codex') {
    const c = store.codexLimits || store.codexInfo?.limits
    if (!c)
      return []
    return [c.primary, c.secondary].filter(Boolean).map((w: any) => ({
      name: w.windowMin >= 10000
        ? 'Неделя'
        : `${Math.round(w.windowMin / 60)} часов`,
      pct: w.pct,
      rejected: w.pct >= 100,
      resetsAt: w.resetsAt,
    }))
  }
  const L = {
    five_hour: { status: 'unknown' },
    ...store.limits,
  } as Record<string, any>
  return Object.keys(L).filter(k => !k.startsWith('codex')).sort((a, b) => (a === 'five_hour'
    ? -1
    : b === 'five_hour'
      ? 1
      : a.localeCompare(b))).map((k) => {
    let l = L[k]; if (l.status === 'rejected' && l.resetsAt && l.resetsAt < Date.now())
      l = { status: 'unknown' }
    return {
      name: NAMES[k] || k,
      pct: typeof l.utilization === 'number'
        ? Math.round(l.utilization * 100)
        : null,
      rejected: l.status === 'rejected',
      resetsAt: l.resetsAt,
    }
  })
})
const val = (r: Row) => r.pct ?? (r.rejected ? 100 : 0)
function lvl(r: Row) {
  return r.rejected || val(r) >= 95
    ? 'bad'
    : val(r) >= 75
      ? 'warn'
      : ''
}
const footer = computed(() => {
  const t = store.today || {}
  return shownAi.value === 'codex'
    ? `ChatGPT · ${tok((t.tokIn || 0) + (t.tokOut || 0))} ток. сегодня`
    : `Сегодня ${money(t.cost) || '$0'}`
})
</script>

<template>
  <div
    class="limits"
    :title="shownAi === 'codex' ? 'Лимиты подписки ChatGPT (Codex)' : 'Лимиты подписки Claude — тратят и бот, и ваши обычные сессии'"
  >
    <div
      v-for="r in rows"
      :key="r.name"
      class="lim"
      :class="lvl(r)"
    >
      <span>{{ r.name }}</span>
      <span class="v">{{ r.rejected ? 'исчерпан' : r.pct !== null ? `${r.pct}%` : 'в норме' }}</span>
      <span class="bar"><i :style="{ width: `${val(r)}%` }" /></span>
      <span
        v-if="r.resetsAt && r.resetsAt > Date.now() && val(r) >= 50"
        class="r"
      >сброс {{ until(r.resetsAt) }}</span>
    </div>
    <div
      v-if="!rows.length"
      class="small"
    >
      Лимиты появятся после первой задачи
    </div>
    <div class="small">
      {{ footer }}
    </div>
  </div>
</template>

<style scoped lang="scss">
.limits {
  display: grid;
  gap: 9px;
}
.lim {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 8px;
  font-size: 12.5px;
  .bar {
    grid-column: 1 / -1;
    height: 4px;
    border-radius: 9px;
    background: var(--sunk);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--ok);
    transition: width 0.4s;
  }
  .v {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .r {
    grid-column: 1 / -1;
    color: var(--muted);
    font-size: 11.5px;
  }
  &.warn {
    .bar i {
      background: var(--warn);
    }
    .v {
      color: var(--warn);
    }
  }
  &.bad {
    .bar i {
      background: var(--bad);
    }
    .v {
      color: var(--bad);
    }
  }
}
</style>
