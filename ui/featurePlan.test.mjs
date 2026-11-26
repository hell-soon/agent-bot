import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Use Node's built-in runner without adding a dependency.
import { it } from 'node:test'
import { applyOp, approvedPlanText, boardForBot, emptyBoard, mergeBotPlan, orderedSteps, parsePlan } from './featurePlan.mjs'

const planText = plan => `Вот план.\n\`\`\`plan\n${JSON.stringify(plan)}\n\`\`\`\nНравится?`
const PLAN = {
  items: [
    {
      id: 's1',
      type: 'step',
      title: 'API',
      text: 'Ручка /api/x',
    },
    {
      id: 's2',
      type: 'step',
      title: 'UI',
      text: 'Экран',
    },
    { id: 'n1', type: 'note', text: 'Риск: старые данные' },
  ],
  links: [
    ['s1', 's2'],
  ],
}
function ok(r) {
  assert.equal(r.error, undefined, r.error)
  return r.board
}
const firstBoard = () => mergeBotPlan(emptyBoard(), parsePlan(planText(PLAN)))

it('parsePlan берёт последний блок и отбрасывает мусор', () => {
  assert.equal(parsePlan('просто текст'), null)
  assert.equal(parsePlan('```plan\nне json\n```'), null)
  const p = parsePlan(`${planText({
    items: [
      { id: 'old', title: 'x' },
    ],
  })}\n${planText({
    items: [
      { id: 'a', title: 'A' },
      { id: 'a', title: 'Дубль' },
      { id: 'n', type: 'note', text: 'N' },
      { title: '', text: '' },
    ],
    links: [
      ['a', 'x1'],
      ['a', 'n'],
      ['a', 'a'],
      ['missing', 'a'],
    ],
  })}`)
  assert.deepEqual(p.items.map(i => i.id), ['a', 'x1', 'n'])
  assert.deepEqual(p.links, [
    { from: 'a', to: 'x1' },
  ]) // заметки, петли и неизвестные id — без стрелок
})

it('parsePlan не пропускает круг зависимостей', () => {
  const p = parsePlan(planText({
    items: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ],
    links: [
      ['a', 'b'],
      ['b', 'a'],
    ],
  }))
  assert.deepEqual(p.links, [
    { from: 'a', to: 'b' },
  ])
})

it('первый план ложится на пустую доску сразу, с раскладкой по зависимостям', () => {
  const b = firstBoard()
  assert.equal(b.suggestions.length, 0)
  const [s1, s2, n1] = b.items
  assert.equal(s1.by, 'bot')
  assert.ok(s2.x > s1.x, 'зависимый шаг правее')
  assert.ok(n1.y > s1.y, 'заметки ниже шагов')
  assert.deepEqual(b.links, [
    { from: 's1', to: 's2' },
  ])
})

it('следующий план бота — предложения, а не правки доски', () => {
  const b = mergeBotPlan(firstBoard(), parsePlan(planText({
    items: [
      {
        id: 's1',
        type: 'step',
        title: 'API v2',
        text: 'Ручка /api/x',
      },
      {
        id: 's2',
        type: 'step',
        title: 'UI',
        text: 'Экран',
      },
      {
        id: 's3',
        type: 'step',
        title: 'Тесты',
        text: '',
      },
    ],
    links: [
      ['s1', 's3'],
    ],
  })))
  assert.equal(b.items.find(i => i.id === 's1').title, 'API', 'доска не меняется сама')
  const kinds = b.suggestions.map(s => `${s.kind}:${s.target || s.item?.id || `${s.from}>${s.to}`}`).sort()
  assert.deepEqual(kinds, [
    'add:s3',
    'edit:s1',
    'link:s1>s3',
    'remove:n1',
    'unlink:s1>s2',
  ])
  const add = b.suggestions.find(s => s.kind === 'add')
  assert.ok(add.item.x > b.items[0].x, 'новый зависимый шаг ставится правее')
})

it('принять и отклонить предложения', () => {
  let b = mergeBotPlan(firstBoard(), parsePlan(planText({
    items: [
      ...PLAN.items,
      { id: 's3', type: 'step', title: 'Тесты' },
    ],
    links: [
      ['s1', 's2'],
      ['s2', 's3'],
    ],
  })))
  const link = b.suggestions.find(s => s.kind === 'link')
  b = ok(applyOp(b, { op: 'accept', id: link.id })) // стрелка к новому шагу принимает и сам шаг
  assert.ok(b.items.some(i => i.id === 's3' && i.by === 'bot'))
  assert.deepEqual(b.links.at(-1), { from: 's2', to: 's3' })
  assert.equal(b.suggestions.length, 0)

  let c = mergeBotPlan(firstBoard(), parsePlan(planText({
    items: [
      ...PLAN.items,
      { id: 's3', title: 'X' },
    ],
    links: [
      ['s1', 's2'],
      ['s2', 's3'],
    ],
  })))
  const add = c.suggestions.find(s => s.kind === 'add')
  c = ok(applyOp(c, { op: 'reject', id: add.id }))
  assert.equal(c.suggestions.length, 0, 'вместе с шагом уходят и его стрелки')
  assert.ok(!c.items.some(i => i.id === 's3'))
  assert.ok(applyOp(c, { op: 'accept', id: add.id }).error)
})

it('принять всё: что не встаёт — пропускается', () => {
  let b = mergeBotPlan(firstBoard(), parsePlan(planText({
    items: [
      { id: 's1', title: 'API', text: 'Ручка /api/x' },
      { id: 's2', title: 'UI 2', text: 'Экран' },
    ],
    links: [],
  })))
  b = ok(applyOp(b, { op: 'acceptAll' }))
  assert.deepEqual(b.items.map(i => i.id), ['s1', 's2'])
  assert.equal(b.items[1].title, 'UI 2')
  assert.deepEqual(b.links, [])
  assert.equal(b.suggestions.length, 0)
})

it('ручные правки: добавить, править, двигать, связать, удалить', () => {
  let b = firstBoard()
  const r = applyOp(b, { op: 'add', type: 'step', title: 'Доки' })
  b = ok(r)
  const id = r.id
  assert.equal(b.items.find(i => i.id === id).by, 'user')
  b = ok(applyOp(b, { op: 'edit', id, text: 'README' }))
  assert.equal(b.items.find(i => i.id === id).text, 'README')
  b = ok(applyOp(b, { op: 'move', id, x: 500.4, y: -20 }))
  assert.deepEqual([b.items.find(i => i.id === id).x, b.items.find(i => i.id === id).y], [500, 0])
  b = ok(applyOp(b, { op: 'link', from: 's2', to: id }))
  assert.match(applyOp(b, { op: 'link', from: id, to: 's1' }).error, /круг/)
  assert.match(applyOp(b, { op: 'link', from: 's1', to: 'n1' }).error, /между шагами/)
  b = ok(applyOp(b, { op: 'remove', id: 's2' }))
  assert.deepEqual(b.links, [], 'стрелки удалённого шага уходят')
  assert.ok(b.rev > firstBoard().rev)
})

it('порядок шагов и текст утверждённого плана', () => {
  let b = firstBoard()
  b = ok(applyOp(b, {
    op: 'add',
    type: 'step',
    title: 'Подготовка',
    x: 900,
    y: 0,
  }))
  const prep = b.items.at(-1).id
  b = ok(applyOp(b, { op: 'link', from: prep, to: 's1' }))
  assert.deepEqual(orderedSteps(b).map(s => s.title), ['Подготовка', 'API', 'UI'])
  const t = approvedPlanText(b, 'Сделать фичу X', 'agent/feature-123')
  assert.match(t, /## Исходная задача\nСделать фичу X/)
  assert.match(t, /1\. Подготовка\n2\. API \(после 1\)\n {3}Ручка \/api\/x\n3\. UI \(после 2\)/)
  assert.match(t, /## Заметки\n- Риск: старые данные/)
  assert.match(t, /Работай в ветке agent\/feature-123/)
  assert.match(t, /открой PR в базовую ветку/)
})

it('доска для бота — блоком plan, который снова разбирается', () => {
  assert.equal(boardForBot(emptyBoard()), '')
  const p = parsePlan(boardForBot(firstBoard()))
  assert.deepEqual(p.items.map(i => i.id), ['s1', 's2', 'n1'])
  assert.deepEqual(p.links, [
    { from: 's1', to: 's2' },
  ])
})

it('первый план ложится сразу, даже если человек успел добавить свою карточку', () => {
  const r = applyOp(emptyBoard(), { op: 'add', type: 'note', text: 'Моё' })
  const b = mergeBotPlan(ok(r), parsePlan(planText({
    items: [
      { id: r.id, title: 'Шаг с тем же id' },
      ...PLAN.items,
    ],
    links: [],
  })))
  assert.equal(b.suggestions.length, 0)
  assert.equal(b.items.length, 5)
  const mine = b.items.find(i => i.id === r.id)
  assert.equal(mine.by, 'user')
  assert.ok(b.items.filter(i => i.by === 'bot').every(i => i.id !== r.id && i.y < mine.y), 'план выше, id не пересекаются')
})
