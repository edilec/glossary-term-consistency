/**
 * Reading the corpus, and reading a definition out of a line.
 *
 * Two things are deliberate here.
 *
 * Confinement is real, not lexical. A corpus path is rejected if it is absolute
 * or contains a `..` segment, and then the *real* path is resolved and asserted
 * to be inside the *real* root. A symlink planted inside the root that points
 * out of the tree is reported as `path-outside-root` and its content is never
 * read, so it cannot reach the report.
 *
 * Decoding is strict. `TextDecoder('utf-8', { fatal: true })` decides whether a
 * file is UTF-8. Nothing infers encoding validity from decoded text, so a file
 * that legitimately contains U+FFFD is checked normally and a file whose bytes
 * are undecodable is `incomplete`, never a pass.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { ConfigError } from './rules.mjs'
import { DEFAULT_LIMITS } from './config.mjs'

const decoder = new TextDecoder('utf-8', { fatal: true })

/** A line prefix that does not belong to the definition: quoting, list and heading markers. */
const LINE_PREFIX = /^[ \t]{0,8}(?:>[ \t]?)*(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+)?(?:#{1,6}[ \t]+)?/u

/**
 * `label separator definition`. The separator is a colon followed by space, an
 * em or en dash, or a spaced hyphen. A hyphen without spaces on both sides is
 * not a separator, so `state-of-the-art` is never read as a definition.
 *
 * The `s` flag matters: a line is whatever sat between two newlines, so a
 * U+2028 or U+2029 inside one is content rather than the end of the definition.
 */
const DEFINITION_LINE = /^(.{1,160}?)(?::[ \t]+|[ \t]*[—–][ \t]*|[ \t]+-{1,2}[ \t]+)(\S.*)$/su

const EMPHASIS = /^(\*\*|__|\*|_|`+)([\s\S]*?)\1$/u
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/u

/**
 * Whole-term boundary. A match may not be preceded or followed by a letter,
 * digit, underscore or hyphen, so `artefacts` and `build-artefact` are not
 * occurrences of `artefact`. This is the classic false positive for this check.
 */
const BOUNDARY = '[\\p{L}\\p{N}_-]'

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'may', 'not', 'of', 'on', 'or', 'that', 'the', 'their',
  'then', 'there', 'these', 'this', 'to', 'was', 'were', 'which', 'with',
])

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu

function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}

/** Build the whole-term matcher for one surface form. Internal whitespace matches any run. */
export function surfaceFormPattern(surface, caseSensitive) {
  const parts = surface.trim().split(/\s+/u).map(escapeRegExp)
  const body = parts.join('[\\s\\u00a0]+')
  return new RegExp(`(?<!${BOUNDARY})${body}(?!${BOUNDARY})`, caseSensitive ? 'gu' : 'gui')
}

/**
 * Mask the regions where a term occurrence is a sample rather than prose:
 * fenced code blocks and inline code spans. Masking replaces characters with
 * spaces so every column stays where it was.
 */
export function maskCode(lines) {
  const masked = []
  let fence = null
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line)
    if (fence === null && fenceMatch !== null) {
      fence = fenceMatch[1]
      masked.push({ text: ' '.repeat(line.length), fenced: true })
      continue
    }
    if (fence !== null) {
      const closes = fenceMatch !== null && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length
      if (closes) fence = null
      masked.push({ text: ' '.repeat(line.length), fenced: true })
      continue
    }
    masked.push({ text: maskCodeSpans(line), fenced: false })
  }
  return masked
}

/** Replace inline code spans, delimiters included, with spaces of the same width. */
export function maskCodeSpans(line) {
  const characters = [...line]
  const out = characters.slice()
  let index = 0
  while (index < characters.length) {
    if (characters[index] !== '`') {
      index += 1
      continue
    }
    let open = index
    while (open < characters.length && characters[open] === '`') open += 1
    const runLength = open - index
    let search = open
    let closed = -1
    while (search < characters.length) {
      if (characters[search] !== '`') {
        search += 1
        continue
      }
      let end = search
      while (end < characters.length && characters[end] === '`') end += 1
      if (end - search === runLength) {
        closed = end
        break
      }
      search = end
    }
    if (closed === -1) {
      index = open
      continue
    }
    for (let position = index; position < closed; position += 1) out[position] = ' '
    index = closed
  }
  return out.join('')
}

/** Strip one layer of emphasis or code marks from a term label, at most three times. */
export function cleanLabel(raw) {
  let label = raw.trim()
  for (let round = 0; round < 3; round += 1) {
    const match = EMPHASIS.exec(label)
    if (match === null || match[2].trim() === '') break
    label = match[2].trim()
  }
  return label
}

/** The definition text, with emphasis marks and a trailing full stop removed. */
export function normalizeDefinition(text) {
  return text
    .replace(/[*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.;:,]+$/u, '')
    .toLowerCase()
}

function contentTokens(text) {
  const tokens = new Set()
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    if (!STOPWORDS.has(match[0])) tokens.add(match[0])
  }
  return tokens
}

/**
 * Lexical overlap of two definitions: the Dice coefficient over content words.
 * This measures wording, not meaning; `docs/glossary-rules.md` says so, and the
 * README says what that means the tool cannot conclude.
 */
export function similarity(left, right) {
  const a = contentTokens(left)
  const b = contentTokens(right)
  if (a.size === 0 && b.size === 0) return normalizeDefinition(left) === normalizeDefinition(right) ? 1 : 0
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/**
 * Every definition line in one document. A line inside a fenced code block is
 * never a definition; a label is matched whole against the glossary key, so a
 * sentence that merely contains a term is not a definition of it.
 */
export function extractDefinitions(lines, masked, keyOf) {
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    if (masked[index].fenced) continue
    const line = lines[index]
    const prefix = LINE_PREFIX.exec(line)
    const offset = prefix === null ? 0 : prefix[0].length
    const body = line.slice(offset)
    const match = DEFINITION_LINE.exec(body)
    if (match === null) continue
    const label = cleanLabel(match[1])
    if (label === '') continue
    const term = keyOf(label)
    if (term === undefined) continue
    found.push({
      term,
      label,
      line: index + 1,
      column: offset + 1,
      text: match[2].trim(),
      raw: line,
    })
  }
  return found
}

/** Every discouraged-alias occurrence in one document, outside code. */
export function findAliasHits(lines, masked, aliases, caseSensitive) {
  const hits = []
  for (const alias of aliases) {
    const pattern = surfaceFormPattern(alias.alias, caseSensitive)
    for (let index = 0; index < lines.length; index += 1) {
      const text = masked[index].text
      if (text.trim() === '') continue
      pattern.lastIndex = 0
      let match = pattern.exec(text)
      while (match !== null) {
        hits.push({ alias, line: index + 1, column: match.index + 1, raw: lines[index] })
        if (pattern.lastIndex === match.index) pattern.lastIndex += 1
        match = pattern.exec(text)
      }
    }
  }
  return hits
}

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

function splitLines(text) {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return withoutBom.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/**
 * Read the corpus in the order the paths were given. No directory is walked, so
 * the report never depends on filesystem enumeration order.
 *
 * Returns the documents that were read in full and, separately, the inputs that
 * could not be read. A failure is never dropped: the caller turns each one into
 * a finding and marks the report `incomplete`.
 */
export async function readCorpus(files, { root = process.cwd(), limits = DEFAULT_LIMITS, clock = null } = {}) {
  const realRoot = await realpath(resolve(root)).catch(() => {
    throw new ConfigError(`Root directory "${root}" does not exist`)
  })
  const documents = []
  const failures = []

  if (files.length > limits.maxDocuments) {
    failures.push({
      ruleId: 'limit-exceeded',
      file: null,
      message: `${files.length} input documents exceed the maxDocuments limit of ${limits.maxDocuments}; nothing was read`,
      limit: 'maxDocuments',
    })
    return { root: realRoot, documents, failures }
  }

  const seen = new Map()
  const started = clock === null ? 0 : clock()
  for (const given of files) {
    if (clock !== null && clock() - started >= limits.timeLimitMs) {
      failures.push({
        ruleId: 'limit-exceeded',
        file: null,
        message: `reading stopped at the timeLimitMs budget of ${limits.timeLimitMs}ms with ${documents.length} of ${files.length} documents read`,
        limit: 'timeLimitMs',
      })
      return { root: realRoot, documents, failures }
    }
    const normalized = toPosix(given).replace(/\/+$/u, '')
    if (isAbsolute(given) || /^[A-Za-z]:/u.test(given)) {
      throw new ConfigError(`Input "${given}" must be relative to the root, not an absolute path`)
    }
    if (normalized.split('/').includes('..')) {
      throw new ConfigError(`Input "${given}" must not contain a ".." segment`)
    }
    if (seen.has(normalized)) throw new ConfigError(`Input "${given}" was given more than once`)
    seen.set(normalized, true)

    const candidate = resolve(realRoot, normalized)
    let real
    try {
      real = await realpath(candidate)
    } catch (error) {
      failures.push({
        ruleId: 'input-unreadable',
        file: normalized,
        message: `input could not be resolved (${error.code ?? 'unknown error'})`,
      })
      continue
    }
    const inside = relative(realRoot, real)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      failures.push({
        ruleId: 'path-outside-root',
        file: normalized,
        message: 'input resolves outside the declared root once symbolic links are followed; it was not read',
      })
      continue
    }
    const reported = toPosix(inside)

    let info
    try {
      info = await stat(real)
    } catch (error) {
      failures.push({
        ruleId: 'input-unreadable',
        file: reported,
        message: `input could not be inspected (${error.code ?? 'unknown error'})`,
      })
      continue
    }
    if (!info.isFile()) {
      failures.push({ ruleId: 'input-unreadable', file: reported, message: 'input is not a regular file' })
      continue
    }
    if (info.size > limits.maxFileBytes) {
      failures.push({
        ruleId: 'limit-exceeded',
        file: reported,
        message: `input is ${info.size} bytes, over the maxFileBytes limit of ${limits.maxFileBytes}`,
        limit: 'maxFileBytes',
      })
      continue
    }

    let bytes
    try {
      bytes = await readFile(real)
    } catch (error) {
      failures.push({
        ruleId: 'input-unreadable',
        file: reported,
        message: `input could not be read (${error.code ?? 'unknown error'})`,
      })
      continue
    }
    let text
    try {
      text = decoder.decode(bytes)
    } catch {
      failures.push({
        ruleId: 'input-not-utf8',
        file: reported,
        message: 'input is not valid UTF-8; it was not checked',
      })
      continue
    }
    const lines = splitLines(text)
    if (lines.length > limits.maxLines) {
      failures.push({
        ruleId: 'limit-exceeded',
        file: reported,
        message: `input has ${lines.length} lines, over the maxLines limit of ${limits.maxLines}`,
        limit: 'maxLines',
      })
      continue
    }
    documents.push({ file: reported, given: normalized, lines })
  }

  return { root: realRoot, documents, failures }
}
