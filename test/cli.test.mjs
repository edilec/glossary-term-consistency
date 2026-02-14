import assert from 'node:assert/strict'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { ROOT, glossaryValue, makeTree, runCli } from './helpers.mjs'

const EXAMPLE_ARGS = ['--root', 'examples', '--glossary', 'examples/glossary.json', '--config', 'examples/policy.json']
const BROKEN_DOCS = [
  'broken/handbook.md',
  'broken/billing/invoices.md',
  'broken/reference/api.md',
  'broken/physics/notes.md',
]

async function exampleGlossaryLine(fragment) {
  const text = await readFile(join(ROOT, 'examples', 'glossary.json'), 'utf8')
  const index = text.split('\n').findIndex((line) => line.includes(JSON.stringify(fragment)))
  assert.notEqual(index, -1, `expected examples/glossary.json to contain ${fragment}`)
  return index + 1
}

/** A temporary corpus with its own glossary, for the cases the examples cannot show. */
async function temporaryCorpus(extra = {}) {
  return makeTree({
    'glossary.json': JSON.stringify(glossaryValue({ scopes: [], exceptions: [] }), null, 2),
    'policy.json': JSON.stringify({ schemaVersion: '1' }),
    'a.md': '**token**: A short-lived credential that authorises an API request.\n',
    ...extra,
  })
}

test('--help prints usage on stdout and exits 0', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage:\n {2}glossary-term-consistency --glossary FILE/u)
  assert.equal(result.stderr, '')
})

test('the clean example passes with no findings at all', () => {
  const result = runCli([...EXAMPLE_ARGS, '--json', 'clean/handbook.md', 'clean/physics/notes.md'])
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.summary, {
    checked: 2,
    errors: 0,
    warnings: 0,
    info: 0,
    documents: 2,
    terms: 3,
    definitions: 4,
    aliasHits: 0,
  })
})

test('the broken example fails with both evidence locations on the conflict', async () => {
  const result = runCli([...EXAMPLE_ARGS, '--json', ...BROKEN_DOCS])
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'glossary-term-consistency')
  assert.equal(report.status, 'fail')

  assert.deepEqual(
    report.findings.map((finding) => [
      finding.ruleId,
      finding.severity,
      `${finding.location.file}:${finding.line}:${finding.column}`,
      `${finding.related.location.file}:${finding.related.line ?? ''}`,
      finding.related.location.pointer,
    ]),
    [
      [
        'discouraged-alias-used',
        'error',
        'broken/billing/invoices.md:5:7',
        `examples/glossary.json:${await exampleGlossaryLine('artefact')}`,
        '/discouragedAliases/0/alias',
      ],
      [
        'definition-conflict',
        'error',
        'broken/reference/api.md:3:1',
        'broken/handbook.md:6',
        '/lines/6',
      ],
      [
        'definition-off-glossary',
        'error',
        'broken/reference/api.md:3:1',
        `examples/glossary.json:${await exampleGlossaryLine('A short-lived credential that authorises an API request.')}`,
        '/terms/2/definition',
      ],
      [
        'discouraged-alias-used',
        'error',
        'broken/reference/api.md:5:12',
        `examples/glossary.json:${await exampleGlossaryLine('api key')}`,
        '/discouragedAliases/1/alias',
      ],
    ],
  )

  // The scoped physics sense of "charge" is in this run too, and is not reported.
  assert.equal(report.summary.checked, 4)
  assert.equal(
    report.findings.some((finding) => finding.location.file === 'broken/physics/notes.md'),
    false,
  )
})

test('the human summary names both places of a conflict', () => {
  const result = runCli([...EXAMPLE_ARGS, ...BROKEN_DOCS])
  assert.equal(result.status, 1)
  assert.match(
    result.stdout,
    /broken\/reference\/api\.md:3:1 {2}error {2}definition-conflict[^\n]*\n {4}also at broken\/handbook\.md:6 \/lines\/6\n/u,
  )
})

test('two identical runs produce byte-identical stdout', () => {
  const first = runCli([...EXAMPLE_ARGS, '--json', ...BROKEN_DOCS])
  const second = runCli([...EXAMPLE_ARGS, '--json', ...BROKEN_DOCS])
  assert.equal(first.status, second.status)
  assert.equal(first.stdout, second.stdout)
  assert.ok(first.stdout.length > 0)
})

test('an unknown option writes nothing to stdout and exits 2', () => {
  const result = runCli([...EXAMPLE_ARGS, '--strict', 'clean/handbook.md'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--strict"/u)
})

test('a missing --glossary is a usage error with no report', () => {
  const result = runCli(['--root', 'examples', 'clean/handbook.md'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--glossary is required/u)
})

test('a mistyped configuration key is refused rather than ignored', async () => {
  const root = await temporaryCorpus({ 'policy.json': JSON.stringify({ schemaVersion: '1', caseSensitve: true }) })
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', '--config', 'policy.json', 'a.md'], { cwd: root })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown configuration key "caseSensitve"/u)
})

test('a glossary with no terms is refused before anything is checked, never a vacuous pass', async () => {
  const root = await temporaryCorpus({ 'glossary.json': JSON.stringify({ schemaVersion: '1', terms: [] }) })
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', '--json', 'a.md'], { cwd: root })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Glossary terms must be a non-empty array/u)
})

test('an unreadable glossary is a configuration error with no report', () => {
  const result = runCli(['--root', 'examples', '--glossary', 'examples/nope.json', 'clean/handbook.md'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Could not read the glossary/u)
})

test('an absolute corpus path is refused before anything is read', async () => {
  const root = await temporaryCorpus()
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', join(root, 'a.md')], { cwd: root })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /must be relative to the root/u)
})

test('an input that could not be read is an incomplete report on stdout, exit 2', async () => {
  const root = await temporaryCorpus()
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', 'a.md', 'gone.md'], { cwd: root })
  assert.equal(result.status, 2)
  const report = JSON.parse(runCli(['--root', '.', '--glossary', 'glossary.json', '--json', 'a.md', 'gone.md'], { cwd: root }).stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.file]),
    [['input-unreadable', 'gone.md']],
  )
  assert.equal(report.summary.checked, 1)
  assert.match(result.stderr, /skipped: gone\.md/u)
})

test('a symlink out of the root is refused and no out-of-root content reaches the report', async () => {
  const outside = await makeTree({ 'secret.md': '**token**: OUTSIDE-OF-ROOT-CONTENT must never be echoed.\n' })
  const root = await temporaryCorpus()
  await symlink(join(outside, 'secret.md'), join(root, 'escape.md'))
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', '--json', 'a.md', 'escape.md'], { cwd: root })
  assert.equal(result.status, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.file]),
    [['path-outside-root', 'escape.md']],
  )
  assert.equal(result.stdout.includes('OUTSIDE-OF-ROOT-CONTENT'), false)
  assert.equal(JSON.stringify(report).includes('OUTSIDE-OF-ROOT-CONTENT'), false)
  assert.equal(report.summary.checked, 1)
})

test('a symlink to a directory out of the root is refused the same way', async () => {
  const outside = await makeTree({ 'notes/secret.md': '**token**: OUTSIDE-OF-ROOT-CONTENT must never be echoed.\n' })
  const root = await temporaryCorpus()
  await symlink(join(outside, 'notes'), join(root, 'linked'))
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', '--json', 'linked/secret.md'], { cwd: root })
  assert.equal(result.status, 2)
  assert.equal(result.stdout.includes('OUTSIDE-OF-ROOT-CONTENT'), false)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId).sort(),
    ['no-documents-checked', 'path-outside-root'],
  )
})

test('the command line really wires the clock through: timeLimitMs 0 stops the run', async () => {
  const root = await temporaryCorpus({
    'policy.json': JSON.stringify({ schemaVersion: '1', limits: { timeLimitMs: 0 } }),
  })
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', '--config', 'policy.json', '--json', 'a.md'], {
    cwd: root,
  })
  assert.equal(result.status, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const limit = report.findings.find((finding) => finding.ruleId === 'limit-exceeded')
  assert.match(limit.message, /timeLimitMs budget of 0ms/u)
})

test('bytes that are not UTF-8 are incomplete, never a pass, even beside a literal U+FFFD', async () => {
  const root = await temporaryCorpus({
    'good.md': '**token**: A short-lived credential that authorises an API request. �\n',
  })
  await writeFile(join(root, 'bad.md'), Buffer.from([0x2a, 0x2a, 0xfe, 0xfe, 0x0a]))
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', '--json', 'good.md', 'bad.md'], { cwd: root })
  assert.equal(result.status, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.file]),
    [['input-not-utf8', 'bad.md']],
  )
  assert.equal(report.summary.checked, 1)
})

test('an absolute --glossary is reported by its basename, never as a host path', async () => {
  const root = await temporaryCorpus({
    'b.md': '**token**: A plastic disc used in an arcade near the pier.\n',
  })
  const result = runCli(['--root', '.', '--glossary', join(root, 'glossary.json'), '--json', 'a.md', 'b.md'], {
    cwd: root,
  })
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  const offGlossary = report.findings.find((finding) => finding.ruleId === 'definition-off-glossary')
  assert.equal(offGlossary.related.location.file, 'glossary.json')
  assert.equal(result.stdout.includes(root), false)
})

/**
 * A glossary and a policy are configuration files, and configuration files
 * carry credentials often enough that neither may ever be echoed. The
 * parse-failure path is where that used to break.
 *
 * V8 reports a JSON parse failure two ways, and one of them quotes the input
 * back: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A
 * file short enough to be nothing but a credential was reproduced in full by
 * its own error message on stderr. Escaping could not repair it -- `evidenceOf`
 * cuts from the end, and the quoted snippet is at the front.
 *
 * The canaries are published placeholders, never real credentials: the example
 * key from the AWS documentation, the standard test card number that
 * authorises nothing (with a leading letter, because the bare digits are a
 * valid JSON number), and a host under the RFC 2606 `.invalid` reserved
 * top-level domain. Every prefix from eight characters up is scanned on both
 * streams: a check of the whole value alone passes for output that leaks all
 * but the last character.
 */
const CANARIES = Object.freeze({
  'AWS example access key id': 'AKIAIOSFODNN7EXAMPLE',
  'standard test card number': 'x4111111111111111',
  'reserved example host': 'api.example.invalid',
  'bearer-looking token': 'Bearer-ZXhhbXBsZS10b2tlbg',
})

const MIN_PREFIX = 8

test('an unparseable glossary or policy is not quoted back by its own parse error', async () => {
  for (const [name, canary] of Object.entries(CANARIES)) {
    for (const broken of ['glossary.json', 'policy.json']) {
      const root = await makeTree({
        'glossary.json': JSON.stringify(glossaryValue({ scopes: [], exceptions: [] }), null, 2),
        'policy.json': JSON.stringify({ schemaVersion: '1' }),
        'a.md': '**token**: A short-lived credential that authorises an API request.\n',
        [broken]: canary,
      })
      const result = runCli(
        ['--root', '.', '--glossary', 'glossary.json', '--config', 'policy.json', '--json', 'a.md'],
        { cwd: root },
      )

      assert.equal(result.status, 2, `${broken} must really have failed to parse`)
      assert.match(result.stderr, /is not valid JSON/u)

      for (let length = MIN_PREFIX; length <= canary.length; length += 1) {
        const prefix = canary.slice(0, length)
        assert.equal(result.stdout.includes(prefix), false, `${name} in ${broken}: "${prefix}" reached stdout`)
        assert.equal(result.stderr.includes(prefix), false, `${name} in ${broken}: "${prefix}" reached stderr`)
      }
    }
  }
})

/**
 * The other half of the fix: a diagnostic that says nothing is a different
 * defect. A glossary missing one comma reports a position, a line and a column
 * rather than a quotation, and that is what a reader needs to find the spot.
 */
test('a parse failure still says where the glossary went wrong', async () => {
  const root = await makeTree({
    'glossary.json': '{\n  "schemaVersion": "1"\n  "terms": []\n}\n',
    'a.md': '**token**: A short-lived credential that authorises an API request.\n',
  })
  const result = runCli(['--root', '.', '--glossary', 'glossary.json', '--json', 'a.md'], { cwd: root })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /position \d+/u)
  assert.match(result.stderr, /line \d+ column \d+/u)
})
