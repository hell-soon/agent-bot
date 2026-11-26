// Сканер архитектуры без ИИ: из файлов репозитория — каркас схемы в формате docs/architecture.json.
// Источники: docker-compose (сервисы, образы, порты, depends_on, env, метки Traefik), package.json,
// requirements/pyproject, vercel.json, Capacitor, .env.example и адреса внешних API в коде.
// files: { list(): string[], read(path): string|null, urls(): {file,url}[] } — из git (origin/<база>), а не из рабочей копии.
import YAML from 'yaml'

export const COLUMNS = [
  { id: 'clients', title: 'Клиенты' },
  { id: 'entry', title: 'Вход' },
  { id: 'services', title: 'Сервисы' },
  { id: 'platform', title: 'Платформа' },
  { id: 'external', title: 'Внешние системы' },
]

// образ / зависимость → что это
const INFRA = [
  [
    /postgis/i,
    { label: 'PostgreSQL', sub: 'PostGIS', kind: 'storage' },
  ],
  [
    /postgres|neondatabase|pglite|\bpg\b|psycopg|asyncpg|drizzle|prisma|typeorm|sqlalchemy/i,
    { label: 'PostgreSQL', kind: 'storage' },
  ],
  [
    /mysql|mariadb/i,
    { label: 'MySQL', kind: 'storage' },
  ],
  [
    /mongo/i,
    { label: 'MongoDB', kind: 'storage' },
  ],
  [
    /redis|valkey|keydb|ioredis/i,
    { label: 'Redis', kind: 'storage' },
  ],
  [
    /kafka|redpanda|kafkajs|aiokafka/i,
    { label: 'Kafka', kind: 'queue' },
  ],
  [
    /rabbitmq|amqplib|aio-pika/i,
    { label: 'RabbitMQ', kind: 'queue' },
  ],
  [
    /nats/i,
    { label: 'NATS', kind: 'queue' },
  ],
  [
    /seaweedfs/i,
    { label: 'SeaweedFS', sub: 'S3', kind: 'storage' },
  ],
  [
    /minio/i,
    { label: 'MinIO', sub: 'S3', kind: 'storage' },
  ],
  [
    /client-s3|boto3|aws-sdk/i,
    { label: 'S3', kind: 'storage' },
  ],
  [
    /elasticsearch|opensearch/i,
    { label: 'Elasticsearch', kind: 'storage' },
  ],
  [
    /clickhouse/i,
    { label: 'ClickHouse', kind: 'storage' },
  ],
  [
    /prometheus|grafana|loki|tempo|jaeger|otel|opentelemetry/i,
    { label: 'Наблюдаемость', kind: 'observability', merge: true },
  ],
  [
    /traefik/i,
    { label: 'Traefik', kind: 'gateway' },
  ],
  [
    /nginx/i,
    { label: 'nginx', kind: 'gateway' },
  ],
  [
    /caddy/i,
    { label: 'Caddy', kind: 'gateway' },
  ],
  [
    /envoy|kong/i,
    { label: 'API Gateway', kind: 'gateway' },
  ],
]
// внешние сервисы — по зависимостям и по адресам
const EXTERNAL = [
  [/fcm\.googleapis|firebase/i, 'Firebase FCM'],
  [/web-push|webpush|pywebpush/i, 'Web Push'],
  [/nodemailer|smtp|aiosmtplib|sendgrid|mailgun|resend/i, 'Почта (SMTP)'],
  [/telegram|telegraf|grammy|aiogram/i, 'Telegram Bot API'],
  [/stripe/i, 'Stripe'],
  [/sentry/i, 'Sentry'],
  [/openai/i, 'OpenAI API'],
  [/anthropic/i, 'Anthropic API'],
  [/spotify|scdn\.co/i, 'Spotify'],
  [/yandex/i, 'Яндекс'],
  [/audioscrobbler|last\.fm|lastfm/i, 'Last.fm'],
  [/genius\.com/i, 'Genius'],
  [/lrclib/i, 'LRCLIB'],
  [/api\.github\.com|octokit/i, 'GitHub API'],
  [/googleapis/i, 'Google API'],
  [/mapbox/i, 'Mapbox'],
  [/maptiler|openstreetmap|tile\./i, 'Карты'],
  [/supabase/i, 'Supabase'],
  [/cloudinary/i, 'Cloudinary'],
]
// ссылки «поделиться» и страницы — не API
const NOT_API = /^(?:www\.)?(?:x|twitter|wa|vk|t|facebook|instagram|youtube|song|linkedin|reddit)\.(?:com|me|ru|link)$|^schemas?\.|w3\.org|example\.|localhost|github\.com$|shields\.io|fonts\.(?:googleapis|gstatic)|unpkg|jsdelivr|cdnjs/i
const SERVER_DIR = /^(?:server|api|backend|services?|app\/api|src\/server|functions|workers?|cmd|internal)\//
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|kt|java|rb|php)$/

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '') || 'node'

export function scan(files, repo) {
  const all = files.list()
  const nodes = new Map()
  const edges = []
  const add = (id, n) => {
    const cur = nodes.get(id)
    if (cur) {
      if (n.sub && !String(cur.sub || '').includes(n.sub))
        cur.sub = [cur.sub, n.sub].filter(Boolean).join(' · ')
      return cur
    }
    const node = { id, source: 'scan', ...n }
    nodes.set(id, node)
    return node
  }
  const link = (from, to, type) => {
    if (from !== to && nodes.has(from) && nodes.has(to) && !edges.some(e => e.from === from && e.to === to))
      edges.push({ from, to, type })
  }
  const column = kind => ({
    client: 'clients',
    gateway: 'entry',
    service: 'services',
    neighbor: 'services',
    storage: 'platform',
    queue: 'platform',
    observability: 'platform',
    external: 'external',
  })[kind]
  const infraNode = (text) => {
    for (const [re, info] of INFRA) {
      if (re.test(text)) {
        const id = slug(info.label)
        return add(id, {
          label: info.label,
          sub: info.sub,
          kind: info.kind,
          column: column(info.kind),
        })
      }
    }
    return null
  }
  const edgeType = kind => (kind === 'queue'
    ? 'event'
    : kind === 'observability'
      ? 'metrics'
      : kind === 'storage'
        ? 'data'
        : 'http')

  // ---------- docker-compose ----------
  const composeFiles = all.filter(f => /(?:^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(f)).slice(0, 6)
  const svcIds = new Map() // имя в compose → id узла
  for (const f of composeFiles) {
    let doc
    try { doc = YAML.parse(files.read(f) || '') }
    catch { continue }
    for (const [name, s] of Object.entries(doc?.services || {})) {
      const image = String(s?.image || '')
      const ports = (s?.ports || []).map(p => `:${String(typeof p === 'object'
        ? p.published || p.target
        : p).split(':').slice(-2)[0]}`).slice(0, 2).join(' ')
      const infra = INFRA.find(([re]) => re.test(image) || (!image && re.test(name)))
      let node
      if (infra) {
        node = infraNode(image || name)
        const ver = image.split(':')[1]
        if (node && !infra[1].merge) {
          node.sub = [
            node.sub,
            ver && ver !== 'latest'
              ? ver
              : '',
            ports,
          ].filter(Boolean).join(' · ')
        }
        if (node && infra[1].merge) {
          node.sub = [
            ...new Set([
              ...(node.sub || '').split(' · ').filter(Boolean),
              name,
            ]),
          ].join(' · ')
        }
      }
      else {
        node = add(slug(name), {
          label: name,
          sub: ports,
          kind: 'service',
          column: 'services',
        })
      }
      if (node)
        svcIds.set(name, node.id)
    }
    for (const [name, s] of Object.entries(doc?.services || {})) {
      const from = svcIds.get(name)
      const deps = Array.isArray(s?.depends_on)
        ? s.depends_on
        : Object.keys(s?.depends_on || {})
      const env = JSON.stringify(s?.environment || {})
      for (const [other, id] of svcIds) {
        if (other === name)
          continue
        if (deps.includes(other) || new RegExp(`[/@=:"]${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:/"]`).test(env))
          link(from, id, edgeType(nodes.get(id)?.kind))
      }
      // метки Traefik → вход → сервис
      const labels = JSON.stringify(s?.labels || {})
      if (/traefik\.http\.routers/.test(labels)) {
        const gw = [
          ...nodes.values(),
        ].find(n => n.kind === 'gateway')
        if (gw)
          link(gw.id, from, 'http')
      }
      for (const [re, label] of EXTERNAL) {
        if (re.test(env)) {
          add(slug(label), { label, kind: 'external', column: 'external' })
          link(from, slug(label), 'http')
        }
      }
    }
  }

  // ---------- приложение без compose: package.json / python ----------
  const pkgs = all.filter(f => /(?:^|\/)package\.json$/.test(f) && !f.includes('node_modules') && f.split('/').length <= 3)
  let appId = null
  for (const f of pkgs) {
    let pkg
    try { pkg = JSON.parse(files.read(f) || '{}') }
    catch { continue }
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }
    const names = Object.keys(deps)
    const has = re => names.some(n => re.test(n))
    const dir = f.replace(/\/?package\.json$/, '')
    if (composeFiles.length && dir && [
      ...svcIds.keys(),
    ].some(k => dir.endsWith(k))) {
      continue
    } // сервис уже есть из compose
    const fw = has(/^nuxt$/)
      ? `Nuxt ${String(deps.nuxt).replace(/[^\d.]/g, '').split('.')[0]}`
      : has(/^next$/)
        ? 'Next.js'
        : has(/^@sveltejs\/kit$/)
          ? 'SvelteKit'
          : has(/^(vite)$/) && has(/^vue$/)
            ? 'Vue + Vite'
            : has(/^(vite)$/) && has(/^react$/)
              ? 'React + Vite'
              : has(/^express$|^fastify$|^hono$|^koa$/)
                ? 'Node.js'
                : null
    if (!fw)
      continue
    const fullstack = has(/^nuxt$|^next$|^@sveltejs\/kit$/) || has(/^express$|^fastify$|^hono$|^koa$/)
    const label = dir
      ? dir.split('/').pop()
      : (pkg.name || repo.split('/')[1])
    const id = slug(label)
    add(id, {
      label,
      sub: fw,
      kind: fullstack ? 'service' : 'client',
      column: fullstack ? 'services' : 'clients',
    })
    appId ??= id
    for (const [re] of INFRA.filter(([, i]) => i.kind !== 'gateway')) {
      const dep = names.find(n => re.test(n))
      if (dep && fullstack) {
        const n = infraNode(dep)
        if (n)
          link(id, n.id, edgeType(n.kind))
      }
    }
    for (const [re, l] of EXTERNAL) {
      if (has(re)) {
        add(slug(l), { label: l, kind: 'external', column: 'external' })
        link(id, slug(l), 'http')
      }
    }
    if (has(/^@capacitor\/(ios|android)$/)) {
      add('mobile', {
        label: 'iOS / Android',
        sub: 'Capacitor',
        kind: 'client',
        column: 'clients',
      })
    }
    if (!fullstack)
      nodes.get(id).column = 'clients'
  }
  for (const f of all.filter(f => /(?:^|\/)(?:requirements[\w-]*\.txt|pyproject\.toml)$/.test(f)).slice(0, 20)) {
    const t = files.read(f) || ''
    const dir = f.split('/').slice(0, -1).join('/')
    const fw = /fastapi/i.test(t)
      ? 'Python · FastAPI'
      : /django/i.test(t)
        ? 'Python · Django'
        : /flask/i.test(t)
          ? 'Python · Flask'
          : /aiogram|telegram/i.test(t)
            ? 'Python · бот'
            : null
    if (!fw)
      continue
    const name = dir.split('/').pop() || repo.split('/')[1]
    const id = svcIds.get(name) || slug(name)
    const n = add(id, { label: name, kind: 'service', column: 'services' })
    if (!String(n.sub || '').includes('Python'))
      n.sub = [fw, n.sub].filter(Boolean).join(' · ')
    for (const [re] of INFRA) {
      if (re.test(t)) {
        const inf = infraNode(t.match(re)[0])
        if (inf && inf.kind !== 'gateway')
          link(id, inf.id, edgeType(inf.kind))
      }
    }
  }

  // ---------- клиенты, вход ----------
  if (all.some(f => /manifest\.webmanifest$|(?:^|\/)sw\.js$/.test(f)) || appId) {
    if (![
      ...nodes.values(),
    ].some(n => n.column === 'clients')) {
      add('browser', {
        label: 'Браузер',
        sub: all.some(f => /manifest\.webmanifest$/.test(f))
          ? 'веб · PWA'
          : 'веб',
        kind: 'client',
        column: 'clients',
      })
    }
  }
  if (all.includes('vercel.json') || /vercel/.test(files.read('nuxt.config.ts') || '')) {
    add('vercel', {
      label: 'Vercel',
      sub: 'хостинг · CDN',
      kind: 'gateway',
      column: 'entry',
    })
  }
  if (all.some(f => /(?:^|\/)netlify\.toml$/.test(f))) {
    add('netlify', {
      label: 'Netlify',
      sub: 'хостинг',
      kind: 'gateway',
      column: 'entry',
    })
  }
  const gw = [
    ...nodes.values(),
  ].filter(n => n.kind === 'gateway')
  const services = [
    ...nodes.values(),
  ].filter(n => n.kind === 'service')
  for (const c of [
    ...nodes.values(),
  ].filter(n => n.kind === 'client')) {
    if (gw.length) {
      link(c.id, gw[0].id, 'http')
    }
    else {
      for (const s of services.slice(0, 3)) link(c.id, s.id, 'http')
    }
  }
  if (gw.length && !edges.some(e => e.from === gw[0].id)) {
    for (const s of services) link(gw[0].id, s.id, 'http')
  }

  // ---------- внешние API: адреса в коде и .env.example ----------
  const hosts = new Map() // бренд → { hosts:Set, server:bool }
  // адреса — одним git grep (files.urls), без чтения каждого файла
  for (const { file: f, url } of files.urls()) {
    if (!(CODE.test(f) || /(?:^|\/)\.env\.(?:example|sample|template)$/.test(f)) || /(?:^|\/)(?:node_modules|dist|build|\.output|vendor|test|tests|e2e|__tests__)\//.test(f) || /\.(?:test|spec)\./.test(f))
      continue
    for (const m of [
      url.match(/^(?:https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})/i),
    ].filter(Boolean)) {
      const host = m[1].toLowerCase()
      if (NOT_API.test(host))
        continue
      const server = SERVER_DIR.test(f) || /\.env\./.test(f)
      const apiLike = /^(?:api|ws|oauth|accounts|auth|sdk|graph|gateway|push|smtp)\.|api/i.test(host)
      if (!server && !apiLike)
        continue
      const brand = EXTERNAL.find(([re]) => re.test(host))?.[1] || host.split('.').slice(-2).join('.')
      const h = hosts.get(brand) || {
        hosts: new Set(),
        server: false,
      }
      h.hosts.add(host); h.server ||= server
      hosts.set(brand, h)
    }
  }
  const caller = services[0]?.id || appId
  const client = [
    ...nodes.values(),
  ].find(n => n.kind === 'client')?.id
  for (const [brand, h] of hosts) {
    const id = slug(brand)
    add(id, {
      label: brand,
      sub: [...h.hosts].slice(0, 3).join(', '),
      kind: 'external',
      column: 'external',
    })
    const from = h.server
      ? caller
      : client || caller
    if (from)
      link(from, id, 'http')
  }

  const list = [
    ...nodes.values(),
  ]
  return {
    title: repo.split('/')[1],
    columns: COLUMNS.filter(c => list.some(n => n.column === c.id)),
    nodes: list,
    edges,
    views: defaultViews(list, edges),
  }
}

// стандартные виды: общая карта + по типам связей, что есть
export function defaultViews(nodes, edges) {
  const v = [
    { id: 'all', title: 'Общая карта' },
  ]
  const has = t => edges.some(e => e.type === t)
  if (has('data')) {
    v.push({
      id: 'data',
      title: 'Данные и хранилища',
      edgeTypes: ['data'],
    })
  }
  if (has('event')) {
    v.push({
      id: 'events',
      title: 'События',
      edgeTypes: ['event'],
    })
  }
  if (edges.some(e => e.type === 'http' && nodes.find(n => n.id === e.to)?.kind === 'external')) {
    v.push({
      id: 'external',
      title: 'Внешние системы',
      kinds: ['external'],
    })
  }
  if (has('metrics')) {
    v.push({
      id: 'obs',
      title: 'Наблюдаемость',
      edgeTypes: ['metrics'],
    })
  }
  return v
}

// Формат файла — для ИИ (вставляется в задачу) и для README
export const FORMAT = `docs/architecture.json — схема архитектуры проекта (её рисует панель бота).
{
  "title": "Название",
  "columns": [{ "id": "clients", "title": "Клиенты" }, { "id": "entry", "title": "Вход" }, { "id": "services", "title": "Сервисы" }, { "id": "platform", "title": "Платформа" }, { "id": "external", "title": "Внешние системы" }],
  "nodes": [{ "id": "auth", "label": "auth-service", "sub": "Python · FastAPI · :8001", "column": "services", "kind": "service", "repo": "owner/repo (если в другом репозитории)", "manual": true }],
  "edges": [{ "from": "traefik", "to": "auth", "type": "http", "label": "необязательно" }],
  "views": [{ "id": "data", "title": "Данные и хранилища", "edgeTypes": ["data"] }, { "id": "auth", "title": "Вход и авторизация", "nodes": ["traefik", "auth"] }]
}
kind: client | gateway | service | neighbor (сервис из соседнего репозитория) | storage | queue | observability | external.
type связи: http (вызов) | data (чтение/запись в хранилище) | event (очередь, события) | metrics (логи, метрики).
Колонки — любые, слева направо по пути запроса. Вид (views) — фильтр: edgeTypes, kinds или явный список nodes.
"manual": true — узел добавлен человеком: не удалять и не менять.`
