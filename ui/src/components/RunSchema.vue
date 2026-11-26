<script setup lang="ts">
// Схема задачи: этапы на вертикальной оси — что бот делал, сколько времени, где паузы и ошибки
import type { SchemaNode } from '../lib/schema'
import { computed, ref } from 'vue'
import { buildSchema, dur, PHASE } from '../lib/schema'

// n — число событий: массив тот же (shallowRef + push), по n схема пересчитывается вживую
const props = defineProps<{ events: any[], n: number, short: (p: string) => string, live?: boolean }>()
const emit = defineEmits<{ jump: [ei: number] }>()
const s = computed(() => {
  void props.n
  return buildSchema(props.events, props.short)
})
const open = ref<Record<number, boolean>>({})
const all = ref<Record<number, boolean>>({})

const hm = (t?: number) => (t ? new Date(t).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '')
function when(n: SchemaNode) {
  if (!n.t0)
    return ''
  const long = n.t1 && n.t1 - n.t0 >= 60000
  return long ? `${hm(n.t0)} – ${hm(n.t1)}` : hm(n.t0)
}
const length = (n: SchemaNode) => (n.t0 && n.t1 && n.t1 - n.t0 >= 60000 ? dur(n.t1 - n.t0) : '')
// пауза до следующего этапа — ожидание вашего ответа, лимит, перезапуск
function gap(i: number) {
  const a = s.value.nodes[i]; const b = s.value.nodes[i + 1]
  const end = a?.t1 || a?.t0
  return b?.t0 && end && b.t0 - end > 120000 ? dur(b.t0 - end) : ''
}
const big = (n: SchemaNode) => n.steps.length > 0
</script>

<template>
  <div class="schema">
    <div class="sum">
      <span class="chip">{{ s.nodes.length }} этапов</span>
      <span class="chip">{{ s.steps }} шагов</span>
      <span
        v-if="s.span"
        class="chip"
      >{{ dur(s.span) }}</span>
      <span
        v-if="s.edits"
        class="chip"
      >✎ {{ s.edits }}</span>
      <span
        v-if="s.checks"
        class="chip"
      >✓ {{ s.checks }}</span>
    </div>

    <div
      v-if="!s.nodes.length"
      class="small empty"
    >
      Схема появится, когда бот начнёт работать
    </div>

    <ol class="axis">
      <template
        v-for="(n, i) in s.nodes"
        :key="n.id"
      >
        <li
          class="row"
          :class="[i % 2 ? 'r' : 'l', n.kind, { last: live && i === s.nodes.length - 1 }]"
        >
          <span class="dot" />
          <div
            class="card"
            :class="{ err: n.errors || n.kind === 'error' }"
          >
            <button
              class="head"
              @click="big(n) ? (open[n.id] = !open[n.id]) : emit('jump', n.ei)"
            >
              <span class="ic">{{ PHASE[n.kind].icon }}</span>
              <span class="body">
                <span
                  v-if="when(n)"
                  class="time"
                >{{ when(n) }}<i v-if="length(n)"> ({{ length(n) }})</i></span>
                <b>{{ n.title }}</b>
                <small v-if="n.sub">{{ n.sub }}</small>
              </span>
              <span
                v-if="big(n)"
                class="chev"
                :class="{ on: open[n.id] }"
              >›</span>
            </button>
            <div
              v-if="open[n.id]"
              class="steps"
            >
              <button
                v-for="st in (all[n.id] ? n.steps : n.steps.slice(0, 12))"
                :key="st.ei + st.label"
                class="step"
                :class="{ bad: st.error }"
                :title="st.label"
                @click="emit('jump', st.ei)"
              >
                {{ st.label }}
              </button>
              <button
                v-if="!all[n.id] && n.steps.length > 12"
                class="btn ghost sm"
                @click="all[n.id] = true"
              >
                Ещё {{ n.steps.length - 12 }}
              </button>
              <div
                v-if="n.files.length"
                class="files"
              >
                <code
                  v-for="f in n.files"
                  :key="f"
                >{{ f }}</code>
              </div>
              <button
                class="btn sm"
                @click="emit('jump', n.ei)"
              >
                Показать в ленте
              </button>
            </div>
          </div>
        </li>
        <li
          v-if="gap(i)"
          class="gap"
        >
          <span>пауза {{ gap(i) }}</span>
        </li>
      </template>
    </ol>
  </div>
</template>

<style scoped lang="scss">
.schema {
  padding: 8px 0 24px;
}
.sum {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}
.chip {
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--sunk);
  color: var(--muted);
}
.empty {
  padding: 24px 0;
  text-align: center;
}
.axis {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
  // ось по центру
  &::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 6px;
    bottom: 6px;
    width: 2px;
    margin-left: -1px;
    background: repeating-linear-gradient(to bottom, var(--line) 0 6px, transparent 6px 10px);
  }
}
.row {
  --k: var(--muted);
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1fr);
  align-items: center;
  margin: 6px 0;
  .dot {
    grid-column: 2;
    grid-row: 1;
    justify-self: center;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--k);
    box-shadow: 0 0 0 4px var(--bg);
    z-index: 1;
  }
  .card {
    grid-row: 1;
    position: relative;
    // соединитель от точки к карточке
    &::before {
      content: '';
      position: absolute;
      top: 50%;
      width: 18px;
      border-top: 2px dashed color-mix(in srgb, var(--k) 60%, transparent);
    }
  }
  &.l .card {
    grid-column: 1;
    &::before {
      right: -18px;
    }
  }
  &.r .card {
    grid-column: 3;
    &::before {
      left: -18px;
    }
  }
  &.edit { --k: var(--accent); }
  &.check { --k: var(--warn); }
  &.pr, &.end { --k: var(--ok); }
  &.error { --k: var(--bad); }
  &.ask, &.answer { --k: var(--accent); }
  &.last .dot {
    animation: pulse 1.4s ease-in-out infinite;
  }
}
@keyframes pulse {
  50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--k) 25%, transparent); }
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  overflow: hidden;
  &.err {
    border-color: color-mix(in srgb, var(--bad) 45%, var(--line));
  }
}
.head {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  &:hover {
    background: var(--sunk);
  }
}
.ic {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 14px;
  color: var(--k);
  background: color-mix(in srgb, var(--k) 14%, transparent);
}
.body {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 1px;
  b {
    font-size: 13.5px;
    font-weight: 600;
  }
  small {
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.time {
  font-size: 11.5px;
  color: var(--muted);
  i {
    font-style: normal;
    opacity: 0.8;
  }
}
.chev {
  color: var(--muted);
  transition: transform 0.15s;
  &.on {
    transform: rotate(90deg);
  }
}
.steps {
  border-top: 1px solid var(--line);
  padding: 6px;
  display: grid;
  gap: 2px;
  .btn {
    justify-self: start;
    margin: 4px 4px 2px;
  }
}
.step {
  all: unset;
  box-sizing: border-box;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  &:hover {
    background: var(--sunk);
  }
  &.bad {
    color: var(--bad);
  }
}
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 6px;
  code {
    font-size: 11px;
  }
}
.gap {
  position: relative;
  display: grid;
  justify-items: center;
  margin: 2px 0;
  span {
    position: relative;
    z-index: 1;
    font-size: 11.5px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1.5px solid var(--ok);
    color: var(--ok);
    background: var(--bg);
  }
}
// узко — одна колонка: ось слева
@media (max-width: 1100px) {
  .axis::before {
    left: 18px;
  }
  .row {
    grid-template-columns: 36px minmax(0, 1fr);
    .dot {
      grid-column: 1;
    }
    &.l .card,
    &.r .card {
      grid-column: 2;
      &::before {
        left: -18px;
        right: auto;
      }
    }
  }
  .gap {
    justify-items: start;
    padding-left: 0;
  }
}
</style>
