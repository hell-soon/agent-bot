import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Use Node's built-in runner without adding a dependency.
import { it } from 'node:test'
import { applyOp, mergeBotPlan, parsePlan } from './featurePlan.mjs'
import { parseQuestion, pauseBoard, resumeText } from './featureQuestion.mjs'

const PLAN = {
  items: [
    {
      id: 's1',
      type: 'step',
      title: 'Кнопка меню',
      text: 'Header.vue',
    },
    {
      id: 's2',
      type: 'step',
      title: 'Мобильное меню',
      text: 'MobileMenu.vue',
    },
  ],
  links: [
    ['s1', 's2'],
  ],
}
const board = () => mergeBotPlan(null, parsePlan(`\`\`\`plan\n${JSON.stringify(PLAN)}\n\`\`\``))
const ask = q => `Сделал кнопку.\n\`\`\`question\n${JSON.stringify(q)}\n\`\`\``

it('reads the bot question bound to a step, with options', () => {
  const q = parseQuestion(ask({
    step: 's2',
    text: 'Когда закрывать мобильное меню?',
    options: [
      'По тапу вне меню (Рекомендую)',
      { label: 'Только по крестику' },
      '',
    ],
  }), board())
  assert.equal(q.step, 's2')
  assert.equal(q.text, 'Когда закрывать мобильное меню?')
  assert.deepEqual(q.options, ['По тапу вне меню (Рекомендую)', 'Только по крестику'])
  assert.deepEqual(q.sketches, [])
})

it('drops an unknown step and ignores answers without a question block', () => {
  assert.equal(parseQuestion(ask({ step: 'zz', text: 'Что дальше?' }), board()).step, '')
  assert.equal(parseQuestion('Готово, PR открыт.', board()), null)
  assert.equal(parseQuestion('```question\n{битый\n```', board()), null)
  assert.equal(parseQuestion(ask({ step: 's1' }), board()), null)
})

it('also understands the panel choices block', () => {
  const q = parseQuestion('```choices\n{"question": "Анимация?", "step": "s1", "options": [{"label": "Да"}, {"label": "Нет"}]}\n```', board())
  assert.equal(q.text, 'Анимация?')
  assert.equal(q.step, 's1')
  assert.deepEqual(q.options, ['Да', 'Нет'])
})

it('puts option sketches on the board next to the plan, bound to the step', () => {
  const b = board()
  const q = parseQuestion(ask({
    step: 's2',
    text: 'Как закрывать?',
    sketches: [
      {
        id: 's1',
        step: 's2',
        title: 'Вариант А',
        w: 240,
        h: 420,
        shapes: [
          {
            type: 'button',
            x: 10,
            y: 10,
            w: 40,
            h: 40,
            label: '✕',
          },
        ],
      },
      {
        title: 'Вариант Б',
        shapes: [
          {
            type: 'rect',
            x: 0,
            y: 0,
            w: 240,
            h: 200,
          },
        ],
      },
    ],
  }), b)
  assert.equal(q.sketches.length, 2)
  assert.notEqual(q.sketches[0].id, 's1') // id шага занят — эскизу дан новый
  const p = pauseBoard(b, q)
  assert.equal(p.rev, b.rev + 1)
  assert.equal(p.sketches.length, 2)
  assert.deepEqual(p.sketches.map(s => s.step), ['s2', 's2'])
  assert.equal(p.sketches[0].by, 'bot')
  assert.equal(b.sketches.length, 0) // исходная доска не меняется
})

it('resume text carries the answer and says the plan did not change', () => {
  const b = pauseBoard(board(), parseQuestion(ask({ step: 's2', text: 'Когда закрывать меню?' }), board()))
  const pause = { text: 'Когда закрывать меню?', step: 's2', rev: b.rev }
  const t = resumeText(b, pause, 'По тапу вне меню')
  assert.match(t, /Когда закрывать меню\?/)
  assert.match(t, /шаг «Мобильное меню»/)
  assert.match(t, /Ответ человека:\nПо тапу вне меню/)
  assert.match(t, /План не менялся/)
  assert.doesNotMatch(t, /## Актуальный план/)
  assert.match(t, /WIP бота/)
})

it('resume text sends the updated plan when the person edited the board', () => {
  const b = board()
  const pause = { text: 'Когда закрывать меню?', step: 's2', rev: b.rev }
  const r = applyOp(b, { op: 'add', type: 'step', title: 'Закрытие по тапу вне меню' })
  const t = resumeText(r.board, pause, '')
  assert.match(t, /Человек не ответил словами/)
  assert.match(t, /Человек изменил план/)
  assert.match(t, /## Актуальный план\n1\. Кнопка меню\n/)
  assert.match(t, /Закрытие по тапу вне меню/)
})
