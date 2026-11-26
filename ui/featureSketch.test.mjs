import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Use Node's built-in runner without adding a dependency.
import { it } from 'node:test'
import { applyOp, approvedPlanText, boardForBot, emptyBoard, mergeBotPlan, parsePlan } from './featurePlan.mjs'
import { describeMarks, markTargets, normPoints } from './featureSketch.mjs'

const planText = plan => `План:\n\`\`\`plan\n${JSON.stringify(plan)}\n\`\`\``
const MENU = {
  id: 'k1',
  step: 's2',
  title: 'Мобильное меню',
  w: 240,
  h: 420,
  shapes: [
    {
      id: 'top',
      type: 'rect',
      x: 0,
      y: 0,
      w: 240,
      h: 48,
      label: 'Шапка',
    },
    {
      id: 'burger',
      type: 'button',
      x: 180,
      y: 8,
      w: 48,
      h: 32,
      label: 'Меню',
    },
    {
      id: 'hello',
      type: 'text',
      x: 16,
      y: 80,
      w: 200,
      h: 20,
      label: 'Привет',
    },
  ],
}
const PLAN = {
  items: [
    {
      id: 's1',
      type: 'step',
      title: 'API',
      text: 'Ручка',
    },
    {
      id: 's2',
      type: 'step',
      title: 'Меню',
      text: 'Экран меню',
    },
  ],
  links: [
    ['s1', 's2'],
  ],
  sketches: [MENU],
}
function ok(r) {
  assert.equal(r.error, undefined, r.error)
  return r.board
}
const first = () => mergeBotPlan(emptyBoard(), parsePlan(planText(PLAN)))

it('parsePlan читает эскизы: блоки, привязку к шагу, мусор отбрасывает', () => {
  const p = parsePlan(planText({
    ...PLAN,
    sketches: [
      MENU,
      {
        id: 's1',
        step: 'nope',
        shapes: [
          { type: 'weird', x: -5, label: 'x' },
          { id: 'a' },
          { id: 'a' },
        ],
      },
      { id: 'empty' },
    ],
  }))
  assert.equal(p.sketches.length, 2)
  assert.deepEqual(p.sketches[0].shapes.map(s => s.type), ['rect', 'button', 'text'])
  const odd = p.sketches[1]
  assert.notEqual(odd.id, 's1', 'id эскиза не совпадает с id шага')
  assert.equal(odd.step, '', 'привязка к несуществующему шагу сброшена')
  assert.equal(odd.shapes[0].type, 'rect')
  assert.equal(odd.shapes[0].x, 0)
  assert.equal(new Set(odd.shapes.map(s => s.id)).size, 3)
  assert.ok(odd.w >= 200 && odd.h >= 160, 'размер рамки — по блокам, не меньше минимума')
})

it('первый план кладёт эскиз на доску правее карточек', () => {
  const b = first()
  assert.equal(b.sketches.length, 1)
  const sk = b.sketches[0]
  assert.equal(sk.by, 'bot')
  assert.equal(sk.step, 's2')
  assert.ok(sk.x > Math.max(...b.items.map(i => i.x)), 'рамка не налезает на шаги')
  assert.equal(b.suggestions.length, 0)
})

it('следующий план предлагает новый и изменённый эскиз, незатронутый не трогает', () => {
  let b = first()
  b = ok(applyOp(b, {
    op: 'mark',
    on: 'k1',
    pts: [
      [170, 0],
      [240, 0],
      [240, 50],
      [170, 50],
      [172, 2],
    ],
  }))
  b = ok(applyOp(b, {
    op: 'shape',
    sketch: 'k1',
    id: 'burger',
    x: 10,
  }))
  // бот присылает тот же эскиз, что на доске (с правкой человека), — предложения нет
  const same = {
    ...MENU,
    shapes: MENU.shapes.map(s => s.id === 'burger'
      ? { ...s, x: 10 }
      : s),
  }
  b = mergeBotPlan(b, parsePlan(planText({
    ...PLAN,
    sketches: [same],
  })))
  assert.equal(b.suggestions.length, 0)
  // изменённый и новый
  const changed = { ...same, title: 'Меню v2' }
  const extra = {
    id: 'k2',
    title: 'Профиль',
    shapes: [
      { type: 'text', label: 'Имя' },
    ],
  }
  b = mergeBotPlan(b, parsePlan(planText({
    ...PLAN,
    sketches: [changed, extra],
  })))
  assert.deepEqual(b.suggestions.map(s => [s.kind, s.target || s.sketch.id]), [
    ['sketch', 'k1'],
    ['sketch', 'k2'],
  ])
  const x = b.sketches[0].x
  b = ok(applyOp(b, { op: 'acceptAll' }))
  assert.equal(b.sketches.length, 2)
  assert.equal(b.sketches[0].title, 'Меню v2')
  assert.equal(b.sketches[0].x, x, 'позиция рамки не меняется')
  assert.equal(b.marks.length, 1, 'пометки человека на эскизе остаются')
  assert.ok(b.sketches[1].x >= b.sketches[0].x + b.sketches[0].w, 'новый эскиз — правее прежнего')
  // план без эскизов не предлагает их удалить
  b = mergeBotPlan(b, parsePlan(planText({ items: PLAN.items, links: PLAN.links })))
  assert.equal(b.suggestions.length, 0)
})

it('человек двигает, меняет размер и подпись блока, добавляет и удаляет блоки и эскизы', () => {
  let b = first()
  b = ok(applyOp(b, {
    op: 'shape',
    sketch: 'k1',
    id: 'burger',
    x: 12,
    y: 300,
    w: 216,
    h: 44,
    label: 'Открыть меню',
  }))
  const s = b.sketches[0].shapes.find(x => x.id === 'burger')
  assert.deepEqual([s.x, s.y, s.w, s.h, s.label], [12, 300, 216, 44, 'Открыть меню'])
  assert.equal(applyOp(b, {
    op: 'shape',
    sketch: 'k1',
    id: 'nope',
    x: 1,
  }).error, 'Нет такого блока')
  const r = applyOp(b, { op: 'addShape', sketch: 'k1', type: 'button' })
  b = ok(r)
  assert.equal(b.sketches[0].shapes.find(x => x.id === r.id).label, 'Кнопка')
  b = ok(applyOp(b, { op: 'removeShape', sketch: 'k1', id: 'hello' }))
  assert.ok(!b.sketches[0].shapes.some(x => x.id === 'hello'))
  b = ok(applyOp(b, {
    op: 'sketch',
    id: 'k1',
    x: 900,
    y: 0,
    w: 50,
    title: 'Меню',
  }))
  assert.deepEqual([b.sketches[0].x, b.sketches[0].w, b.sketches[0].title], [900, 120, 'Меню'])
  assert.ok(b.sketches[0].y >= 26, 'заголовок рамки не уходит за край доски')
  const add = applyOp(b, { op: 'addSketch', step: 's1' })
  b = ok(add)
  assert.equal(b.sketches.find(x => x.id === add.id).step, 's1')
  b = ok(applyOp(b, { op: 'remove', id: 's1' }))
  assert.equal(b.sketches.find(x => x.id === add.id).step, '', 'удалили шаг — эскиз отвязался')
  b = ok(applyOp(b, {
    op: 'mark',
    on: 'k1',
    pts: [
      [0, 0],
      [10, 10],
    ],
  }))
  b = ok(applyOp(b, { op: 'removeSketch', id: 'k1' }))
  assert.equal(b.marks.length, 0, 'пометки удалённого эскиза ушли вместе с ним')
})

it('пометки: штрих чистится, пустой отвергается, стираются по одной и все', () => {
  assert.deepEqual(normPoints([
    [0, 0],
    [0.4, 0.4],
    [5, 5],
    ['x', 1],
  ]), [
    [0, 0],
    [5, 5],
  ])
  assert.equal(normPoints(Array.from({ length: 2000 }, (_, i) => [i * 3, 0])).length, 400)
  let b = first()
  assert.equal(applyOp(b, {
    op: 'mark',
    pts: [
      [1, 1],
    ],
  }).error, 'Пустой штрих')
  assert.equal(applyOp(b, {
    op: 'mark',
    on: 'zzz',
    pts: [
      [1, 1],
      [9, 9],
    ],
  }).error, 'Нет такого эскиза')
  const m = applyOp(b, {
    op: 'mark',
    pts: [
      [1, 1],
      [90, 90],
    ],
  })
  b = ok(m)
  b = ok(applyOp(b, {
    op: 'mark',
    pts: [
      [5, 5],
      [60, 9],
    ],
  }))
  b = ok(applyOp(b, { op: 'unmark', id: m.id }))
  assert.equal(b.marks.length, 1)
  b = ok(applyOp(b, { op: 'clearMarks' }))
  assert.equal(b.marks.length, 0)
})

it('markTargets: обводка находит то, что внутри, линия — то, по чему прошла', () => {
  const targets = [
    {
      x: 0,
      y: 0,
      w: 240,
      h: 420,
      name: 'фон',
    },
    {
      x: 100,
      y: 100,
      w: 40,
      h: 30,
      name: 'кнопка',
    },
  ]
  const ring = {
    pts: [
      [90, 90],
      [150, 90],
      [150, 140],
      [90, 140],
      [92, 92],
    ],
  }
  assert.deepEqual(markTargets(ring, targets), {
    closed: true,
    hits: [targets[1]],
  })
  const under = {
    pts: [
      [100, 128],
      [140, 128],
    ],
  }
  const r = markTargets(under, targets)
  assert.equal(r.closed, false)
  assert.ok(r.hits.includes(targets[1]))
})

it('бот получает эскиз и пометки — в сообщениях и в утверждённом плане', () => {
  let b = first()
  // мобильное меню: человек передвинул кнопку, обвёл её и добавил заметку рядом с эскизом
  b = ok(applyOp(b, {
    op: 'shape',
    sketch: 'k1',
    id: 'burger',
    x: 12,
    y: 360,
  }))
  b = ok(applyOp(b, {
    op: 'mark',
    on: 'k1',
    pts: [
      [4, 352],
      [70, 352],
      [70, 400],
      [4, 400],
      [6, 354],
    ],
  }))
  const sk = b.sketches[0]
  b = ok(applyOp(b, {
    op: 'add',
    type: 'note',
    text: 'Кнопку — вниз, под большой палец',
    x: sk.x + sk.w + 10,
    y: sk.y + 300,
  }))
  assert.deepEqual(describeMarks(b), ['- на эскизе «Мобильное меню» обведено: кнопка «Меню» (burger)'])

  const msg = boardForBot(b)
  const json = JSON.parse(msg.match(/```plan\n(.*)\n```/)[1])
  assert.equal(json.sketches[0].shapes.find(s => s.id === 'burger').y, 360)
  assert.match(msg, /Пометки человека от руки:\n- на эскизе «Мобильное меню» обведено: кнопка «Меню»/)

  const t = approvedPlanText(b, 'Сделай мобильное меню')
  assert.match(t, /## Эскизы интерфейса/)
  assert.match(t, /### Мобильное меню \(240×420, к шагу «Меню»\)/)
  assert.match(t, /- кнопка «Меню»: x 12, y 360, 48×32/)
  assert.match(t, /## Пометки человека от руки\n- на эскизе «Мобильное меню» обведено: кнопка «Меню» \(burger\)/)
  assert.match(t, /- Кнопку — вниз, под большой палец \(у эскиза «Мобильное меню»\)/)
})

it('пометка на доске описывает карточку шага', () => {
  let b = first()
  const s1 = b.items.find(i => i.id === 's1')
  b = ok(applyOp(b, {
    op: 'mark',
    pts: [
      [s1.x - 10, s1.y - 10],
      [s1.x + 240, s1.y - 10],
      [s1.x + 240, s1.y + 100],
      [s1.x - 10, s1.y + 100],
      [s1.x - 8, s1.y - 8],
    ],
  }))
  assert.deepEqual(describeMarks(b), ['- на доске обведено: шаг «API» (s1)'])
})
