// Вопрос бота посреди «Разработки фичи»: бот ставит работу на паузу блоком ```question {json}```,
// вопрос привязан к шагу доски, варианты можно показать эскизами. Человек отвечает или правит доску —
// «Продолжить работу» возобновляет тот же запуск с ответом и (если менялся) обновлённым планом.
// Чистые функции без ввода-вывода: сервер хранит паузу в run.pause, доску — в run.board.

import { planSections, QUESTION_HELP } from './featurePlan.mjs'
import { mergeSketches, parseSketches } from './featureSketch.mjs'

const MAX_SKETCHES = 12 // как в featureSketch.mjs: больше эскизов на доску не кладём
const clip = (s, n) => String(s ?? '').trim().slice(0, n)
const clone = b => JSON.parse(JSON.stringify(b))

// Последний блок ```question (или ```choices из обычного протокола панели) → { text, step, options, sketches } | null
export function parseQuestion(text, board) {
  const blocks = [
    ...String(text || '').matchAll(/```(?:question|choices)[ \t]*\r?\n([\s\S]*?)```/g),
  ]
  if (!blocks.length)
    return null
  let data
  try {
    data = JSON.parse(blocks[blocks.length - 1][1])
  }
  catch {
    return null
  }
  const q = clip(data?.text ?? data?.question, 1000)
  if (!q)
    return null
  const items = board?.items || []
  const steps = new Set(items.filter(i => i.type === 'step').map(i => i.id))
  let step = clip(data.step, 40)
  if (!steps.has(step))
    step = ''
  const options = (Array.isArray(data.options)
    ? data.options
    : []).map(o => clip(typeof o === 'string'
    ? o
    : o?.label, 200)).filter(Boolean).slice(0, 6)
  const taken = [
    ...items.map(i => i.id),
    ...(board?.sketches || []).map(s => s.id),
  ]
  // эскиз-вариант без своего шага — к шагу вопроса
  const sketches = parseSketches(data.sketches, steps, taken).map(sk => ({
    ...sk,
    step: sk.step || step,
  }))
  return { text: q, step, options, sketches }
}

// Доска на паузе: эскизы-варианты из вопроса ложатся сразу (это иллюстрация вопроса, не правка плана)
export function pauseBoard(board, q) {
  const b = clone(board)
  const room = Math.max(0, MAX_SKETCHES - (b.sketches?.length || 0))
  if (q.sketches?.length && room)
    mergeSketches(b, q.sketches.slice(0, room), true)
  b.rev++
  return b
}

// Сообщение боту по «Продолжить работу» (или ответу в ленте): вопрос, ответ и — если человек правил доску — план целиком
export function resumeText(board, pause, answer) {
  const step = pause.step && board.items.find(i => i.id === pause.step)
  const changed = board.rev !== pause.rev
  const said = clip(answer, 4000)
  return [
    'Человек ответил — продолжай работу.',
    '',
    `Твой вопрос${step
      ? ` (шаг «${step.title || step.id}»)`
      : ''}: ${pause.text}`,
    '',
    said
      ? `Ответ человека:\n${said}`
      : 'Человек не ответил словами — смотри доску ниже.',
    '',
    ...(changed
      ? [
          'Человек изменил план на доске — делай по этой версии (шаги, эскизы и пометки главнее прежних).',
          '',
          '## Актуальный план',
          ...planSections(board),
        ]
      : ['План не менялся.']),
    '',
    'Сначала вернись в свою ветку (git checkout <ветка>); если последний коммит в ней — «WIP бота: …», сними его (git reset --soft HEAD~1) и продолжай с того же места. Дальше — как раньше: проверки, коммит, push и PR.',
    '',
    QUESTION_HELP,
  ].join('\n')
}
