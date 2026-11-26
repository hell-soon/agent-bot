// Скиллы бота: каталог (источники → SKILL.md), включение/выключение, установка из GitHub и сборка плагина .skills/,
// который agent.sh подключает к Claude Code (--plugin-dir). Codex получает путь к SKILL.md нужного скилла.
//   node ui/skills.mjs build    — пересобрать .skills/ по config.json (skillsOff)
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const BOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CONFIG = path.join(BOT, 'config.json')
const INSTALLED = path.join(BOT, 'skills') // установленные из GitHub: skills/<owner>__<repo>/
const BUILD = path.join(BOT, '.skills') // собранный плагин для Claude Code

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }
  catch { return {} }
}

// Встроенный источник — плагин mattpocock-skills из Claude Code, если установлен
function mattpocockDir() {
  const base = path.join(os.homedir(), '.claude/plugins/cache/claude-plugins-official/mattpocock-skills')
  try {
    const v = fs.readdirSync(base).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()
    return v
      ? path.join(base, v)
      : null
  }
  catch { return null }
}

// Все SKILL.md в папке (без node_modules, .git и устаревших)
function findSkillFiles(dir, depth = 0, out = []) {
  if (depth > 6)
    return out
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
  catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.git') || e.name === 'deprecated')
      continue
    const p = path.join(dir, e.name)
    if (e.isDirectory())
      findSkillFiles(p, depth + 1, out)
    else if (e.name === 'SKILL.md')
      out.push(p)
  }
  return out
}

// Frontmatter: name, description, disable-model-invocation (ручной запуск через /имя)
function parseSkill(file) {
  const text = fs.readFileSync(file, 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  const fm = {}
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/)
      if (kv)
        fm[kv[1]] = kv[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
    }
  }
  const name = fm.name || path.basename(path.dirname(file))
  return {
    name,
    description: fm.description || '',
    manual: fm['disable-model-invocation'] === 'true',
    dir: path.dirname(file),
    file,
  }
}

// Источники: встроенный (mattpocock), установленные из GitHub, скиллы самого репозитория (только показ)
export function listSources(repoWork) {
  const out = []
  const mp = mattpocockDir()
  if (mp) {
    out.push({
      id: 'mattpocock',
      label: 'mattpocock/skills',
      kind: 'builtin',
      dir: path.join(mp, 'skills'),
      url: 'https://github.com/mattpocock/skills',
    })
  }
  try {
    for (const d of fs.readdirSync(INSTALLED).sort()) {
      const dir = path.join(INSTALLED, d)
      if (fs.statSync(dir).isDirectory()) {
        out.push({
          id: `gh:${d}`,
          label: d.replace('__', '/'),
          kind: 'github',
          dir,
          url: `https://github.com/${d.replace('__', '/')}`,
          removable: true,
        })
      }
    }
  }
  catch {}
  if (repoWork && fs.existsSync(path.join(repoWork, '.claude/skills'))) {
    out.push({
      id: 'repo',
      label: 'в репозитории (.claude/skills)',
      kind: 'repo',
      dir: path.join(repoWork, '.claude/skills'),
      readonly: true,
    })
  }
  return out
}

export function listSkills(repoWork) {
  const off = new Set(readConfig().skillsOff || [])
  const skills = []
  for (const s of listSources(repoWork)) {
    for (const f of findSkillFiles(s.dir)) {
      const sk = parseSkill(f)
      const id = `${s.id}/${sk.name}`
      const group = path.relative(s.dir, path.dirname(sk.dir)).split(path.sep)[0] || ''
      skills.push({
        ...sk,
        id,
        source: s.id,
        sourceLabel: s.label,
        group,
        enabled: s.kind === 'repo' || !off.has(id),
        readonly: !!s.readonly,
      })
    }
  }
  return skills
}

// Сборка плагина: .skills/.claude-plugin/plugin.json + .skills/skills/<имя> — копии включённых скиллов
// (копии, а не ссылки: модели нужен доступ к файлам скилла, а папки источников вне её рабочих папок)
export function build() {
  const skills = listSkills().filter(s => s.enabled && s.source !== 'repo')
  fs.rmSync(path.join(BUILD, 'skills'), { recursive: true, force: true })
  fs.mkdirSync(path.join(BUILD, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(BUILD, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(BUILD, '.claude-plugin/plugin.json'), `${JSON.stringify({ name: 'bot', version: '1.0.0', description: 'Скиллы бота — собирает agent-bot (ui/skills.mjs)' }, null, 2)}\n`)
  const seen = new Set()
  for (const s of skills) {
    if (seen.has(s.name))
      continue
    seen.add(s.name)
    fs.cpSync(s.dir, path.join(BUILD, 'skills', s.name), {
      recursive: true,
      dereference: true,
      filter: src => !/node_modules|\.git(\/|$)/.test(src),
    })
  }
  return seen.size
}

function git(args, cwd) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 120000 }, (e, out, err) => (e
    ? reject(new Error(String(err || e.message).trim().split('\n').pop()))
    : resolve(out))))
}

// «owner/repo», «https://github.com/owner/repo(.git)», «…/tree/ветка/…» → owner/repo
export function parseSpec(spec) {
  const m = String(spec || '').trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/)
  return m
    ? `${m[1]}/${m[2]}`
    : null
}

export async function install(spec) {
  const repo = parseSpec(spec)
  if (!repo)
    throw new Error('Нужно owner/repo или ссылка на GitHub')
  const dir = path.join(INSTALLED, repo.replace('/', '__'))
  if (fs.existsSync(dir))
    throw new Error('Уже установлено — можно обновить')
  fs.mkdirSync(INSTALLED, { recursive: true })
  await git([
    'clone',
    '-q',
    '--depth',
    '1',
    `https://github.com/${repo}.git`,
    dir,
  ])
  const n = findSkillFiles(dir).length
  if (!n) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error('В репозитории нет SKILL.md — это не набор скиллов')
  }
  build()
  return { repo, count: n }
}

export async function update(sourceId) {
  const s = listSources().find(x => x.id === sourceId && x.kind === 'github')
  if (!s)
    throw new Error('Нет такого источника')
  await git(['pull', '-q', '--ff-only'], s.dir)
  build()
}

export function remove(sourceId) {
  const s = listSources().find(x => x.id === sourceId && x.kind === 'github')
  if (!s)
    throw new Error('Нет такого источника')
  fs.rmSync(s.dir, { recursive: true, force: true })
  build()
}

if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === 'build')
  console.log(`скиллов: ${build()}`)
