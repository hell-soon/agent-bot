<script setup lang="ts">
import { computed } from 'vue'
import { aiName, greeting, modKey, money, startOfDay, tok } from '../lib/format'
import { newTask, repoRuns, resetRepo, runAction, select, shownAi, startJob, store, toast } from '../lib/store'
import Composer from './Composer.vue'
import Icon from './Icon.vue'

interface Card {
  kind: string
  dot: string
  label: string
  title: string
  run?: any
  pr?: any
  issue?: any
}

const cards = computed<Card[]>(() => {
  const out: Card[] = []
  for (const r of repoRuns.value.filter(r => r.status === 'waiting').slice(0, 3)) {
    out.push({
      kind: 'wait',
      dot: '',
      label: 'Ждёт вашего ответа',
      title: r.title,
      run: r,
    })
  }
  for (const r of repoRuns.value.filter(r => r.status === 'failed' || r.status === 'limited').slice(0, 2)) {
    out.push({
      kind: 'fail',
      dot: r.status === 'limited'
        ? 'warn'
        : 'bad',
      label: r.status === 'limited'
        ? 'Ждёт лимита'
        : 'Не получилось',
      title: r.title,
      run: r,
    })
  }
  for (const p of store.gh.prs.slice(0, 4)) {
    out.push({
      kind: 'pr',
      dot: 'ok',
      label: `PR ждёт ревью${p.author?.is_bot ? ' · от бота' : ''}`,
      title: `#${p.number} ${p.title}`,
      pr: p,
    })
  }
  for (const i of store.gh.issues.filter(i => i.labels.includes('ready-for-agent') && !i.labels.includes('in-progress')).slice(0, 4)) {
    const size = i.labels.find((l: string) => l.startsWith('size:'))
    out.push({
      kind: 'issue',
      dot: '',
      label: `Готово для бота${size
        ? ` · ${size}`
        : ''}`,
      title: `#${i.number} ${i.title}`,
      issue: i,
    })
  }
  return out
})
const stats = computed(() => {
  const day = startOfDay()
  const todays = repoRuns.value.filter(r => (r.endedAt || r.startedAt || r.createdAt) >= day)
  const t = todays.reduce((a, r) => ({ cost: a.cost + (r.cost || 0), tokIn: a.tokIn + (r.tokIn || 0), tokOut: a.tokOut + (r.tokOut || 0) }), { cost: 0, tokIn: 0, tokOut: 0 })
  return [
    [todays.length, 'задач сегодня'],
    [todays.filter(r => r.prUrl).length, 'PR'],
    ...(shownAi.value === 'codex'
      ? []
      : [
          [money(t.cost) || '$0', 'потрачено'],
        ]),
    [
      tok((t.tokIn || 0) + (t.tokOut || 0)),
      'токенов',
    ],
    [store.gh.issues.length, 'открытых issue'],
  ]
})
async function doIssue(n: number) {
  try {
    await startJob({
      kind: 'issue',
      issue: String(n),
    })
  }
  catch (e: any) { toast(e.message) }
}
function fixPr(n: number) { store.compose.prPick = String(n); newTask('pr') }
async function discard() {
  if (
    confirm('Удалить эти изменения из копии бота? Ваша рабочая папка не затрагивается.')
  )
    await resetRepo()
}
</script>

<template>
  <div class="home">
    <div class="hello">
      <h1>
        <span class="mark"><icon
          name="bot"
          :size="21"
        /></span>{{ greeting() }}
      </h1>
      <p>{{ aiName(store.cfg.ai) }} работает в фоне в своей копии <b>{{ store.curRepo.split('/')[1] }}</b> и приносит PR — сливаете вы.</p>
    </div>

    <div
      v-if="store.repoDirty"
      class="banner"
    >
      <div class="grow">
        <b>В копии бота остались несохранённые изменения</b> — следующий запуск не начнётся.<pre>{{ store.repoDirty }}</pre>
      </div>
      <button
        class="btn sm"
        @click="discard"
      >
        Отбросить
      </button>
    </div>

    <composer />

    <section class="attn">
      <h2>Требует внимания</h2>
      <div
        v-if="cards.length"
        class="cards"
      >
        <div
          v-for="(cd, i) in cards"
          :key="i"
          class="card"
        >
          <div class="k">
            <span
              class="dot"
              :class="cd.dot"
            />{{ cd.label }}
          </div>
          <div class="t">
            {{ cd.title }}
          </div>
          <div class="a">
            <button
              v-if="cd.kind === 'wait'"
              class="btn sm primary"
              @click="select(cd.run.id)"
            >
              Ответить
            </button>
            <template v-if="cd.kind === 'fail'">
              <button
                class="btn sm"
                @click="select(cd.run.id)"
              >
                Открыть
              </button>
              <button
                v-if="cd.run.sessionId"
                class="btn sm ghost"
                @click="runAction(cd.run.id, 'continue')"
              >
                Продолжить
              </button>
            </template>
            <template v-if="cd.kind === 'pr'">
              <a
                class="btn sm"
                :href="cd.pr.url"
                target="_blank"
              >Открыть ↗</a>
              <button
                class="btn sm ghost"
                @click="fixPr(cd.pr.number)"
              >
                Поправить
              </button>
            </template>
            <button
              v-if="cd.kind === 'issue'"
              class="btn sm primary"
              @click="doIssue(cd.issue.number)"
            >
              Сделать
            </button>
          </div>
        </div>
      </div>
      <div
        v-else
        class="calm"
      >
        <b>Всё спокойно.</b>
        <span>Опишите задачу выше — или поставьте метку <code>ready-for-agent</code> на issue: они появятся здесь с кнопкой «Сделать». Поиск и команды — <kbd>{{ modKey }}K</kbd>.</span>
      </div>
    </section>

    <div class="stats">
      <div
        v-for="[v, l] in stats"
        :key="l"
      >
        <b>{{ v }}</b>{{ l }}
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.home {
  width: min(760px, calc(100% - 40px));
  margin: 0 auto;
  padding: 6vh 0 60px;
}
.hello {
  h1 {
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -0.025em;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mark {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    :deep(.icon) {
      stroke-width: 2;
    }
  }
  p {
    margin: 6px 0 22px;
    color: var(--muted);
  }
}
.banner {
  margin-bottom: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 13px;
  display: flex;
  gap: 12px;
  align-items: center;
  .grow {
    flex: 1;
    min-width: 0;
  }
  pre {
    margin: 4px 0 0;
    background: transparent;
    padding: 0;
    max-height: 70px;
  }
}
.attn {
  margin-top: 28px;
  h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    margin: 0 0 10px 2px;
  }
}
.cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
  align-content: start;
  .k {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--muted);
    font-weight: 500;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    &.ok {
      background: var(--ok);
    }
    &.bad {
      background: var(--bad);
    }
    &.warn {
      background: var(--warn);
    }
  }
  .t {
    font-weight: 500;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .a {
    display: flex;
    gap: 6px;
  }
}
.calm {
  background: var(--card);
  border: 1px dashed var(--line);
  border-radius: 14px;
  padding: 18px;
  color: var(--muted);
  font-size: 13.5px;
  display: grid;
  gap: 6px;
  b {
    color: var(--text);
  }
}
.stats {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  margin: 28px 2px 0;
  font-size: 13px;
  color: var(--muted);
  b {
    display: block;
    font-size: 20px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
}
@media (max-width: 820px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
