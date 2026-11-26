import { posix } from 'node:path'

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const isDocument = file => file === 'README.md' || (file.startsWith('docs/') && /\.md$/i.test(file))

function changedBlocks(patch) {
  return (patch || '').split(/\n(?=[^+-])/).map((block) => {
    const lines = block.split('\n')
    return {
      before: lines.filter(line => line.startsWith('-')).map(line => line.slice(1).trim()),
      after: lines.filter(line => line.startsWith('+')).map(line => line.slice(1).trim()),
    }
  })
}

function packageScripts(text) {
  try {
    const scripts = JSON.parse(text?.replace(/^\uFEFF/, '') || '{}')?.scripts
    return scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? scripts
      : {}
  }
  catch { return {} }
}

function scriptReplacements(blocks, mergedScripts, currentScripts) {
  const entries = lines => lines.map(line => line.match(/^"([\w:.-]+)"\s*:\s*("(?:[^"\\]|\\.)*")\s*,?$/))
    .filter(Boolean)
  const removed = entries(blocks.flatMap(block => block.before))
    .filter(([, name]) => !Object.hasOwn(mergedScripts, name) && !Object.hasOwn(currentScripts, name))
  const added = entries(blocks.flatMap(block => block.after))
    .filter(([, name, command]) => Object.hasOwn(mergedScripts, name) && JSON.stringify(mergedScripts[name]) === command)
  return removed.flatMap(([, oldName, oldCommand]) => {
    const matches = added.filter(([, , command]) => oldCommand === command)
    const successor = matches.length === 1
      ? matches[0]
      : removed.length === 1 && added.length === 1
        ? added[0]
        : null
    if (!successor)
      return []
    const [, renamed] = successor
    // Several PRs may have been merged while the panel was closed.
    const currentNames = Object.keys(currentScripts).filter(name => currentScripts[name] === mergedScripts[renamed])
    const name = Object.hasOwn(currentScripts, renamed)
      ? renamed
      : currentNames.length === 1
        ? currentNames[0]
        : null
    if (!name)
      return []
    return [
      ...['bun', 'npm', 'pnpm', 'yarn'].map(tool => [`${tool} run ${oldName}`, `${tool} run ${name}`]),
      ...(['test', 'start', 'stop', 'restart'].includes(oldName)
        ? [
            [`npm ${oldName}`, `npm run ${name}`],
          ]
        : []),
    ]
  })
}

function replacementMatcher(matches, allowRelativePrefix = false) {
  if (!matches.length)
    return text => text
  const entries = new Map(matches.map(({ oldText, newText }) => [oldText, newText]))
  const alternatives = [
    ...entries.keys(),
  ].sort((a, b) => b.length - a.length).map(escape).join('|')
  const relativePrefix = allowRelativePrefix ? '(?:\\./)?' : ''
  const pattern = new RegExp(`(?<![\\w./-])${relativePrefix}(?:${alternatives})(?![\\w./-])`, 'g')
  return text => text.replace(pattern, (match) => {
    if (entries.has(match))
      return entries.get(match)
    return `./${entries.get(match.slice(2))}`
  })
}

export async function findDocDrift(files, tree, documents, mergeSha) {
  const replacements = new Map()
  function add(oldText, newText, path = false) {
    if (!oldText || !newText || oldText === newText || oldText.length > 1000 || newText.length > 1000)
      return
    const key = `${path}:${oldText}`
    if (!replacements.has(key)) {
      replacements.set(key, {
        oldText,
        values: new Set(),
        path,
      })
    }
    replacements.get(key).values.add(newText)
  }

  for (const file of files) {
    if (file.status === 'renamed')
      add(file.previous_filename, file.filename, true)
    if (isDocument(file.filename))
      continue
    const blocks = changedBlocks(file.patch)
    if (/(?:^|\/)package\.json$/.test(file.filename)) {
      if (!file.patch)
        continue
      const currentScripts = packageScripts(await tree.read(file.filename, { optional: true }))
      const mergedScripts = mergeSha
        ? packageScripts(await tree.read(file.filename, { ref: mergeSha, optional: true }))
        : currentScripts
      for (const [oldCommand, newCommand] of scriptReplacements(blocks, mergedScripts, currentScripts))
        add(oldCommand, newCommand)
      continue
    }
    for (const { before, after } of blocks) {
      if (before.length !== after.length)
        continue
      for (const [index, oldLine] of before.entries()) {
        const newLine = after[index]
        if (oldLine.length >= 5 && newLine && !/^(?:\/\/|[#*])/.test(oldLine)
          && (before.length === 1 || oldLine.split(/\s+/, 1)[0] === newLine.split(/\s+/, 1)[0])) {
          add(oldLine, newLine)
        }
        const oldLiteral = oldLine.match(/^([^'"]*)(['"])([^'"]+)\2([^'"]*)$/)
        const newLiteral = newLine.match(/^([^'"]*)(['"])([^'"]+)\2([^'"]*)$/)
        if (oldLiteral && newLiteral && oldLiteral[1] === newLiteral[1] && oldLiteral[4] === newLiteral[4])
          add(oldLiteral[3], newLiteral[3])
      }
    }
  }

  const matches = [
    ...replacements.values(),
  ].filter(({ values }) => values.size === 1).map(({ oldText, values, path }) => ({
    oldText,
    path,
    newText: [...values][0],
  }))
  const paths = matches.filter(match => match.path)
  const replacePaths = replacementMatcher(paths, true)
  const replaceCode = replacementMatcher(matches.filter(match => !match.path))
  const findings = []
  for (const [file, text] of documents) {
    const lines = text.split(/\r?\n/)
    const relativeLinks = new Map(paths.map(({ oldText, newText }) => [
      posix.relative(posix.dirname(file), oldText),
      posix.relative(posix.dirname(file), newText),
    ]))
    let fence = null
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim()
      const marker = trimmed.match(/^(`{3,}|~{3,})/)?.[0]
      const closesFence = marker && fence && marker[0] === fence[0] && marker.length >= fence.length && marker.length === trimmed.length
      if (marker && (!fence || closesFence)) {
        fence = fence ? null : marker
        continue
      }
      if (line.length > 1000)
        continue
      const withLinks = fence
        ? line
        : line.replace(/(\]\(<?)([^#?)<>\s]+)(?=[#?)>\s])/g, (match, start, target) => {
            const replacement = relativeLinks.get(target.replace(/^\.\//, ''))
            return replacement
              ? start + (target.startsWith('./') && !replacement.startsWith('../')
                ? './'
                : '') + replacement
              : match
          })
      const withPaths = replacePaths(withLinks)
      const suggestion = fence
        ? replaceCode(withPaths)
        : withPaths.replace(/(`+)([^`]+)\1/g, (_, ticks, code) => ticks + replaceCode(code) + ticks)
      if (suggestion !== line) {
        findings.push({
          file,
          line: index + 1,
          fragment: line,
          suggestion,
        })
      }
    }
  }
  return findings
}
