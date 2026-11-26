// Эскизы интерфейса на доске «Разработки фичи» и пометки от руки. Чистые функции без ввода-вывода.
// Эскиз — рамка на доске (x, y — левый верх тела рамки, w × h) с блоками внутри: прямоугольник, текст, кнопка.
// Координаты блоков и пометок на эскизе — внутри тела рамки, так что они едут вместе с ней.
// Пометка (mark) — штрих от руки: on = id эскиза (координаты внутри него) или '' (координаты доски).

export const SHAPES = ['rect', 'text', 'button']
export const SKETCH_HEAD = 26 // высота заголовка рамки над телом эскиза — в пикселях доски
const MAX_SKETCHES = 12
const MAX_SHAPES = 60
const MAX_MARKS = 200
const MAX_POINTS = 400
const MAX = 4000
const ID_RE = /^[\w-]{1,40}$/

const clip = (s, n) => String(s ?? '').trim().slice(0, n)
function num(v, lo, hi, def) {
  const n = Math.round(Number(v))
  return Number.isFinite(n)
    ? Math.max(lo, Math.min(hi, n))
    : def
}

// Блок эскиза: тип, рамка и подпись
function normShape(raw, id) {
  const type = SHAPES.includes(raw?.type)
    ? raw.type
    : 'rect'
  return {
    id,
    type,
    x: num(raw?.x, 0, MAX, 0),
    y: num(raw?.y, 0, MAX, 0),
    w: num(raw?.w, 8, MAX, type === 'text'
      ? 120
      : 100),
    h: num(raw?.h, 8, MAX, type === 'button'
      ? 32
      : type === 'text'
        ? 20
        : 60),
    label: clip(raw?.label, 200),
  }
}

// Блок не уходит за рамку эскиза: левый верхний угол и хотя бы GRAB пикселей видны, чтобы за него можно было взяться
const GRAB = 16
function inside(sk, s) {
  s.x = Math.min(s.x, Math.max(0, sk.w - GRAB))
  s.y = Math.min(s.y, Math.max(0, sk.h - GRAB))
  return s
}

// Эскиз от бота или из запроса: блоки с уникальными id, размер рамки — заданный или по блокам
function normSketch(raw, steps = null) {
  const shapes = []
  const ids = new Set()
  let n = 0
  for (const s of (Array.isArray(raw?.shapes)
    ? raw.shapes
    : []).slice(0, MAX_SHAPES)) {
    let id = String(s?.id ?? '')
    if (!ID_RE.test(id) || ids.has(id)) {
      do id = `e${++n}`; while (ids.has(id))
    }
    ids.add(id)
    shapes.push(normShape(s, id))
  }
  const fitW = Math.max(200, ...shapes.map(s => s.x + s.w + 12))
  const fitH = Math.max(160, ...shapes.map(s => s.y + s.h + 12))
  const step = clip(raw?.step, 40)
  const frame = {
    w: num(raw?.w, 120, 1600, Math.min(1600, fitW)),
    h: num(raw?.h, 120, 1600, Math.min(1600, fitH)),
  }
  return {
    title: clip(raw?.title, 120),
    step: !steps || steps.has(step)
      ? step
      : '',
    ...frame,
    shapes: shapes.map(s => inside(frame, s)),
  }
}

// sketches из плана бота: [{ id, step, title, w, h, shapes: [...] }]; steps — id шагов плана, taken — занятые id карточек
export function parseSketches(list, steps, taken = []) {
  const out = []
  const ids = new Set(taken)
  let n = 0
  for (const raw of (Array.isArray(list)
    ? list
    : []).slice(0, MAX_SKETCHES)) {
    const sk = normSketch(raw, steps)
    if (!sk.shapes.length && !sk.title)
      continue
    let id = String(raw?.id ?? '')
    if (!ID_RE.test(id) || ids.has(id)) {
      do id = `k${++n}`; while (ids.has(id))
    }
    ids.add(id)
    out.push({ id, ...sk })
  }
  return out
}

// Содержимое эскиза для сравнения «бот что-то поменял?» — без позиции рамки на доске
function sketchSig(sk) {
  return JSON.stringify([
    sk.title,
    sk.step,
    sk.w,
    sk.h,
    sk.shapes.map(s => [
      s.id,
      s.type,
      s.x,
      s.y,
      s.w,
      s.h,
      s.label,
    ]),
  ])
}

// Штрих: точки округляются, слишком близкие (< 2px) выкидываются
export function normPoints(pts) {
  const out = []
  for (const p of (Array.isArray(pts)
    ? pts
    : []).slice(0, MAX_POINTS * 50)) { // предохранитель от огромного запроса; до MAX_POINTS прорежаем ниже
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number')
      continue
    const x = num(p[0], -MAX, MAX, Number.NaN)
    const y = num(p[1], -MAX, MAX, Number.NaN)
    if (Number.isNaN(x) || Number.isNaN(y))
      continue
    const last = out[out.length - 1]
    if (!last || Math.abs(last[0] - x) + Math.abs(last[1] - y) >= 2)
      out.push([x, y])
  }
  if (out.length <= MAX_POINTS)
    return out
  const step = out.length / MAX_POINTS
  return Array.from({ length: MAX_POINTS }, (_, i) => out[Math.floor(i * step)])
}

function box(pts) {
  const xs = pts.map(p => p[0]); const ys = pts.map(p => p[1])
  const x = Math.min(...xs); const y = Math.min(...ys)
  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
  }
}
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
const area = r => Math.max(1, r.w) * Math.max(1, r.h)

// Что задевает штрих: обведённые цели (почти целиком внутри рамки штриха), иначе — те, по которым он прошёл
export function markTargets(mark, targets) {
  if (mark.pts.length < 2)
    return { closed: false, hits: [] }
  const raw = box(mark.pts)
  const b = {
    x: raw.x - 4,
    y: raw.y - 4,
    w: raw.w + 8,
    h: raw.h + 8,
  } // с толщиной линии: у ровной черты есть площадь
  const [sx, sy] = mark.pts[0]
  const [ex, ey] = mark.pts[mark.pts.length - 1]
  const closed = Math.hypot(ex - sx, ey - sy) < Math.max(20, Math.hypot(b.w, b.h) / 4)
  const inside = targets.filter(t => overlap(t, b) / area(t) >= 0.6)
  const hits = inside.length
    ? inside
    : targets.filter(t => overlap(t, b) / Math.min(area(t), area(b)) >= 0.5)
  return {
    closed,
    hits: hits.sort((a, z) => area(a) - area(z)).slice(0, 5),
  }
}

const SHAPE_NAME = { rect: 'блок', text: 'текст', button: 'кнопка' }
function shapeName(s) {
  return `${SHAPE_NAME[s.type]}${s.label
    ? ` «${s.label}»`
    : ''} (${s.id})`
}
const CARD_H = 90 // высота карточки шага на доске — для разбора пометок (точной сервер не знает)
const CARD_W = 220

// Пометки человека словами — чтобы бот понял, что обведено и на что указано
export function describeMarks(board) {
  const lines = []
  const sketches = board.sketches || []
  for (const m of board.marks || []) {
    const sk = m.on && sketches.find(s => s.id === m.on)
    const targets = sk
      ? sk.shapes.map(s => ({
          ...s,
          name: shapeName(s),
        }))
      : [
          ...board.items.map(i => ({
            x: i.x,
            y: i.y,
            w: CARD_W,
            h: CARD_H,
            name: `${i.type === 'note'
              ? 'заметка'
              : 'шаг'} «${i.title || i.text.slice(0, 40)}» (${i.id})`,
          })),
          ...sketches.map(s => ({
            x: s.x,
            y: s.y - SKETCH_HEAD,
            w: s.w,
            h: s.h + SKETCH_HEAD,
            name: `эскиз «${s.title || s.id}» (${s.id})`,
          })),
        ]
    const { closed, hits } = markTargets(m, targets)
    const b = box(m.pts)
    const where = sk
      ? `на эскизе «${sk.title || sk.id}»`
      : 'на доске'
    const what = hits.length
      ? `${closed ? 'обведено' : 'отмечено'}: ${hits.map(t => t.name).join(', ')}`
      : `${closed ? 'обводка' : 'линия'} в области x ${b.x}–${b.x + b.w}, y ${b.y}–${b.y + b.h}`
    lines.push(`- ${where} ${what}`)
  }
  return lines
}

// Эскизы словами для утверждённого плана: блоки с координатами и подписями
export function describeSketches(board, stepTitle) {
  const out = []
  for (const sk of board.sketches || []) {
    const step = sk.step && stepTitle(sk.step)
    out.push(`### ${sk.title || 'Эскиз'} (${sk.w}×${sk.h}${step
      ? `, к шагу «${step}»`
      : ''})`)
    for (const s of sk.shapes) {
      out.push(`- ${shapeName(s)}: x ${s.x}, y ${s.y}, ${s.w}×${s.h}`)
    }
    if (!sk.shapes.length)
      out.push('- (пусто)')
  }
  return out
}

// Эскиз, рядом с которым (в пределах 60px) лежит карточка, — заметка у эскиза про него
export function sketchNear(board, item) {
  const gap = 60
  return (board.sketches || []).find(sk => item.x < sk.x + sk.w + gap && item.x + CARD_W > sk.x - gap && item.y < sk.y + sk.h + gap && item.y + CARD_H > sk.y - SKETCH_HEAD - gap)
}

const stepIds = b => new Set(b.items.filter(i => i.type === 'step').map(i => i.id))

// Новый эскиз на свободном месте: правее карточек и эскизов (в т.ч. ещё не принятых — extra)
function sketchSpot(board, w, extra = []) {
  const right = Math.max(
    0,
    ...board.items.map(i => i.x + CARD_W),
    ...[
      ...(board.sketches || []),
      ...extra,
    ].map(s => s.x + s.w),
  )
  return {
    x: Math.min(MAX - w, right + 50),
    y: 40 + SKETCH_HEAD,
  }
}

function nextId(list, prefix, seq) {
  const used = new Set(list.map(x => x.id))
  let n = seq
  let id
  do id = `${prefix}${++n}`; while (used.has(id))
  return id
}

// Действия с эскизами и пометками. board — уже копия, меняется на месте. Возвращает { error } | { id } | {}
export function sketchOp(b, op) {
  b.sketches ||= []
  b.marks ||= []
  const sk = id => b.sketches.find(s => s.id === id)
  switch (op.op) {
    case 'addSketch': {
      if (b.sketches.length >= MAX_SKETCHES)
        return { error: 'На доске уже слишком много эскизов' }
      const steps = stepIds(b)
      const n = normSketch({
        title: op.title || 'Эскиз',
        step: op.step,
        w: op.w ?? 240,
        h: op.h ?? 420,
      }, steps)
      const spot = op.x === undefined || op.y === undefined
        ? sketchSpot(b, n.w)
        : {
            x: num(op.x, 0, MAX, 0),
            y: num(op.y, SKETCH_HEAD, MAX, SKETCH_HEAD),
          }
      const id = nextId([
        ...b.items,
        ...b.sketches,
        ...b.suggestions.map(s => s.sketch || s.item || {}),
      ], 'k', b.sketches.length)
      b.sketches.push({
        id,
        ...n,
        ...spot,
        by: 'user',
      })
      return { id }
    }
    case 'sketch': {
      const s = sk(op.id)
      if (!s)
        return { error: 'Нет такого эскиза' }
      if (op.x !== undefined)
        s.x = num(op.x, 0, MAX, s.x)
      if (op.y !== undefined)
        s.y = num(op.y, SKETCH_HEAD, MAX, s.y)
      // рамку нельзя сжать так, чтобы блок целиком ушёл за край
      if (op.w !== undefined)
        s.w = num(op.w, Math.max(120, ...s.shapes.map(x => x.x + GRAB)), 1600, s.w)
      if (op.h !== undefined)
        s.h = num(op.h, Math.max(120, ...s.shapes.map(x => x.y + GRAB)), 1600, s.h)
      if (op.title !== undefined)
        s.title = clip(op.title, 120)
      if (op.step !== undefined) {
        const step = String(op.step || '')
        if (step && !b.items.some(i => i.id === step && i.type === 'step'))
          return { error: 'Нет такого шага' }
        s.step = step
      }
      return {}
    }
    case 'removeSketch':
      if (!sk(op.id))
        return { error: 'Нет такого эскиза' }
      b.sketches = b.sketches.filter(s => s.id !== op.id)
      b.marks = b.marks.filter(m => m.on !== op.id)
      b.suggestions = b.suggestions.filter(s => s.target !== op.id)
      return {}
    case 'addShape': {
      const s = sk(op.sketch)
      if (!s)
        return { error: 'Нет такого эскиза' }
      if (s.shapes.length >= MAX_SHAPES)
        return { error: 'В эскизе уже слишком много блоков' }
      const id = nextId(s.shapes, 'e', s.shapes.length)
      const type = SHAPES.includes(op.type)
        ? op.type
        : 'rect'
      const label = op.label ?? (type === 'button'
        ? 'Кнопка'
        : type === 'text'
          ? 'Текст'
          : '')
      const shift = 16 + 14 * (s.shapes.length % 8) // новые блоки лесенкой, а не друг на друге
      s.shapes.push(inside(s, normShape({
        ...op,
        type,
        label,
        x: op.x ?? shift,
        y: op.y ?? shift,
      }, id)))
      return { id }
    }
    case 'shape': {
      const it = sk(op.sketch)?.shapes.find(x => x.id === op.id)
      if (!it)
        return { error: 'Нет такого блока' }
      Object.assign(it, inside(sk(op.sketch), normShape({
        type: it.type,
        x: op.x ?? it.x,
        y: op.y ?? it.y,
        w: op.w ?? it.w,
        h: op.h ?? it.h,
        label: op.label ?? it.label,
      }, it.id)))
      return {}
    }
    case 'removeShape': {
      const s = sk(op.sketch)
      if (!s?.shapes.some(x => x.id === op.id))
        return { error: 'Нет такого блока' }
      s.shapes = s.shapes.filter(x => x.id !== op.id)
      return {}
    }
    case 'mark': {
      if (b.marks.length >= MAX_MARKS)
        return { error: 'Слишком много пометок — сотрите лишние' }
      const on = String(op.on || '')
      if (on && !sk(on))
        return { error: 'Нет такого эскиза' }
      const pts = normPoints(op.pts)
      if (pts.length < 2)
        return { error: 'Пустой штрих' }
      const id = nextId(b.marks, 'm', b.marks.length)
      b.marks.push({ id, on, pts })
      return { id }
    }
    case 'unmark':
      b.marks = b.marks.filter(m => m.id !== op.id)
      return {}
    case 'clearMarks':
      b.marks = []
      return {}
    default:
      return null // не про эскизы
  }
}

// Эскизы из плана бота → доска. first — первый план: эскизы ложатся сразу; иначе — предложения kind 'sketch'
export function mergeSketches(b, list, first, sug) {
  b.sketches ||= []
  b.marks ||= []
  for (const raw of list) {
    const cur = b.sketches.find(s => s.id === raw.id)
    if (first && !cur) {
      b.sketches.push({
        ...raw,
        ...sketchSpot(b, raw.w),
        by: 'bot',
      })
      continue
    }
    if (!cur) {
      // правее и предложенных, но ещё не принятых эскизов и карточек
      const pending = b.suggestions.filter(s => s.kind === 'add' || (s.kind === 'sketch' && !s.target)).map(s => s.sketch || { x: s.item.x, w: CARD_W })
      const spot = sketchSpot(b, raw.w, pending)
      sug({
        kind: 'sketch',
        sketch: {
          ...raw,
          ...spot,
        },
      })
    }
    else if (sketchSig(cur) !== sketchSig(raw)) {
      sug({ kind: 'sketch', target: cur.id, sketch: raw })
    }
  }
}

// Принять предложение эскиза: новый — на доску, изменённый — заменить содержимое, позиция и пометки остаются
export function acceptSketch(b, s) {
  b.sketches ||= []
  const cur = s.target && b.sketches.find(x => x.id === s.target)
  if (s.target && !cur)
    return 'Эскиз уже удалён'
  const step = stepIds(b).has(s.sketch.step)
    ? s.sketch.step
    : ''
  if (cur) {
    Object.assign(cur, {
      title: s.sketch.title,
      step,
      w: s.sketch.w,
      h: s.sketch.h,
      shapes: s.sketch.shapes,
    })
    return ''
  }
  if (b.sketches.length >= MAX_SKETCHES)
    return 'На доске уже слишком много эскизов'
  if (b.sketches.some(x => x.id === s.sketch.id))
    return 'Эскиз уже есть'
  b.sketches.push({ ...s.sketch, step, by: 'bot' })
  return ''
}

// Эскизы для бота — в блоке плана (координаты блоков внутри рамки)
export function sketchesForBot(b) {
  return (b.sketches || []).map(({ id, step, title, w, h, shapes }) => ({
    id,
    step,
    title,
    w,
    h,
    shapes: shapes.map(({ id, type, x, y, w, h, label }) => ({ id, type, x, y, w, h, label })),
  }))
}
