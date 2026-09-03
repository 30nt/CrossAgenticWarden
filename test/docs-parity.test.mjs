// Two copies of a document drift, and the half that matters when they do is the commands: a
// reader runs those. Prose may differ freely — it is a translation. Every `bash` block must not.
//
// Comment lines are excluded on purpose, so a translator can translate them; what is pinned is
// the executable half. A pair whose Russian copy is missing fails here rather than at a reader.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const PAIRS = [
  ['README.md', 'docs/readme.ru.md'],
  ['WHY.md', 'docs/why.ru.md'],
  ['docs/install.md', 'docs/install.ru.md'],
  ['docs/gate.md', 'docs/gate.ru.md'],
  ['docs/updating.md', 'docs/updating.ru.md'],
  ['docs/architecture.md', 'docs/architecture.ru.md'],
  ['docs/limitations.md', 'docs/limitations.ru.md'],
  ['CONTRIBUTING.md', 'docs/contributing.ru.md'],
]

// A `#` starts a comment only outside quotes, so the quote state is tracked rather than
// assumed. `sed 's/#x/y/'` keeps its hash; a trailing `# note` does not.
const stripComment = (line) => {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

const commands = (markdown) => {
  const blocks = []
  // The fence may be indented when the block sits inside a list item, and one in the manual
  // does. An anchored `^```bash` misses those, which is a parity check with a hole in it.
  const re = /^[ \t]*```bash\n([\s\S]*?)^[ \t]*```$/gm
  let m
  while ((m = re.exec(markdown)) !== null) {
    const lines = m[1].split('\n')
      .map((line) => stripComment(line).trim())
      .filter((line) => line.trim())
    blocks.push(lines.join('\n'))
  }
  return blocks
}

for (const [english, russian] of PAIRS) {
  test(`${english} and ${russian} carry the same commands`, () => {
    for (const path of [english, russian]) {
      assert.equal(existsSync(join(ROOT, path)), true, `${path} is missing`)
    }
    const en = commands(readFileSync(join(ROOT, english), 'utf8'))
    const ru = commands(readFileSync(join(ROOT, russian), 'utf8'))
    assert.equal(ru.length, en.length,
      `${russian} has ${ru.length} bash block(s), ${english} has ${en.length}`)
    for (let i = 0; i < en.length; i++) {
      assert.equal(ru[i], en[i], `bash block ${i + 1} differs between ${english} and ${russian}`)
    }
  })
}

test('every English document links its Russian copy, and back', () => {
  for (const [english, russian] of PAIRS) {
    if (!existsSync(join(ROOT, english)) || !existsSync(join(ROOT, russian))) continue
    const en = readFileSync(join(ROOT, english), 'utf8')
    const ru = readFileSync(join(ROOT, russian), 'utf8')
    assert.match(en, /\[Русская версия\]\(/, `${english} does not link its Russian copy`)
    assert.match(ru, /\[English version\]\(/, `${russian} does not link back`)
  }
})
