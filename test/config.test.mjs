import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConfigError,
  DEFAULT_LIMITS,
  DEFAULT_SIMILARITY_THRESHOLD,
  locateLines,
  normalizeKey,
  parseGlossary,
  parsePolicy,
  scopeOf,
} from '../src/index.mjs'
import { glossaryValue } from './helpers.mjs'

test('the default policy is the documented one', () => {
  const policy = parsePolicy()
  assert.equal(policy.caseSensitive, false)
  assert.equal(policy.similarityThreshold, DEFAULT_SIMILARITY_THRESHOLD)
  assert.deepEqual({ ...policy.limits }, {
    maxDocuments: 500,
    maxFileBytes: 1_048_576,
    maxLines: 20_000,
    maxTerms: 2_000,
    maxOccurrencesPerTerm: 1_000,
    maxFindings: 1_000,
    timeLimitMs: 10_000,
  })
})

test('a policy limit is taken from the file and the rest keep their defaults', () => {
  const policy = parsePolicy({ schemaVersion: '1', limits: { maxLines: 12 } })
  assert.equal(policy.limits.maxLines, 12)
  assert.equal(policy.limits.maxDocuments, DEFAULT_LIMITS.maxDocuments)
})

test('an unknown policy key is a configuration error, never an ignored typo', () => {
  assert.throws(() => parsePolicy({ similarityThreshhold: 0.9 }), (error) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /Unknown configuration key "similarityThreshhold"/u)
    return true
  })
})

test('an unknown limit key is rejected rather than silently ignored', () => {
  assert.throws(() => parsePolicy({ limits: { maxDocument: 3 } }), ConfigError)
})

test('a limit must be an integer at or above its floor', () => {
  assert.throws(() => parsePolicy({ limits: { maxLines: 0 } }), ConfigError)
  assert.throws(() => parsePolicy({ limits: { maxLines: 1.5 } }), ConfigError)
  assert.throws(() => parsePolicy({ limits: { timeLimitMs: -1 } }), ConfigError)
  assert.equal(parsePolicy({ limits: { timeLimitMs: 0 } }).limits.timeLimitMs, 0)
})

test('the similarity threshold must be a finite number inside [0, 1]', () => {
  assert.throws(() => parsePolicy({ similarityThreshold: 1.5 }), ConfigError)
  assert.throws(() => parsePolicy({ similarityThreshold: 'high' }), ConfigError)
  assert.equal(parsePolicy({ similarityThreshold: 0 }).similarityThreshold, 0)
})

test('a valid glossary parses into exactly the declared structure', () => {
  const glossary = parseGlossary(glossaryValue())
  assert.deepEqual(
    glossary.terms.map((term) => [term.term, term.index, [...term.aliases]]),
    [
      ['artifact', 0, ['build artifact']],
      ['charge', 1, []],
      ['token', 2, []],
    ],
  )
  assert.deepEqual(
    glossary.discouragedAliases.map((alias) => [alias.alias, alias.prefer, alias.index]),
    [
      ['artefact', 'artifact', 0],
      ['api key', 'token', 1],
    ],
  )
  assert.deepEqual(
    glossary.exceptions.map((exception) => [exception.term, exception.scope, exception.index]),
    [['charge', 'physics', 0]],
  )
  assert.deepEqual(glossary.scopes.map((scope) => [scope.id, [...scope.paths]]), [['physics', ['physics']]])
})

test('a glossary with no terms is refused: it can check nothing', () => {
  assert.throws(() => parseGlossary(glossaryValue({ terms: [] })), ConfigError)
})

test('an unknown glossary key is refused', () => {
  assert.throws(() => parseGlossary(glossaryValue({ termz: [] })), ConfigError)
})

test('a wrong schemaVersion is refused', () => {
  assert.throws(() => parseGlossary(glossaryValue({ schemaVersion: '2' })), ConfigError)
})

test('an exception without a reason is refused', () => {
  const value = glossaryValue()
  const { reason, ...withoutReason } = value.exceptions[0]
  assert.equal(typeof reason, 'string')
  assert.throws(() => parseGlossary(glossaryValue({ exceptions: [withoutReason] })), (error) => {
    assert.match(error.message, /exceptions\[0\]\.reason is required/u)
    return true
  })
})

test('an exception naming an undeclared scope or term is refused', () => {
  const base = glossaryValue().exceptions[0]
  assert.throws(() => parseGlossary(glossaryValue({ exceptions: [{ ...base, scope: 'chemistry' }] })), ConfigError)
  assert.throws(() => parseGlossary(glossaryValue({ exceptions: [{ ...base, term: 'quark' }] })), ConfigError)
})

test('two exceptions for the same term and scope are refused', () => {
  const base = glossaryValue().exceptions[0]
  assert.throws(() => parseGlossary(glossaryValue({ exceptions: [base, base] })), ConfigError)
})

test('a discouraged alias that is also an accepted surface form is refused', () => {
  assert.throws(
    () =>
      parseGlossary(
        glossaryValue({
          discouragedAliases: [{ alias: 'build artifact', prefer: 'token', reason: 'ambiguous' }],
        }),
      ),
    (error) => {
      assert.match(error.message, /also an accepted surface form of "artifact"/u)
      return true
    },
  )
})

test('a discouraged alias must prefer a declared term', () => {
  assert.throws(
    () => parseGlossary(glossaryValue({ discouragedAliases: [{ alias: 'widget', prefer: 'gadget' }] })),
    ConfigError,
  )
})

test('two terms may not share a surface form', () => {
  const terms = glossaryValue().terms.concat({ term: 'Artifact', definition: 'Something else entirely.' })
  assert.throws(() => parseGlossary(glossaryValue({ terms })), ConfigError)
  const caseSensitive = parseGlossary(glossaryValue({ terms }), { caseSensitive: true })
  assert.equal(caseSensitive.terms.length, 4)
})

test('the reserved default scope may not be declared', () => {
  assert.throws(() => parseGlossary(glossaryValue({ scopes: [{ id: 'default', paths: ['x'] }] })), ConfigError)
})

test('a scope path may not escape the root and may not be claimed twice', () => {
  assert.throws(() => parseGlossary(glossaryValue({ scopes: [{ id: 'a', paths: ['../outside'] }] })), ConfigError)
  assert.throws(() => parseGlossary(glossaryValue({ scopes: [{ id: 'a', paths: ['/etc'] }] })), ConfigError)
  assert.throws(
    () =>
      parseGlossary(
        glossaryValue({
          scopes: [
            { id: 'a', paths: ['shared/'] },
            { id: 'b', paths: ['shared'] },
          ],
          exceptions: [],
        }),
      ),
    (error) => {
      assert.match(error.message, /claimed by both "a" and "b"/u)
      return true
    },
  )
})

test('the maxTerms limit is enforced against the glossary', () => {
  const terms = [
    { term: 'a', definition: 'The first letter.' },
    { term: 'b', definition: 'The second letter.' },
  ]
  assert.throws(
    () => parseGlossary(glossaryValue({ terms, exceptions: [], discouragedAliases: [] }), { limits: { ...DEFAULT_LIMITS, maxTerms: 1 } }),
    (error) => {
      assert.match(error.message, /over the maxTerms limit of 1/u)
      return true
    },
  )
})

test('a scope claims a document by whole path segment, longest prefix first', () => {
  const scopes = [
    { id: 'physics', paths: ['docs/physics'], index: 0 },
    { id: 'optics', paths: ['docs/physics/optics'], index: 1 },
    { id: 'one-file', paths: ['docs/single.md'], index: 2 },
  ]
  assert.equal(scopeOf('docs/physics/notes.md', scopes), 'physics')
  assert.equal(scopeOf('docs/physics/optics/lenses.md', scopes), 'optics')
  assert.equal(scopeOf('docs/single.md', scopes), 'one-file')
  assert.equal(scopeOf('docs/physicsy/notes.md', scopes), 'default')
  assert.equal(scopeOf('guides/intro.md', scopes), 'default')
})

test('a glossary value is located at the line that carries its JSON encoding', () => {
  const text = ['{', '  "terms": [', '    { "term": "a", "definition": "First." },', '    { "term": "b", "definition": "Second." }', '  ]', '}'].join('\n')
  const found = locateLines(text, ['First.', 'Second.', 'Third.'])
  assert.equal(found.get('First.'), 3)
  assert.equal(found.get('Second.'), 4)
  assert.equal(found.has('Third.'), false)
})

test('a key folds case and collapses whitespace unless the policy says otherwise', () => {
  assert.equal(normalizeKey('  Build   Artifact ', false), 'build artifact')
  assert.equal(normalizeKey('  Build   Artifact ', true), 'Build Artifact')
})
