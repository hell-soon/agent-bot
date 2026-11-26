// Мини-доска «Разработки фичи»: шаги, заметки и стрелки зависимостей (from → to: «to» делается после «from»).
// Чистые функции без ввода-вывода: сервер хранит доску в run.board, бот присылает план блоком ```plan {json}```.
// Первый план бота ложится на пустую доску сразу, следующие — предложениями (принять / отклонить).

import { acceptSketch, describeMarks, describeSketches, mergeSketches, parseSketches, sketchesForBot, sketchNear, sketchOp } from './featureSketch.mjs'

const COL = 270 // шаг сетки раскладки по горизонтали (ширина карточки 220 + зазор)
const ROW = 150 // и по вертикали
const PAD = 40
const MAX_ITEMS = 60
const MAX_POS = 6000
const ID_RE = /^[\w-]{1,40}$/

const clip = (s, n) => String(s ?? '').trim().slice(0, n)
const clone = b => JSON.parse(JSON.stringify(b))
const key = (a, b) => `${a}>${b}`

export function emptyBoard() {
  return {
    rev: 0,
    seq: 0,
    items: [],
    links: [],
    suggestions: [],
    sketches: [],
    marks: [],
  }
}

function normItem(raw) {
  const type = raw?.type === 'note'
    ? 'note'
    : 'step'
  const text = clip(raw?.text, 2000)
  const title = clip(raw?.title, 120) || (type === 'step'
    ? clip(text.split('\n')[0], 80)
    : '')
  return { type, title, text }
}

// есть ли путь from → … → to по стрелкам
function reaches(links, from, to) {
  const seen = new Set([from])
  const stack = [from]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === to)
      return true
    for (const l of links) {
      if (l.from === cur && !seen.has(l.to)) { seen.add(l.to); stack.push(l.to) }
    }
  }
  return false
}
const makesCycle = (links, from, to) => from === to || reaches(links, to, from)

// Последний блок ```plan в ответе бота → { items, links } или null (блока нет или он битый)
export function parsePlan(text) {
  const blocks = [
    ...String(text || '').matchAll(/```plan[ \t]*\r?\n([\s\S]*?)```/g),
  ]
  if (!blocks.length)
    return null
  let data
  try { data = JSON.parse(blocks[blocks.length - 1][1]) }
  catch { return null }
  if (!data || !Array.isArray(data.items))
    return null
  const items = []
  const ids = new Set()
  let n = 0
  for (const raw of data.items.slice(0, MAX_ITEMS)) {
    const it = normItem(raw)
    if (!it.title && !it.text)
      continue
    let id = String(raw?.id ?? '')
    if (!ID_RE.test(id) || ids.has(id)) {
      do id = `x${++n}`; while (ids.has(id))
    }
    ids.add(id)
    items.push({ id, ...it })
  }
  if (!items.length)
    return null
  const step = new Set(items.filter(i => i.type === 'step').map(i => i.id))
  const links = []
  for (const l of Array.isArray(data.links)
    ? data.links
    : []) {
    const from = String(Array.isArray(l)
      ? l[0]
      : l?.from)
    const to = String(Array.isArray(l)
      ? l[1]
      : l?.to)
    if (step.has(from) && step.has(to) && !links.some(x => x.from === from && x.to === to) && !makesCycle(links, from, to))
      links.push({ from, to })
  }
  return {
    items,
    links,
    sketches: parseSketches(data.sketches, step, ids),
  }
}

// глубина шага = длина самой длинной цепочки зависимостей до него (колонка раскладки)
function depths(ids, links) {
  const d = new Map(ids.map(id => [id, 0]))
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const l of links) {
      if (d.has(l.from) && d.has(l.to) && d.get(l.to) < d.get(l.from) + 1) { d.set(l.to, d.get(l.from) + 1); changed = true }
    }
    if (!changed)
      break
  }
  return d
}

// Раскладка с нуля: шаги — колонками по зависимостям, заметки — строкой ниже
export function layout(items, links) {
  const steps = items.filter(i => i.type === 'step')
  const d = depths(steps.map(s => s.id), links)
  const rows = new Map()
  const pos = new Map()
  let maxY = PAD - ROW
  for (const s of steps) {
    const col = d.get(s.id)
    const row = rows.get(col) || 0
    rows.set(col, row + 1)
    const p = { x: PAD + col * COL, y: PAD + row * ROW }
    pos.set(s.id, p)
    maxY = Math.max(maxY, p.y)
  }
  items.filter(i => i.type === 'note').forEach((nt, i) => pos.set(nt.id, { x: PAD + i * COL, y: maxY + ROW }))
  return pos
}

// Свободное место для нового элемента: в колонке по зависимостям (заметки — в первой), ниже всего, что там уже стоит
function freeSpot(taken, col) {
  const x = PAD + col * COL
  const below = taken.filter(p => Math.abs(p.x - x) < COL / 2).map(p => p.y + ROW)
  return {
    x,
    y: below.length
      ? Math.max(...below)
      : PAD,
  }
}

function nextId(b, prefix) {
  const used = new Set([
    ...b.items.map(i => i.id),
    ...b.suggestions.map(s => s.item?.id).filter(Boolean),
  ])
  let id
  do id = `${prefix}${++b.seq}`; while (used.has(id))
  return id
}

// эскизы плана с привязкой к шагам после переименования id
function planSketches(plan, idOf) {
  return (plan.sketches || []).map(k => ({
    ...k,
    step: idOf(k.step),
  }))
}

// План бота → доска. Первый план ложится сразу; следующие — предложения (прежние неразобранные заменяются новыми)
export function mergeBotPlan(board, plan) {
  const b = clone(board || emptyBoard())
  b.rev++
  if (!b.items.some(i => i.by === 'bot') && !b.suggestions.length) {
    // карточки, которые человек успел добавить, пока бот думал, остаются — строкой под планом
    const taken = new Set(b.items.map(i => i.id))
    const ren = new Map(plan.items.filter(i => taken.has(i.id)).map(i => [
      i.id,
      nextId(b, 'b'),
    ]))
    const idOf = id => ren.get(id) || id
    const items = plan.items.map(i => ({
      ...i,
      id: idOf(i.id),
    }))
    const links = plan.links.map(l => ({
      from: idOf(l.from),
      to: idOf(l.to),
    }))
    const at = layout(items, links)
    const bottom = Math.max(PAD - ROW, ...[
      ...at.values(),
    ].map(p => p.y)) + ROW
    b.items.forEach((it, i) => Object.assign(it, { x: PAD + i * COL, y: bottom }))
    b.items.push(...items.map(i => ({
      ...i,
      ...at.get(i.id),
      by: 'bot',
    })))
    b.links.push(...links)
    mergeSketches(b, planSketches(plan, idOf), true)
    return b
  }
  b.suggestions = []
  const have = new Map(b.items.map(i => [i.id, i]))
  const remap = new Map() // id из плана, занятый элементом другого типа → новый id
  for (const it of plan.items) {
    const cur = have.get(it.id)
    if (cur && cur.type !== it.type)
      remap.set(it.id, nextId(b, 'b'))
  }
  const idOf = id => remap.get(id) || id
  const planLinks = plan.links.map(l => ({
    from: idOf(l.from),
    to: idOf(l.to),
  }))
  const inPlan = new Set(plan.items.map(i => idOf(i.id)))
  // куда ставить новые шаги: колонка — по глубине в будущем графе
  const futureSteps = [
    ...b.items.filter(i => i.type === 'step').map(i => i.id),
    ...plan.items.filter(i => i.type === 'step' && !have.has(idOf(i.id))).map(i => idOf(i.id)),
  ]
  const d = depths(futureSteps, [
    ...b.links,
    ...planLinks,
  ])
  const taken = b.items.map(i => ({ x: i.x, y: i.y }))
  const sug = s => b.suggestions.push({ id: `p${++b.seq}`, ...s })
  for (const it of plan.items) {
    const id = idOf(it.id)
    const cur = have.get(id)
    if (!cur) {
      const p = freeSpot(taken, it.type === 'step'
        ? d.get(id) || 0
        : 0)
      taken.push(p)
      sug({
        kind: 'add',
        item: {
          id,
          type: it.type,
          title: it.title,
          text: it.text,
          ...p,
        },
      })
    }
    else if (cur.title !== it.title || cur.text !== it.text) {
      sug({
        kind: 'edit',
        target: id,
        title: it.title,
        text: it.text,
      })
    }
  }
  for (const it of b.items) {
    if (!inPlan.has(it.id))
      sug({ kind: 'remove', target: it.id })
  }
  const was = new Set(b.links.map(l => key(l.from, l.to)))
  const now = new Set(planLinks.map(l => key(l.from, l.to)))
  for (const l of planLinks) {
    if (!was.has(key(l.from, l.to)))
      sug({ kind: 'link', from: l.from, to: l.to })
  }
  for (const l of b.links) {
    if (!now.has(key(l.from, l.to)) && inPlan.has(l.from) && inPlan.has(l.to))
      sug({ kind: 'unlink', from: l.from, to: l.to })
  }
  // эскизы, которых нет в новом плане, не удаляются: бот мог их просто не повторить
  mergeSketches(b, planSketches(plan, idOf), false, sug)
  return b
}

const pending = (b, id) => b.suggestions.find(s => s.kind === 'add' && s.item.id === id)
const touches = (s, id) => s.target === id || s.from === id || s.to === id || s.item?.id === id

function removeItem(b, id) {
  b.items = b.items.filter(i => i.id !== id)
  b.links = b.links.filter(l => l.from !== id && l.to !== id)
  b.suggestions = b.suggestions.filter(s => !touches(s, id))
  for (const sk of b.sketches || []) {
    if (sk.step === id)
      sk.step = ''
  }
}

function addLink(b, from, to) {
  const a = b.items.find(i => i.id === from)
  const z = b.items.find(i => i.id === to)
  if (!a || !z)
    return 'Нет такого элемента'
  if (a.type !== 'step' || z.type !== 'step')
    return 'Стрелки — только между шагами'
  if (b.links.some(l => l.from === from && l.to === to))
    return ''
  if (makesCycle(b.links, from, to))
    return 'Эта стрелка замкнёт круг зависимостей'
  b.links.push({ from, to })
  return ''
}

function accept(b, s) {
  b.suggestions = b.suggestions.filter(x => x !== s)
  if (s.kind === 'add') {
    if (b.items.length >= MAX_ITEMS)
      return 'На доске уже слишком много элементов'
    b.items.push({ ...s.item, by: 'bot' })
    return ''
  }
  if (s.kind === 'edit') {
    const it = b.items.find(i => i.id === s.target)
    if (!it)
      return 'Элемент уже удалён'
    Object.assign(it, { title: s.title, text: s.text })
    return ''
  }
  if (s.kind === 'remove') { removeItem(b, s.target); return '' }
  if (s.kind === 'sketch') {
    // эскиз к ещё не принятому новому шагу — принимаем и шаг, чтобы привязка не потерялась
    const add = pending(b, s.sketch.step)
    const err = add && accept(b, add)
    return err || acceptSketch(b, s)
  }
  if (s.kind === 'unlink') { b.links = b.links.filter(l => !(l.from === s.from && l.to === s.to)); return '' }
  // link: если конец стрелки — ещё не принятый новый шаг, принимаем и его
  for (const id of [s.from, s.to]) {
    const add = pending(b, id)
    if (add) {
      const err = accept(b, add)
      if (err)
        return err
    }
  }
  return addLink(b, s.from, s.to)
}

const pos = v => Math.max(0, Math.min(MAX_POS, Math.round(Number(v) || 0)))

// Правка доски человеком или разбор предложений. Возвращает { board } или { error }
export function applyOp(board, op) {
  const b = clone(board || emptyBoard())
  const find = id => b.items.find(i => i.id === id)
  let err = ''
  let added = ''
  switch (op?.op) {
    case 'add': {
      if (b.items.length >= MAX_ITEMS)
        return { error: 'На доске уже слишком много элементов' }
      const it = normItem(op)
      if (!it.title && !it.text) {
        it.title = it.type === 'step'
          ? 'Новый шаг'
          : ''
      }
      const spot = op.x === undefined || op.y === undefined
        ? freeSpot(b.items.map(i => ({ x: i.x, y: i.y })), 0)
        : {
            x: pos(op.x),
            y: pos(op.y),
          }
      const id = nextId(b, 'u')
      b.items.push({
        id,
        ...it,
        ...spot,
        by: 'user',
      })
      added = id
      break
    }
    case 'edit': {
      const it = find(op.id)
      if (!it)
        return { error: 'Нет такого элемента' }
      const n = normItem({ type: it.type, title: op.title ?? it.title, text: op.text ?? it.text })
      it.title = n.title; it.text = n.text
      break
    }
    case 'move': {
      const it = find(op.id)
      if (!it)
        return { error: 'Нет такого элемента' }
      it.x = pos(op.x); it.y = pos(op.y)
      break
    }
    case 'remove':
      if (!find(op.id))
        return { error: 'Нет такого элемента' }
      removeItem(b, op.id)
      break
    case 'link':
      err = addLink(b, String(op.from), String(op.to))
      break
    case 'unlink':
      b.links = b.links.filter(l => !(l.from === op.from && l.to === op.to))
      break
    case 'accept': {
      const s = b.suggestions.find(x => x.id === op.id)
      if (!s)
        return { error: 'Предложение уже разобрано' }
      err = accept(b, s)
      break
    }
    case 'reject': {
      const s = b.suggestions.find(x => x.id === op.id)
      if (!s)
        return { error: 'Предложение уже разобрано' }
      b.suggestions = b.suggestions.filter(x => x !== s && !(s.kind === 'add' && touches(x, s.item.id)))
      break
    }
    case 'acceptAll': {
      const order = [
        'add',
        'edit',
        'sketch',
        'link',
        'unlink',
        'remove',
      ]
      const all = [...b.suggestions].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind))
      for (const s of all) {
        if (b.suggestions.includes(s))
          accept(b, s) // что не встало (круг, удалённый элемент) — просто пропускаем
      }
      b.suggestions = []
      break
    }
    case 'rejectAll':
      b.suggestions = []
      break
    default: {
      const r = sketchOp(b, op || {})
      if (!r)
        return { error: 'Неизвестное действие с доской' }
      err = r.error || ''
      added = r.id || ''
    }
  }
  if (err)
    return { error: err }
  b.rev++
  return added
    ? { board: b, id: added }
    : { board: b }
}

// Шаги в порядке зависимостей (Кан); при равенстве — как стоят на доске: слева направо, сверху вниз
export function orderedSteps(board) {
  const steps = board.items.filter(i => i.type === 'step')
  const links = board.links.filter(l => steps.some(s => s.id === l.from) && steps.some(s => s.id === l.to))
  const indeg = new Map(steps.map(s => [s.id, 0]))
  for (const l of links) indeg.set(l.to, indeg.get(l.to) + 1)
  const byPlace = (a, z) => a.x - z.x || a.y - z.y
  const ready = steps.filter(s => !indeg.get(s.id)).sort(byPlace)
  const out = []
  while (ready.length) {
    const s = ready.shift()
    out.push(s)
    for (const l of links.filter(x => x.from === s.id)) {
      indeg.set(l.to, indeg.get(l.to) - 1)
      if (!indeg.get(l.to)) { ready.push(steps.find(x => x.id === l.to)); ready.sort(byPlace) }
    }
  }
  return out.length === steps.length
    ? out
    : steps.slice().sort(byPlace)
}

// Текущая доска для бота — к каждому сообщению, пока план не утверждён (человек мог её поправить)
export function boardForBot(board) {
  if (!board?.items?.length && !board?.sketches?.length)
    return ''
  const plan = {
    items: board.items.map(({ id, type, title, text }) => ({ id, type, title, text })),
    links: board.links.map(l => [l.from, l.to]),
    sketches: sketchesForBot(board),
  }
  const marks = describeMarks(board)
  const marked = marks.length
    ? `\nПометки человека от руки:\n${marks.join('\n')}`
    : ''
  return `\n\n---\nТекущая доска плана (с правками человека — они главнее твоих прежних):\n\`\`\`plan\n${JSON.stringify(plan)}\n\`\`\`${marked}\nМеняешь план — пришли его целиком новым блоком \`\`\`plan с теми же id; человек примет или отклонит изменения.`
}

// Как боту спросить человека посреди работы: блок ```question ставит запуск на паузу и открывает доску
export const QUESTION_HELP = [
  'Если без ответа человека дальше нельзя (выбор поведения, неясность в плане) — не гадай, а спроси:',
  '1. Закоммить сделанное в свою ветку (git add -A, git commit -m "WIP бота: до ответа", без пуша) — пока ждёшь ответа, копией репозитория пользуются другие задачи.',
  '2. Закончи ответ блоком (один вопрос — один блок) и сразу закончи ход, больше ничего не меняй:',
  '```question',
  '{"step": "s2", "text": "Вопрос целиком, понятный без остального текста?", "options": ["Вариант (Рекомендую)", "Другой вариант"],',
  ' "sketches": [{"id": "q1", "step": "s2", "title": "Вариант А", "w": 240, "h": 420, "shapes": [{"id": "b1", "type": "button", "x": 196, "y": 8, "w": 36, "h": 36, "label": "✕"}]}]}',
  '```',
  'step — id шага из плана, к которому вопрос; options — 2–4 варианта или []; sketches — по желанию, если варианты проще показать на эскизе (формат — как в плане). Человек ответит или поправит доску и нажмёт «Продолжить работу».',
].join('\n')

// Сообщение боту по кнопке «Начать работу»: исходная задача + утверждённый план
export function approvedPlanText(board, task) {
  return [
    'План утверждён — теперь можно менять код.',
    '',
    '## Исходная задача',
    clip(task, 4000) || '—',
    '',
    '## Утверждённый план',
    ...planSections(board),
    '',
    'Реализуй план по шагам в порядке зависимостей. Работай в новой ветке agent/<кратко> от свежей базовой ветки (git fetch origin, затем checkout от origin), не в базовой. Сделай проверки проекта, закоммить, запушь и открой PR в базовую ветку — по правилам из системного промпта. В описании PR — исходная задача и план. Если по ходу план приходится менять — коротко объясни в PR, что и почему.',
    '',
    QUESTION_HELP,
  ].join('\n')
}

// Шаги, заметки, эскизы и пометки доски — текстом для бота (без заголовка раздела)
export function planSections(board) {
  const steps = orderedSteps(board)
  const num = new Map(steps.map((s, i) => [s.id, i + 1]))
  const lines = steps.map((s) => {
    const after = board.links.filter(l => l.to === s.id && num.has(l.from)).map(l => num.get(l.from)).sort((a, z) => a - z)
    const head = `${num.get(s.id)}. ${s.title || 'Шаг'}${after.length
      ? ` (после ${after.join(', ')})`
      : ''}`
    const body = s.text && s.text !== s.title
      ? `\n   ${s.text.replace(/\n/g, '\n   ')}`
      : ''
    return head + body
  })
  // заметка, положенная рядом с эскизом, — про него
  const notes = board.items.filter(i => i.type === 'note' && (i.title || i.text)).map((nt) => {
    const sk = sketchNear(board, nt)
    return `- ${[nt.title, nt.text].filter(Boolean).join(': ')}${sk
      ? ` (у эскиза «${sk.title || sk.id}»)`
      : ''}`
  })
  const sketches = describeSketches(board, id => board.items.find(i => i.id === id)?.title || id)
  const marks = describeMarks(board)
  return [
    ...lines,
    ...(notes.length
      ? ['', '## Заметки', ...notes]
      : []),
    ...(sketches.length
      ? [
          '',
          '## Эскизы интерфейса',
          'Координаты блоков — в пикселях внутри эскиза, от левого верхнего угла. Человек мог их передвинуть и переподписать — делай по этой версии.',
          ...sketches,
        ]
      : []),
    ...(marks.length
      ? ['', '## Пометки человека от руки', ...marks]
      : []),
  ]
}
