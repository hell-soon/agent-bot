// Граф кода без ИИ: файлы проекта и импорты между ними (из базовой ветки, через git).
// JS/TS/Vue/Svelte: import/export from, import(), require(); Python: import / from … import; Go: пути пакетов модуля.
// Алиасы: tsconfig paths, Nuxt (@/ ~/ → srcDir, ~~/ @@/ → корень, #shared → shared/), Vite resolve.alias '@'.
// FSD (src/app|pages|widgets|features|entities|shared): связи против правил слоёв помечаются нарушением.

const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go)$/
// тесты и сборки — не устройство проекта
const SKIP = /(?:^|\/)(?:node_modules|dist|build|\.output|\.nuxt|\.next|vendor|coverage|\.git|__pycache__|ios|android|e2e|tests?|__tests__|__mocks__|fixtures)\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$/
const EXT = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.d.ts',
  '.py',
]

function norm(p) {
  const out = []
  for (const s of p.split('/')) {
    if (!s || s === '.')
      continue
    if (s === '..')
      out.pop()
    else out.push(s)
  }
  return out.join('/')
}
const dirOf = f => f.split('/').slice(0, -1).join('/')

export function codeGraph({ list, read, grep }) {
  const all = list()
  const files = all.filter(f => CODE.test(f) && !SKIP.test(f) && !/\.d\.ts$/.test(f)).slice(0, 3000)
  const set = new Set(all)

  // ---------- алиасы ----------
  const alias = [] // [префикс, папка]
  const nuxt = read('nuxt.config.ts') || read('nuxt.config.js')
  if (nuxt) {
    const src = nuxt.match(/srcDir\s*:\s*['"]([^'"]+)['"]/)?.[1]?.replace(/^\.?\/?|\/$/g, '') ?? (set.has('app/app.vue')
      ? 'app'
      : '')
    alias.push(['~~/', ''], ['@@/', ''], ['#shared/', 'shared/'], [
      '~/',
      src
        ? `${src}/`
        : '',
    ], [
      '@/',
      src
        ? `${src}/`
        : '',
    ])
  }
  for (const f of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    const t = read(f)
    if (!t)
      continue
    try {
      const j = JSON.parse(t.replace(/\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'))
      const base = (j.compilerOptions?.baseUrl || '.').replace(/^\.\/?/, '')
      for (const [k, v] of Object.entries(j.compilerOptions?.paths || {})) {
        const to = String(v?.[0] || '').replace(/\*$/, '').replace(/^\.\//, '')
        alias.push([
          k.replace(/\*$/, ''),
          norm(`${base}/${to}`) + (to.endsWith('/') || !to
            ? '/'
            : ''),
        ])
      }
    }
    catch {}
  }
  const vite = read('vite.config.ts') || read('vite.config.js')
  if (vite && /['"]@['"]\s*:/.test(vite) && !alias.some(a => a[0] === '@/'))
    alias.push(['@/', 'src/'])
  if (!alias.some(a => a[0] === '@/') && set.has('src/main.ts'))
    alias.push(['@/', 'src/'])
  alias.sort((a, b) => b[0].length - a[0].length)

  const resolveJs = (from, spec) => {
    let base = null
    if (spec.startsWith('.')) {
      base = norm(`${dirOf(from)}/${spec}`)
    }
    else {
      const a = alias.find(([p]) => spec === p.replace(/\/$/, '') || spec.startsWith(p))
      if (a)
        base = norm(a[1] + spec.slice(a[0].length))
    }
    if (base === null)
      return null
    for (const c of [
      base,
      ...EXT.map(e => base + e),
      ...EXT.map(e => `${base}/index${e}`),
    ]) {
      if (set.has(c) && CODE.test(c))
        return c
    }
    return null
  }
  const resolvePy = (from, mod) => {
    let parts
    if (mod.startsWith('.')) {
      const up = mod.match(/^\.+/)[0].length
      parts = [
        ...dirOf(from).split('/').slice(0, Math.max(0, dirOf(from).split('/').length - (up - 1))),
        ...mod.slice(up).split('.').filter(Boolean),
      ]
    }
    else {
      parts = mod.split('.')
    }
    for (const root of [
      '',
      'src/',
      'app/',
      `${dirOf(from).split('/')[0]}/`,
    ]) {
      const p = root + parts.join('/')
      if (set.has(`${p}.py`))
        return `${p}.py`
      if (set.has(`${p}/__init__.py`))
        return `${p}/__init__.py`
    }
    return null
  }
  const goMod = read('go.mod')?.match(/^module\s+(\S+)/m)?.[1]

  // ---------- импорты одним git grep ----------
  const lines = grep('(from|import|require\\(|import\\()\\s*[\'"][^\'"]+[\'"]|^\\s*(from\\s+[.\\w]+\\s+import|import\\s+[\\w.]+)|^\\s*"[^"]+"\\s*$')
  const edges = new Map() // "a\nb" → {from, to}
  const fileSet = new Set(files)
  for (const { file, text } of lines) {
    if (!fileSet.has(file))
      continue
    let to = null
    if (/\.py$/.test(file)) {
      const m = text.match(/^\s*from\s+([.\w]+)\s+import/) || text.match(/^\s*import\s+([\w.]+)/)
      if (m)
        to = resolvePy(file, m[1])
    }
    else if (/\.go$/.test(file)) {
      const m = text.match(/"([^"]+)"/)
      if (m && goMod && m[1].startsWith(`${goMod}/`)) {
        const dir = m[1].slice(goMod.length + 1)
        to = files.find(f => dirOf(f) === dir && /\.go$/.test(f) && !/_test\.go$/.test(f)) || null
      }
    }
    else {
      const m = text.match(/['"]([^'"]+)['"]/)
      if (m)
        to = resolveJs(file, m[1])
    }
    if (to && to !== file && fileSet.has(to)) // в исключённые (тесты, сборки) — не считаем
      edges.set(`${file}\n${to}`, { from: file, to })
  }

  // ---------- FSD: папка, где лежат слои (src/, src/components/ …), слои — сверху вниз ----------
  // Варианты: стандартные имена или с номерами (00.shared … 06.app — больший номер выше), плюс kit, layouts, processes.
  const RANK = {
    app: 0,
    processes: 0.5,
    pages: 1,
    layouts: 1.5,
    widgets: 2,
    features: 3,
    entities: 4,
    kit: 4.5,
    shared: 5,
  }
  const bare = d => d.replace(/^\d+[.\-_]/, '')
  const dirs = new Map() // папка → множество подпапок
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 0; i < Math.min(parts.length - 1, 4); i++) {
      const root = parts.slice(0, i).join('/')
      dirs.set(root, (dirs.get(root) || new Set()).add(parts[i]))
    }
  }
  let fsdRoot; let layers = []
  for (const [root, kids] of dirs) {
    const ls = [...kids].filter(k => bare(k) in RANK)
    if (ls.length >= 4 && ls.length > layers.length) {
      fsdRoot = root
        ? `${root}/`
        : ''
      const numbered = ls.every(k => /^\d+[.\-_]/.test(k))
      layers = ls.sort((a, b) => (numbered
        ? Number.parseInt(b) - Number.parseInt(a)
        : RANK[bare(a)] - RANK[bare(b)]))
    }
  }
  const fsd = fsdRoot !== undefined
  const SEGMENTED = new Set(['app', 'shared', 'kit']) // без изоляции слайсов
  const layerOf = (f) => {
    if (!fsd || !f.startsWith(fsdRoot))
      return null
    const [l, slice] = f.slice(fsdRoot.length).split('/')
    return layers.includes(l)
      ? {
          layer: l,
          slice: SEGMENTED.has(bare(l)) || !slice || slice.includes('.')
            ? ''
            : slice,
        }
      : null
  }
  const why = (a, b) => {
    const A = layerOf(a); const B = layerOf(b)
    if (!A || !B)
      return ''
    const ra = layers.indexOf(A.layer); const rb = layers.indexOf(B.layer)
    if (rb < ra)
      return `слой ${bare(A.layer)} импортирует верхний слой ${bare(B.layer)}`
    if (ra === rb && A.slice && B.slice && A.slice !== B.slice)
      return `соседние слайсы одного слоя: ${bare(A.layer)}/${A.slice} → ${bare(B.layer)}/${B.slice}`
    // в чужой слайс — только через его index (public API)
    if (B.slice && (A.layer !== B.layer || A.slice !== B.slice)) {
      const rest = b.slice(fsdRoot.length).split('/').slice(2)
      if (rest.length && !(rest.length === 1 && /^index\./.test(rest[0])))
        return `мимо index слайса ${bare(B.layer)}/${B.slice}`
    }
    return ''
  }

  return {
    fsd: fsd
      ? {
          root: fsdRoot,
          layers,
          segmented: layers.filter(l => SEGMENTED.has(bare(l))),
        }
      : null,
    files,
    edges: [
      ...edges.values(),
    ].map(e => ({ ...e, bad: why(e.from, e.to) || undefined })),
  }
}
