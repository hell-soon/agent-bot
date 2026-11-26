import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

function stat(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      throw error
  }
}

function needsRules() {
  return !stat('AGENTS.md') && !stat('CLAUDE.md')
}

function detectedCommands() {
  if (!stat('package.json')?.isFile())
    return []
  let pkg
  try {
    pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError)
      return []
    throw error
  }
  const manager = ['npm', 'pnpm', 'yarn', 'bun'].find(name => typeof pkg?.packageManager === 'string' && pkg.packageManager.startsWith(name + '@'))
    || [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']].find(([file]) => existsSync(file))?.[1]
    || 'npm'
  return ['dev', 'start', 'typecheck', 'lint', 'test', 'build']
    .filter(name => typeof pkg?.scripts?.[name] === 'string' && pkg.scripts[name].trim())
    .map(name => manager + ' run ' + name)
}

function writeNew(path, content) {
  try {
    writeFileSync(path, content, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST')
      throw error
  }
}

function prepare(answers) {
  if (!stat('docs'))
    mkdirSync('docs', { recursive: true })
  if (stat('docs')?.isDirectory() && !stat('docs/agents'))
    mkdirSync('docs/agents', { recursive: true })
  const hasDocs = stat('docs')?.isDirectory() && stat('docs/agents')?.isDirectory()
  if (hasDocs)
    writeNew('docs/agents/README.md', '# Настройки агента\n\nЗдесь можно описать трекер задач, метки и проектные документы для скиллов агента.\n')
  if (!needsRules())
    return

  const commands = detectedCommands()
  const sections = [
    '# Правила работы агента',
    hasDocs && 'Настройки скиллов и ссылки на проектные документы находятся в [docs/agents/](docs/agents/).',
    commands.length > 0 && '## Команды из package.json\n\n' + commands.map(command => '- `' + command + '`').join('\n'),
    ...answers.map(([title, value]) => value?.trim() && '## ' + title + '\n\n' + value.trim()),
  ]
  writeNew('AGENTS.md', sections.filter(Boolean).join('\n\n') + '\n')
}

const [mode, commands, context, rules] = process.argv.slice(2)
const questions = [
  ['Команды от владельца', 'Какие команды запуска и проверки нужно добавить или уточнить?'],
  ['Особенности проекта', 'Что боту нужно знать о структуре или особенностях проекта?'],
  ['Правила от владельца', 'Какие правила работы нужно соблюдать?'],
]
if (mode === 'prepare') {
  prepare(questions.map(([title], index) => [title, [commands, context, rules][index]]))
} else if (needsRules()) {
  const found = detectedCommands()
  const intro = found.length ? 'Нашёл команды: ' + found.join(', ') + '.' : 'В корневом package.json не нашёл команд запуска и проверки.'
  if (mode === 'panel') {
    console.log(JSON.stringify({
      type: 'bot_setup',
      text: intro + '\n\n' + questions.map(([, question], index) => (index + 1) + '. ' + question).join('\n')
        + '\n\nОтветьте по номерам (один пункт на строку). Любой пункт можно пропустить. Чтобы продолжить без опроса, напишите «Пропустить».',
    }))
  } else if (mode === 'tty') {
    console.log(intro)
  }
}
