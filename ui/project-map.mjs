// Карта проекта для бота и «Что может задеть» для PR — из графа импортов (code-graph.mjs), без ИИ.
// Слайс — слой/слайс FSD (у shared/app/kit — слой/сегмент) или папка до 2 уровней.

const bare = l => l.replace(/^\d+[.\-_]/, '')
// 1 файл, 2 файла, 5 файлов
function plural(n, one, few, many) {
  return `${n} ${n % 10 === 1 && n % 100 !== 11
    ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
      ? few
      : many}`
}
const SEGMENTED = new Set(['app', 'shared', 'kit'])

export function sliceOf(file, fsd) {
  if (fsd && file.startsWith(fsd.root)) {
    const [layer, slice] = file.slice(fsd.root.length).split('/')
    if (fsd.layers.includes(layer)) {
      return !slice || slice.includes('.')
        ? `${fsd.root}${layer}`
        : `${fsd.root}${layer}/${slice}`
    }
  }
  const dir = file.split('/').slice(0, -1)
  return dir.slice(0, 2).join('/') || '(корень)'
}
function shortSlice(id, fsd) {
  return (fsd && id.startsWith(fsd.root)
    ? id.slice(fsd.root.length)
    : id).replace(/(^|\/)\d+[.\-_]/g, '$1')
}

// граф слайсов: кто кого импортирует
export function sliceGraph(g) {
  const s = new Map()
  const get = (id) => {
    if (!s.has(id)) {
      s.set(id, {
        id,
        files: 0,
        ins: new Set(),
        outs: new Set(),
      })
    }
    return s.get(id)
  }
  for (const f of g.files) get(sliceOf(f, g.fsd)).files++
  for (const e of g.edges) {
    const a = sliceOf(e.from, g.fsd); const b = sliceOf(e.to, g.fsd)
    if (a === b)
      continue
    get(a).outs.add(b); get(b).ins.add(a)
  }
  return s
}

// слова задачи → слайсы: латиница из текста (имена, пути) + русские основы частых слов интерфейса
const RU = [
  ['плеер', 'player'],
  ['проигрыв', 'player'],
  ['трек', 'track'],
  ['песн', 'track'],
  ['плейлист', 'playlist'],
  ['поиск', 'search'],
  ['настройк', 'settings'],
  ['профил', 'profile'],
  ['друз', 'friend'],
  ['друг', 'friend'],
  ['лайк', 'like'],
  ['нрав', 'like'],
  ['очеред', 'queue'],
  ['волн', 'wave'],
  ['текст', 'lyrics'],
  ['обложк', 'cover'],
  ['альбом', 'album'],
  ['исполнител', 'artist'],
  ['артист', 'artist'],
  ['жанр', 'genre'],
  ['вход', 'auth'],
  ['логин', 'login'],
  ['уведомлен', 'notification'],
  ['пуш', 'push'],
  ['карт', 'map'],
  ['метк', 'mark'],
  ['чат', 'chat'],
  ['сообщен', 'chat'],
  ['тем', 'theme'],
  ['истори', 'history'],
  ['статистик', 'stats'],
  ['библиотек', 'library'],
  ['радио', 'station'],
  ['станци', 'station'],
  ['устройств', 'device'],
  ['таймер', 'timer'],
  ['горяч', 'hotkey'],
  ['комментар', 'comment'],
  ['групп', 'group'],
  ['мест', 'place'],
  ['достижен', 'achievement'],
  ['аватар', 'avatar'],
  ['фото', 'photo'],
  ['навигац', 'navigation'],
  ['меню', 'menu'],
  ['окн', 'modal'],
  ['диалог', 'dialog'],
  ['кнопк', 'button'],
  ['шапк', 'header'],
]
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'src',
  'index',
  'vue',
  'tsx',
  'jsx',
  'ts',
  'js',
  'md',
  'http',
  'https',
  'www',
  'com',
  'github',
  'issue',
  'bot',
  'feat',
  'fix',
])
const words = s => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w))
function taskWords(text) {
  const t = String(text).toLowerCase()
  const w = new Set(words(text))
  for (const [ru, en] of RU) {
    if (t.includes(ru))
      w.add(en)
  }
  return w
}
const stem = w => w.replace(/(ies|es|s)$/, '')

export function relevant(sg, g, text, extraFiles = []) {
  const want = new Set([
    ...taskWords(text),
  ].map(stem))
  const score = new Map()
  const filesBy = new Map()
  for (const f of g.files) {
    const k = sliceOf(f, g.fsd); filesBy.set(k, [
      ...(filesBy.get(k) || []),
      f,
    ])
  }
  for (const [id] of sg) {
    let sc = 0
    const name = new Set(words(id.split('/').slice(-1)[0]).map(stem))
    for (const w of name) {
      if (want.has(w))
        sc += 3
    }
    for (const f of filesBy.get(id) || []) {
      for (const w of words(f.split('/').pop().replace(/\.[^.]+$/, ''))) {
        if (want.has(stem(w)))
          sc += 1
      }
    }
    if (sc)
      score.set(id, sc)
  }
  for (const f of extraFiles) { const k = sliceOf(f, g.fsd); score.set(k, (score.get(k) || 0) + 10) }
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id)
}

// блок для инструкций бота (≈ до 4 КБ)
export function mapMarkdown(g, text, extraFiles = []) {
  const sg = sliceGraph(g)
  const fsd = g.fsd
  const name = id => shortSlice(id, fsd)
  const lines = ['## Карта проекта — граф импортов базовой ветки (собран без ИИ)', 'Используй её, чтобы сразу идти в нужные места, а не исследовать репозиторий целиком. Списки — не исчерпывающие гарантии: открывай файлы перед правкой.']
  if (fsd) {
    lines.push(`FSD в \`${fsd.root || './'}\`: слои сверху вниз ${fsd.layers.map(bare).join(' → ')}. Импорт — только в нижние слои; соседние слайсы одного слоя друг друга не импортируют; в чужой слайс — только через его index.`)
    lines.push('Слайсы по слоям:')
    for (const l of fsd.layers) {
      const ids = [
        ...sg.keys(),
      ].filter(id => id.startsWith(`${fsd.root}${l}`)).map(id => id.split('/').pop()).filter(x => x !== l)
      if (ids.length) {
        lines.push(`- ${bare(l)}: ${ids.slice(0, 40).join(', ')}${ids.length > 40
          ? ` … (+${ids.length - 40})`
          : ''}`)
      }
    }
  }
  else {
    const top = [
      ...sg.values(),
    ].sort((a, b) => b.files - a.files).slice(0, 30)
    lines.push(`Папки (по числу файлов): ${top.map(s => `${s.id} (${s.files})`).join(', ')}`)
  }
  const n = sg.size || 1
  const hubs = [
    ...sg.values(),
  ].filter(s => s.ins.size / n >= 0.25).sort((a, b) => b.ins.size - a.ins.size).slice(0, 6)
  if (hubs.length)
    lines.push(`Общие модули — их используют многие, меняй осторожно и совместимо: ${hubs.map(s => `${name(s.id)} (${s.ins.size})`).join(', ')}.`)
  const rel = relevant(sg, g, text, extraFiles)
  if (rel.length) {
    lines.push('Похоже, задача касается:')
    for (const id of rel) {
      const s = sg.get(id)
      if (!s)
        continue
      const ins = [...s.ins].map(name); const outs = [...s.outs].map(name)
      lines.push(`- \`${id}\` (${plural(s.files, 'файл', 'файла', 'файлов')}) — импортирует: ${outs.slice(0, 6).join(', ') || '—'}; используют (${ins.length}): ${ins.slice(0, 8).join(', ') || '—'}${ins.length > 8
        ? ' …'
        : ''}`)
    }
    lines.push('После правок проверь тех, кто использует изменённые слайсы.')
  }
  let md = lines.join('\n')
  if (md.length > 4500)
    md = `${md.slice(0, 4400)}\n…`
  return {
    md,
    relevant: rel.map(name),
  }
}

// «Что может задеть»: изменённые файлы PR → слайсы → кто их использует (напрямую и через одного)
export function impactMarkdown(g, changed) {
  const sg = sliceGraph(g)
  const name = id => shortSlice(id, g.fsd)
  const bySlice = new Map()
  for (const f of changed) { const k = sliceOf(f, g.fsd); bySlice.set(k, (bySlice.get(k) || 0) + 1) }
  const rows = []
  let touched = new Set()
  for (const [id, cnt] of [...bySlice].sort((a, b) => (sg.get(b[0])?.ins.size || 0) - (sg.get(a[0])?.ins.size || 0))) {
    const s = sg.get(id)
    const direct = [
      ...(s?.ins || []),
    ].filter(x => !bySlice.has(x))
    const second = new Set()
    for (const d of direct) {
      for (const x of sg.get(d)?.ins || []) {
        if (!bySlice.has(x) && !direct.includes(x))
          second.add(x)
      }
    }
    direct.forEach(x => touched.add(x))
    rows.push(`| \`${name(id)}\` · ${plural(cnt, 'файл', 'файла', 'файлов')} | ${direct.length
      ? `${direct.length}: ${direct.slice(0, 8).map(name).join(', ')}${direct.length > 8
        ? ' …'
        : ''}`
      : '—'} | ${second.size || '—'} |`)
  }
  touched = [...touched]
  const out = [
    '<!-- agent-bot:impact -->',
    '### Что может задеть',
    touched.length
      ? `Изменённое используют **${plural(touched.length, 'слайс', 'слайса', 'слайсов')}** — их стоит проверить.`
      : 'Изменённое никто не импортирует — влияние локальное.',
    '',
    '| Изменено | Используют напрямую | Ещё через них |',
    '|---|---|---|',
    ...rows,
    '',
    '<sub>По графу импортов базовой ветки, без ИИ · agent-bot</sub>',
  ]
  return out.join('\n')
}
