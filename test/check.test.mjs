import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  DEFAULT_LIMITS,
  RULES,
  byCodeUnit,
  checkCorpus,
  exitCodeFor,
  makeFinding,
  parseGlossary,
  parsePolicy,
  severityOf,
} from '../src/index.mjs'
import { doc, glossaryValue, steppingClock } from './helpers.mjs'

const GLOSSARY_FILE = 'glossary.json'
const glossaryText = JSON.stringify(glossaryValue(), null, 2)
const NO_EXCEPTIONS = glossaryValue({ exceptions: [] })

function lineOfInGlossary(fragment) {
  const index = glossaryText.split('\n').findIndex((line) => line.includes(fragment))
  assert.notEqual(index, -1, `expected the test glossary to contain ${fragment}`)
  return index + 1
}

function run({ documents = [], failures = [], glossary = glossaryValue(), policy = {}, clock = null } = {}) {
  const parsedPolicy = parsePolicy(policy)
  return checkCorpus({
    glossary: parseGlossary(glossary, { caseSensitive: parsedPolicy.caseSensitive, limits: parsedPolicy.limits }),
    glossaryFile: GLOSSARY_FILE,
    glossaryText: JSON.stringify(glossary, null, 2),
    documents,
    failures,
    policy: parsedPolicy,
    clock,
  })
}

const HANDBOOK = doc(
  'handbook.md',
  [
    '- **charge**: An amount of money billed to a customer account.',
    '- **token**: A short-lived credential that authorises an API request.',
  ].join('\n'),
)
const PHYSICS = doc(
  'physics/notes.md',
  '**charge** — A property of matter that causes it to experience a force in an electromagnetic field.',
)
const API = doc('reference/api.md', '**token**: A permanent shared secret that anyone on the team may reuse.')

test('severity is pinned: every rule keeps exactly the severity the catalog declares', () => {
  assert.deepEqual({ ...RULES }, {
    'definition-conflict': 'error',
    'definition-off-glossary': 'error',
    'definition-paraphrased': 'info',
    'discouraged-alias-used': 'error',
    'exception-unused': 'warning',
    'no-definitions-found': 'warning',
    'no-documents-checked': 'warning',
    'input-unreadable': 'error',
    'input-not-utf8': 'error',
    'path-outside-root': 'error',
    'limit-exceeded': 'error',
  })
  assert.equal(Object.isFrozen(RULES), true)
})

test('the rule table and the documented catalog agree in both directions', async () => {
  const text = await readFile(new URL('../docs/glossary-rules.md', import.meta.url), 'utf8')
  const documented = new Map()
  for (const line of text.split('\n')) {
    const match = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|\s*(error|warning|info)\s*\|/u.exec(line)
    if (match !== null) documented.set(match[1], match[2])
  }
  const sorted = (entries) => [...entries].sort((left, right) => byCodeUnit(left[0], right[0]))
  assert.equal(documented.size, Object.keys(RULES).length)
  assert.deepEqual(sorted(documented.entries()), sorted(Object.entries(RULES)))
})

test('an unknown rule id throws instead of defaulting to a severity', () => {
  assert.throws(() => severityOf('definition-conflicts'), /Unknown ruleId "definition-conflicts"/u)
  assert.throws(() => makeFinding('made-up-rule', 'message'), /Unknown ruleId "made-up-rule"/u)
  assert.equal(severityOf('definition-conflict'), 'error')
})

test('a real conflict is reported with both places, and a scoped sense is not a conflict', () => {
  const report = run({ documents: [HANDBOOK, PHYSICS, API] })

  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.deepEqual(report.summary, {
    checked: 3,
    errors: 2,
    warnings: 0,
    info: 0,
    documents: 3,
    terms: 3,
    definitions: 4,
    aliasHits: 0,
  })

  assert.deepEqual(
    report.findings.map((finding) => [
      finding.ruleId,
      finding.location.file,
      finding.line,
      finding.column,
      finding.related.location.file,
      finding.related.location.pointer,
      finding.related.line,
    ]),
    [
      ['definition-conflict', 'reference/api.md', 1, 1, 'handbook.md', '/lines/2', 2],
      [
        'definition-off-glossary',
        'reference/api.md',
        1,
        1,
        GLOSSARY_FILE,
        '/terms/2/definition',
        lineOfInGlossary('A short-lived credential'),
      ],
    ],
  )

  const conflict = report.findings[0]
  assert.equal(conflict.evidence, '**token**: A permanent shared secret that anyone on the team may reuse.')
  assert.equal(
    conflict.related.evidence,
    '- **token**: A short-lived credential that authorises an API request.',
  )
  assert.match(conflict.message, /contradict its first definition at handbook\.md:2/u)

  // The physics sense of "charge" is declared with a reason, so it is a
  // separate sense and nothing about it is reported.
  assert.deepEqual(report.findings.filter((finding) => finding.location.file === 'physics/notes.md'), [])
})

test('without the exception the same physics definition is reported, so the exception is what suppresses it', () => {
  const report = run({ documents: [HANDBOOK, PHYSICS, API], glossary: glossaryValue({ exceptions: [] }) })
  assert.deepEqual(
    report.findings
      .filter((finding) => finding.location.file === 'physics/notes.md')
      .map((finding) => [finding.ruleId, finding.line, finding.related.location.file, finding.related.line]),
    [
      ['definition-conflict', 1, 'handbook.md', 1],
      ['definition-off-glossary', 1, GLOSSARY_FILE, lineOfInGlossary('An amount of money')],
    ],
  )
})

test('a restatement above the threshold is info, and lowering the threshold makes it agree', () => {
  const documents = [
    doc('a.md', '**artifact**: A file produced by a build and stored for later use.'),
    doc('b.md', '**artifact**: A file produced by a build and stored for later reuse.'),
  ]
  const report = run({ documents, glossary: NO_EXCEPTIONS })
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.severity, finding.location.file, finding.line]),
    [['definition-paraphrased', 'info', 'b.md', 1]],
  )
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)

  const strict = run({ documents, glossary: NO_EXCEPTIONS, policy: { similarityThreshold: 1 } })
  assert.deepEqual(
    strict.findings.map((finding) => [finding.ruleId, finding.location.file]),
    [
      ['definition-conflict', 'b.md'],
      ['definition-off-glossary', 'b.md'],
    ],
  )
  assert.equal(strict.status, 'fail')
})

test('a discouraged alias is reported with the glossary entry that discourages it', () => {
  const report = run({
    documents: [HANDBOOK, doc('guide.md', 'Attach the artefact to the release.')],
    glossary: NO_EXCEPTIONS,
  })
  assert.deepEqual(
    report.findings.map((finding) => [
      finding.ruleId,
      finding.location.file,
      finding.line,
      finding.column,
      finding.related.location.pointer,
      finding.suggestion,
    ]),
    [
      [
        'discouraged-alias-used',
        'guide.md',
        1,
        12,
        '/discouragedAliases/0/alias',
        'Use "artifact" instead. The handbook uses the US spelling.',
      ],
    ],
  )
  assert.equal(report.summary.aliasHits, 1)
})

test('a run that read no document is incomplete, never a pass', () => {
  // The finding is a warning, so the incomplete flag is the only thing keeping
  // this run from reporting pass and exit 0. Deleting that assignment fails
  // here rather than turning an empty run green.
  const report = run({ documents: [], glossary: NO_EXCEPTIONS })
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.severity, finding.location]),
    [['no-documents-checked', 'warning', {}]],
  )
})

test('an input failure makes the report incomplete even when other documents were fine', () => {
  const report = run({
    documents: [HANDBOOK],
    glossary: NO_EXCEPTIONS,
    failures: [{ ruleId: 'input-unreadable', file: 'gone.md', message: 'input could not be resolved (ENOENT)' }],
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.file]),
    [['input-unreadable', 'gone.md']],
  )
  assert.equal(report.summary.checked, 1)
})

test('documents with no definition at all are a pass that says so', () => {
  const report = run({ documents: [doc('a.md', 'Prose with no definition line in it.')], glossary: NO_EXCEPTIONS })
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.equal(report.summary.definitions, 0)
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.severity]),
    [['no-definitions-found', 'warning']],
  )
})

test('an exception that no document exercises is reported as stale', () => {
  const report = run({ documents: [HANDBOOK] })
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.file, finding.location.pointer]),
    [['exception-unused', GLOSSARY_FILE, '/exceptions/0']],
  )
  assert.equal(report.status, 'pass')
})

test('the maxOccurrencesPerTerm limit stops that term being compared and marks the run incomplete', () => {
  const documents = [
    doc('a.md', '**token**: A short-lived credential that authorises an API request.'),
    doc('b.md', '**token**: A permanent shared secret that anyone may reuse.'),
    doc('c.md', '**token**: A plastic disc used in an arcade.'),
  ]
  const loose = run({ documents, glossary: NO_EXCEPTIONS })
  assert.equal(
    loose.findings.filter((finding) => finding.ruleId === 'definition-conflict').length,
    2,
    'the same corpus must produce conflicts when the limit is not reached',
  )

  const report = run({ documents, glossary: NO_EXCEPTIONS, policy: { limits: { maxOccurrencesPerTerm: 2 } } })
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.pointer]),
    [['limit-exceeded', '/terms/2']],
  )
  assert.match(report.findings[0].message, /over the maxOccurrencesPerTerm limit of 2/u)
})

test('the maxFindings limit reports what it dropped instead of truncating silently', () => {
  const documents = [
    doc('a.md', '**token**: A short-lived credential that authorises an API request.'),
    doc('b.md', '**token**: A permanent shared secret that anyone may reuse.'),
    doc('c.md', '**token**: A plastic disc used in an arcade.'),
    doc('d.md', '**token**: A gesture of appreciation, given freely.'),
  ]
  const full = run({ documents, glossary: NO_EXCEPTIONS })
  assert.equal(full.status, 'fail')
  const total = full.findings.length
  assert.ok(total > 2, 'the fixture must produce more findings than the limit under test')

  const report = run({ documents, glossary: NO_EXCEPTIONS, policy: { limits: { maxFindings: 2 } } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.length, 3)
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    [...full.findings.slice(0, 2).map((finding) => finding.ruleId), 'limit-exceeded'],
  )
  assert.match(report.findings[2].message, new RegExp(`${total - 2} were not reported`, 'u'))
})

test('the timeLimitMs budget is enforced against the injected clock', () => {
  const documents = [HANDBOOK, API]
  const generous = run({
    documents,
    glossary: NO_EXCEPTIONS,
    policy: { limits: { timeLimitMs: 1_000 } },
    clock: steppingClock(1),
  })
  assert.equal(generous.summary.checked, 2)
  assert.equal(generous.findings.some((finding) => finding.ruleId === 'limit-exceeded'), false)

  const report = run({
    documents,
    glossary: NO_EXCEPTIONS,
    policy: { limits: { timeLimitMs: 5 } },
    clock: steppingClock(10),
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['limit-exceeded'],
  )
  assert.match(report.findings[0].message, /timeLimitMs budget of 5ms with 0 of 2 documents scanned/u)
})

test('findings are ordered by file, line, column, rule and then the related place', () => {
  const report = run({
    documents: [
      doc('z.md', 'Use an artefact here.'),
      doc('a.md', 'line one\nartefact and api key here.'),
      HANDBOOK,
    ],
    failures: [{ ruleId: 'limit-exceeded', file: null, message: 'a run-level failure' }],
  })
  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file ?? null, finding.line, finding.column, finding.ruleId]),
    [
      ['a.md', 2, 1, 'discouraged-alias-used'],
      ['a.md', 2, 14, 'discouraged-alias-used'],
      [GLOSSARY_FILE, lineOfInGlossary('A property of matter'), null, 'exception-unused'],
      ['z.md', 1, 8, 'discouraged-alias-used'],
      [null, null, null, 'limit-exceeded'],
    ],
  )
})

test('the report does not depend on the order the documents were given in', () => {
  const forwards = run({ documents: [HANDBOOK, PHYSICS, API] })
  const backwards = run({ documents: [API, PHYSICS, HANDBOOK] })
  assert.equal(JSON.stringify(forwards), JSON.stringify(backwards))
  assert.equal(JSON.stringify(run({ documents: [HANDBOOK, PHYSICS, API] })), JSON.stringify(forwards))
})

test('caseSensitive changes which labels are recognised as the term', () => {
  const documents = [doc('a.md', '**Token**: A completely different meaning of the word.')]
  const insensitive = run({ documents })
  assert.deepEqual(
    insensitive.findings.map((finding) => finding.ruleId),
    ['definition-off-glossary', 'exception-unused'],
  )

  const sensitive = run({ documents, policy: { caseSensitive: true } })
  assert.deepEqual(
    sensitive.findings.map((finding) => finding.ruleId),
    ['exception-unused', 'no-definitions-found'],
  )
})

test('the default limits are the ones the library exports', () => {
  const policy = parsePolicy()
  assert.deepEqual({ ...policy.limits }, { ...DEFAULT_LIMITS })
})

test('evidence is bounded and control characters are escaped, never echoed raw', () => {
  const separator = String.fromCodePoint(0x2028)
  const bell = String.fromCodePoint(0x07)
  const report = run({
    documents: [doc('a.md', `**token**: ${'a'.repeat(200)}${separator} tail${bell}`)],
    glossary: NO_EXCEPTIONS,
  })
  const finding = report.findings.find((entry) => entry.ruleId === 'definition-off-glossary')
  assert.equal(Array.from(finding.evidence).length, 146, 'the bounded excerpt plus the " [...]" marker')
  assert.ok(finding.evidence.endsWith(' [...]'))
  assert.equal(finding.evidence.includes(separator), false)
  assert.equal(finding.evidence.includes(bell), false)
})

test('a control character inside the excerpt becomes escape text', () => {
  const separator = String.fromCodePoint(0x2028)
  const report = run({
    documents: [doc('a.md', `**token**: one${separator}two three four five six seven`)],
    glossary: NO_EXCEPTIONS,
  })
  const finding = report.findings.find((entry) => entry.ruleId === 'definition-off-glossary')
  assert.equal(finding.evidence, '**token**: one\\u2028two three four five six seven')
})
