import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { companionContext, parseCompanionReply } from './dialogCompanion.mjs'

test('builds context from both sides and remembers a silent mood change', () => {
  const context = companionContext('Первая задача', [
    { type: 'result', result: 'Первый ответ' },
    { type: 'bot_companion', mood: 'любопытный', text: 'Хм!' },
    { type: 'bot_user', text: 'А что дальше?' },
    { type: 'bot_companion', mood: 'задумчивый', text: '' },
    { type: 'result', is_error: true, result: 'Ошибка' },
    { type: 'bot_note', text: 'Ждёт вашего ответа' },
    { type: 'result', result: 'Следующий ответ' },
  ])
  assert.deepEqual(context, {
    initialText: 'Первая задача',
    mood: 'задумчивый',
    dialog: [
      { role: 'assistant', text: 'Первый ответ' },
      { role: 'companion', text: 'Хм!' },
      { role: 'user', text: 'А что дальше?' },
      { role: 'assistant', text: 'Следующий ответ' },
    ],
  })
})

test('keeps the latest exchange within the context limit', () => {
  const context = companionContext('Начало', [
    {
      type: 'result',
      result: 'x'.repeat(26000),
    },
    { type: 'bot_user', text: 'Вопрос' },
    { type: 'result', result: 'Ответ' },
  ])
  assert.equal(context.initialText, 'Начало')
  assert.equal(context.dialog.map(message => message.text).join('').length, 24000)
  assert.deepEqual(context.dialog.slice(-2).map(message => message.text), ['Вопрос', 'Ответ'])
})

test('accepts a silent reply and rejects invalid moods and long replies', () => {
  const output = (mood, text) => JSON.stringify({
    result: JSON.stringify({ mood, text }),
  })
  assert.deepEqual(parseCompanionReply(output('радостный', ' ')), { mood: 'радостный', text: '' })
  assert.equal(parseCompanionReply(output('unknown', 'Привет')), null)
  assert.equal(parseCompanionReply(output('радостный', 'x'.repeat(241))), null)
})
