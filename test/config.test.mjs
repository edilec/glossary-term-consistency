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
  // This guard is the only thing between a zero-term glossary and a vacuous
  // green run, so the assertion names this error: asserting ConfigError alone
  // would also be satisfied by the dangling references the fixture leaves
  // behind when its terms are emptied.
  assert.throws(
    () => parseGlossary({ schemaVersion: '1', terms: [] }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /Glossary terms must be a non-empty array/u)
      return true
    },
  )
  assert.throws(
    () => parseGlossary(glossaryValue({ terms: [], discouragedAliases: [], exceptions: [] })),
    /Glossary terms must be a non-empty array/u,
  )
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
  assert.throws(
    () => parseGlossary(glossaryValue({ scopes: [{ id: 'default', paths: ['x'] }], exceptions: [] })),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /scopes\[0\]\.id "default" is reserved/u)
      return true
    },
  )
})

test('a scope path may not escape the root and may not be claimed twice', () => {
  assert.throws(
    () => parseGlossary(glossaryValue({ scopes: [{ id: 'a', paths: ['../outside'] }], exceptions: [] })),
    /scopes\[0\]\.paths\[0\] must not contain a "\.\." segment/u,
  )
  assert.throws(
    () => parseGlossary(glossaryValue({ scopes: [{ id: 'a', paths: ['/etc'] }], exceptions: [] })),
    /scopes\[0\]\.paths\[0\] must be a relative path inside the root/u,
  )
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

test('a scope id must be unique and must match the documented shape', () => {
  assert.throws(
    () =>
      parseGlossary(
        glossaryValue({
          scopes: [
            { id: 'a', paths: ['one'] },
            { id: 'a', paths: ['two'] },
          ],
          exceptions: [],
        }),
      ),
    /Duplicate scope id "a"/u,
  )
  assert.throws(
    () => parseGlossary(glossaryValue({ scopes: [{ id: 'Physics', paths: ['physics'] }], exceptions: [] })),
    /scopes\[0\]\.id must match/u,
  )
  assert.throws(
    () => parseGlossary(glossaryValue({ scopes: [{ id: '-lead', paths: ['physics'] }], exceptions: [] })),
    /scopes\[0\]\.id must match/u,
  )
  // And the shape that is documented is accepted: an over-strict id is a
  // refusal of a legitimate glossary.
  const accepted = parseGlossary(glossaryValue({ scopes: [{ id: 'x-9', paths: ['physics'] }], exceptions: [] }))
  assert.deepEqual(accepted.scopes.map((scope) => scope.id), ['x-9'])
})

test('the same discouraged alias may not be declared twice under one key', () => {
  assert.throws(
    () =>
      parseGlossary(
        glossaryValue({
          discouragedAliases: [
            { alias: 'artefact', prefer: 'artifact' },
            { alias: 'Artefact', prefer: 'artifact' },
          ],
        }),
      ),
    /Duplicate discouraged alias "Artefact"/u,
  )
  // Under a case-sensitive policy the two spellings are different keys, so
  // both are kept rather than refused.
  const sensitive = parseGlossary(
    glossaryValue({
      discouragedAliases: [
        { alias: 'artefact', prefer: 'artifact' },
        { alias: 'Artefact', prefer: 'artifact' },
      ],
    }),
    { caseSensitive: true },
  )
  assert.deepEqual(sensitive.discouragedAliases.map((entry) => entry.alias), ['artefact', 'Artefact'])
})

test('a configured string may be neither blank nor longer than its documented maximum', () => {
  const only = (term) => glossaryValue({ terms: [term], discouragedAliases: [], exceptions: [] })
  assert.throws(() => parseGlossary(only({ term: '   ', definition: 'A definition.' })), /terms\[0\]\.term must not be empty/u)
  assert.throws(() => parseGlossary(only({ term: 'artifact', definition: ' ' })), /terms\[0\]\.definition must not be empty/u)
  assert.throws(
    () => parseGlossary(only({ term: 'a'.repeat(121), definition: 'A definition.' })),
    /terms\[0\]\.term must be at most 120 characters/u,
  )
  // The maximum itself is accepted, and a padded value is stored trimmed.
  const accepted = parseGlossary(only({ term: `  ${'a'.repeat(120)}  `, definition: 'A definition.' }))
  assert.equal(accepted.terms[0].term, 'a'.repeat(120))
})

test('the policy schemaVersion and caseSensitive type are checked, not coerced', () => {
  assert.throws(() => parsePolicy({ schemaVersion: '2' }), /Policy schemaVersion must be "1"/u)
  assert.throws(() => parsePolicy({ schemaVersion: 1 }), /Policy schemaVersion must be "1"/u)
  assert.equal(parsePolicy({ schemaVersion: '1' }).schemaVersion, '1')

  // "caseSensitive": "yes" must be refused rather than read as false, which
  // would silently run the check in the opposite mode to the one asked for.
  assert.throws(() => parsePolicy({ caseSensitive: 'yes' }), /Policy caseSensitive must be a boolean/u)
  assert.throws(() => parsePolicy({ caseSensitive: 1 }), /Policy caseSensitive must be a boolean/u)
  assert.equal(parsePolicy({ caseSensitive: true }).caseSensitive, true)
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

test('an unknown key inside a term, a scope, an alias or an exception is refused', () => {
  const base = glossaryValue()
  assert.throws(
    () => parseGlossary(glossaryValue({ terms: [{ ...base.terms[0], defintion: 'typo' }] })),
    /Unknown configuration key "defintion" in terms\[0\]/u,
  )
  assert.throws(
    () => parseGlossary(glossaryValue({ scopes: [{ id: 'physics', paths: ['physics'], recursive: true }] })),
    /Unknown configuration key "recursive" in scopes\[0\]/u,
  )
  assert.throws(
    () =>
      parseGlossary(
        glossaryValue({ discouragedAliases: [{ alias: 'artefact', prefer: 'artifact', why: 'typo' }] }),
      ),
    /Unknown configuration key "why" in discouragedAliases\[0\]/u,
  )
  assert.throws(
    () => parseGlossary(glossaryValue({ exceptions: [{ ...base.exceptions[0], severity: 'warning' }] })),
    /Unknown configuration key "severity" in exceptions\[0\]/u,
  )
})
