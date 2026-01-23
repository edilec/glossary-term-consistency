import assert from 'node:assert/strict'
import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  ConfigError,
  DEFAULT_LIMITS,
  cleanLabel,
  extractDefinitions,
  findAliasHits,
  maskCode,
  maskCodeSpans,
  normalizeDefinition,
  readCorpus,
  similarity,
  surfaceFormPattern,
} from '../src/index.mjs'
import { makeTree, steppingClock } from './helpers.mjs'

const limits = (overrides) => ({ ...DEFAULT_LIMITS, ...overrides })

const keyOf = (label) => {
  const key = label.trim().toLowerCase()
  return ['artifact', 'charge', 'token'].includes(key) ? key : undefined
}

test('documents are read in the order given, not in filesystem order', async () => {
  const root = await makeTree({ 'a.md': 'alpha\n', 'b.md': 'beta\n', 'c.md': 'gamma\n' })
  const first = await readCorpus(['b.md', 'a.md', 'c.md'], { root })
  assert.deepEqual(first.documents.map((document) => document.file), ['b.md', 'a.md', 'c.md'])
  const second = await readCorpus(['c.md', 'b.md'], { root })
  assert.deepEqual(second.documents.map((document) => document.file), ['c.md', 'b.md'])
})

test('an absolute path, a ".." segment and a repeated input are configuration errors', async () => {
  const root = await makeTree({ 'a.md': 'alpha\n' })
  await assert.rejects(() => readCorpus([join(root, 'a.md')], { root }), ConfigError)
  await assert.rejects(() => readCorpus(['../a.md'], { root }), ConfigError)
  await assert.rejects(() => readCorpus(['sub/../a.md'], { root }), ConfigError)
  await assert.rejects(() => readCorpus(['a.md', 'a.md'], { root }), ConfigError)
})

test('a missing input is a reported failure, not a silent skip', async () => {
  const root = await makeTree({ 'a.md': 'alpha\n' })
  const { documents, failures } = await readCorpus(['a.md', 'gone.md'], { root })
  assert.deepEqual(documents.map((document) => document.file), ['a.md'])
  assert.deepEqual(failures.map((failure) => [failure.ruleId, failure.file]), [['input-unreadable', 'gone.md']])
})

test('a symlink to a file outside the root is refused and never read', async () => {
  const outside = await makeTree({ 'secret.md': 'OUTSIDE-OF-ROOT-CONTENT\n' })
  const root = await makeTree({ 'a.md': 'alpha\n' })
  await symlink(join(outside, 'secret.md'), join(root, 'escape.md'))
  const { documents, failures } = await readCorpus(['escape.md', 'a.md'], { root })
  assert.deepEqual(documents.map((document) => document.file), ['a.md'])
  assert.deepEqual(failures.map((failure) => [failure.ruleId, failure.file]), [['path-outside-root', 'escape.md']])
  assert.ok(!JSON.stringify(failures).includes('OUTSIDE-OF-ROOT-CONTENT'))
})

test('a symlink to a directory outside the root is refused for every file under it', async () => {
  const outside = await makeTree({ 'notes/secret.md': 'OUTSIDE-OF-ROOT-CONTENT\n' })
  const root = await makeTree({ 'a.md': 'alpha\n' })
  await symlink(join(outside, 'notes'), join(root, 'linked'))
  const { documents, failures } = await readCorpus(['linked/secret.md'], { root })
  assert.deepEqual(documents, [])
  assert.deepEqual(failures.map((failure) => [failure.ruleId, failure.file]), [
    ['path-outside-root', 'linked/secret.md'],
  ])
  assert.ok(!JSON.stringify(failures).includes('OUTSIDE-OF-ROOT-CONTENT'))
})

test('a symlink that stays inside the root is followed normally', async () => {
  const root = await makeTree({ 'real/a.md': 'alpha\n' })
  await symlink(join(root, 'real', 'a.md'), join(root, 'link.md'))
  const { documents, failures } = await readCorpus(['link.md'], { root })
  assert.deepEqual(failures, [])
  assert.deepEqual(documents.map((document) => [document.given, document.file]), [['link.md', 'real/a.md']])
})

test('bytes that are not UTF-8 are reported, and a literal U+FFFD is still checked', async () => {
  const root = await makeTree({ 'good.md': 'token: a � replacement character\n' })
  await writeFile(join(root, 'bad.md'), Buffer.from([0x41, 0xff, 0x42]))
  const { documents, failures } = await readCorpus(['bad.md', 'good.md'], { root })
  assert.deepEqual(failures.map((failure) => [failure.ruleId, failure.file]), [['input-not-utf8', 'bad.md']])
  assert.deepEqual(documents.map((document) => document.file), ['good.md'])
  assert.equal(documents[0].lines[0], 'token: a � replacement character')
})

test('a directory given as an input is a reported failure', async () => {
  const root = await makeTree({ 'sub/a.md': 'alpha\n' })
  const { documents, failures } = await readCorpus(['sub'], { root })
  assert.deepEqual(documents, [])
  assert.deepEqual(failures.map((failure) => [failure.ruleId, failure.message]), [
    ['input-unreadable', 'input is not a regular file'],
  ])
})

test('the maxDocuments limit stops the run before anything is read', async () => {
  const root = await makeTree({ 'a.md': 'alpha\n', 'b.md': 'beta\n' })
  const { documents, failures } = await readCorpus(['a.md', 'b.md'], { root, limits: limits({ maxDocuments: 1 }) })
  assert.deepEqual(documents, [])
  assert.deepEqual(failures.map((failure) => [failure.ruleId, failure.limit]), [['limit-exceeded', 'maxDocuments']])
})

test('the maxFileBytes limit is enforced per file', async () => {
  const root = await makeTree({ 'small.md': 'ok\n', 'big.md': 'x'.repeat(400) })
  const { documents, failures } = await readCorpus(['big.md', 'small.md'], { root, limits: limits({ maxFileBytes: 100 }) })
  assert.deepEqual(documents.map((document) => document.file), ['small.md'])
  assert.deepEqual(failures.map((failure) => [failure.ruleId, failure.limit, failure.file]), [
    ['limit-exceeded', 'maxFileBytes', 'big.md'],
  ])
})

test('the maxLines limit is enforced per file', async () => {
  const root = await makeTree({ 'long.md': 'a\nb\nc\nd\n' })
  const { documents, failures } = await readCorpus(['long.md'], { root, limits: limits({ maxLines: 3 }) })
  assert.deepEqual(documents, [])
  assert.deepEqual(failures.map((failure) => [failure.ruleId, failure.limit]), [['limit-exceeded', 'maxLines']])
})

test('the timeLimitMs budget stops reading and says so', async () => {
  const root = await makeTree({ 'a.md': 'alpha\n', 'b.md': 'beta\n' })
  const generous = await readCorpus(['a.md', 'b.md'], {
    root,
    limits: limits({ timeLimitMs: 1_000 }),
    clock: steppingClock(1),
  })
  assert.deepEqual(generous.documents.map((document) => document.file), ['a.md', 'b.md'])
  assert.deepEqual(generous.failures, [])

  const tight = await readCorpus(['a.md', 'b.md'], {
    root,
    limits: limits({ timeLimitMs: 5 }),
    clock: steppingClock(10),
  })
  assert.deepEqual(tight.documents, [])
  assert.deepEqual(tight.failures.map((failure) => [failure.ruleId, failure.limit]), [
    ['limit-exceeded', 'timeLimitMs'],
  ])
})

test('a root that does not exist is a configuration error', async () => {
  const root = await makeTree({ 'a.md': 'alpha\n' })
  await assert.rejects(() => readCorpus(['a.md'], { root: join(root, 'nowhere') }), ConfigError)
})

test('an inline code span is masked without moving any column', () => {
  assert.equal(maskCodeSpans('a `b c` d'), 'a       d')
  assert.equal(maskCodeSpans('``a`b`` c'), '        c')
  assert.equal(maskCodeSpans('an unclosed ` backtick'), 'an unclosed ` backtick')
})

test('a fenced block is masked entirely, and the lines after it are not', () => {
  const lines = ['before', '```text', 'artefact', '```', 'after']
  const masked = maskCode(lines)
  assert.deepEqual(masked.map((entry) => entry.fenced), [false, true, true, true, false])
  assert.deepEqual(masked.map((entry) => entry.text), ['before', '       ', '        ', '   ', 'after'])
})

test('a label keeps its text when its emphasis or code marks are stripped', () => {
  assert.equal(cleanLabel('**artifact**'), 'artifact')
  assert.equal(cleanLabel('`artifact`'), 'artifact')
  assert.equal(cleanLabel('__artifact__'), 'artifact')
  assert.equal(cleanLabel('  artifact  '), 'artifact')
  assert.equal(cleanLabel('**'), '**')
})

test('every recognised definition form is found, and nothing else is', () => {
  const lines = [
    '# Heading',
    '- **artifact**: A file produced by a build.',
    '**charge** — An amount of money.',
    'token: A short-lived credential.',
    '> **artifact**: A quoted definition.',
    'The artifact: this sentence is not a definition of it.',
    'state-of-the-art: not a glossary term',
    '```',
    '**token**: inside a fence.',
    '```',
  ]
  const found = extractDefinitions(lines, maskCode(lines), keyOf)
  assert.deepEqual(
    found.map((definition) => [definition.term, definition.line, definition.column, definition.text]),
    [
      ['artifact', 2, 3, 'A file produced by a build.'],
      ['charge', 3, 1, 'An amount of money.'],
      ['token', 4, 1, 'A short-lived credential.'],
      ['artifact', 5, 3, 'A quoted definition.'],
    ],
  )
})

test('a discouraged alias matches whole terms only', () => {
  const lines = [
    'Every artefact matters.',
    'artefacts and build-artefact and Artefact.',
    'An `artefact` in code.',
  ]
  const aliases = [{ alias: 'artefact', prefer: 'artifact', reason: null, key: 'artefact', index: 0 }]
  const hits = findAliasHits(lines, maskCode(lines), aliases, false)
  assert.deepEqual(hits.map((hit) => [hit.line, hit.column]), [
    [1, 7],
    [2, 34],
  ])
})

test('a case-sensitive run only matches the declared spelling', () => {
  const lines = ['Artefact and artefact.']
  const aliases = [{ alias: 'artefact', prefer: 'artifact', reason: null, key: 'artefact', index: 0 }]
  assert.deepEqual(findAliasHits(lines, maskCode(lines), aliases, true).map((hit) => hit.column), [14])
  assert.deepEqual(findAliasHits(lines, maskCode(lines), aliases, false).map((hit) => hit.column), [1, 14])
})

test('a multi-word alias matches across any run of whitespace', () => {
  const pattern = surfaceFormPattern('api key', false)
  assert.equal(pattern.test('use an api   key here'), true)
  pattern.lastIndex = 0
  assert.equal(pattern.test('use an apikey here'), false)
})

test('lexical overlap is the Dice coefficient over content words', () => {
  const short = 'A short-lived credential that authorises an API request.'
  const permanent = 'A permanent shared secret that anyone on the team may reuse.'
  assert.equal(similarity(short, short), 1)
  assert.equal(similarity(short, permanent), 0)
  assert.equal(
    Number(similarity('A file produced by a build.', 'A file produced by a build and stored.').toFixed(3)),
    0.857,
  )
  assert.equal(similarity('the and of', 'the and of'), 1)
  assert.equal(similarity('the and of', 'a build'), 0)
})

test('a definition compares without emphasis, trailing punctuation or case', () => {
  assert.equal(normalizeDefinition('**A file**  produced by a build.'), 'a file produced by a build')
  assert.equal(normalizeDefinition('A file produced by a build'), 'a file produced by a build')
})
