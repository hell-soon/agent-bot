import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Use Node's built-in runner without adding a dependency.
import test from 'node:test'
import { moodOf } from './src/lib/mood.ts'

const tool = {
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: {},
      },
    ],
  },
}
const text = {
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'Смотрю код' },
    ],
  },
}
const toolResult = {
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    ],
  },
}
const note = { type: 'bot_note', text: 'Запуск' }

test('в очереди — ждёт', () => {
  assert.equal(moodOf({ status: 'queued' }), 'sleepy')
})

test('работает: инструмент → работает, текст → задумался', () => {
  assert.equal(moodOf({ status: 'running' }, [text, tool]), 'working')
  assert.equal(moodOf({ status: 'running' }, [tool, note]), 'working', 'служебные события не в счёт')
  assert.equal(moodOf({ status: 'running' }, [tool, text]), 'thinking')
  assert.equal(moodOf({ status: 'running' }, [tool, toolResult]), 'thinking', 'инструмент ответил — обдумывает')
  assert.equal(moodOf({ status: 'running' }, []), 'thinking')
})

test('ждёт ответа: вопрос → любопытный, иначе спокойный, ошибка → озадачен', () => {
  assert.equal(moodOf({
    status: 'waiting',
    pause: { text: '?' },
  }), 'curious')
  assert.equal(moodOf({ status: 'waiting', lastText: 'Выбери:\n```choices\n{}\n```' }), 'curious')
  assert.equal(moodOf({ status: 'waiting', lastResult: 'ok', lastText: 'Готово' }), 'calm')
  assert.equal(moodOf({ status: 'waiting', lastResult: 'error' }), 'confused')
})

test('лимит — устал, ошибка — озадачен', () => {
  assert.equal(moodOf({ status: 'limited' }), 'tired')
  assert.equal(moodOf({ status: 'failed' }), 'confused')
})

test('готово: с PR — радуется, без PR — доволен', () => {
  assert.equal(moodOf({ status: 'done', prUrl: 'https://github.com/o/r/pull/1' }), 'happy')
  assert.equal(moodOf({ status: 'done' }), 'pleased')
})

test('остановлено и без запуска — спокоен', () => {
  assert.equal(moodOf({ status: 'stopped' }), 'calm')
  assert.equal(moodOf(null), 'calm')
})
