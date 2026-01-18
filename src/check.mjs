/**
 * The check itself: compare every definition found in the corpus against the
 * canonical glossary, against the scoped exception that governs it, and against
 * the other definitions of the same sense.
 *
 * A conflict is always reported with both places that disagree. A finding that
 * says "this term is defined inconsistently somewhere" is not worth reading;
 * the point of the tool is the pair of lines an editor has to reconcile.
 *
 * Every path that sets `status` is here, and only one of them can produce
 * `pass`: a run that read documents, found definitions and raised no error.
 */

import {
  REPORT_SCHEMA_VERSION,
  TOOL_ID,
  byCodeUnit,
  makeFinding,
  relatedLocation,
} from './rules.mjs'
import { DEFAULT_SCOPE, normalizeKey, parsePolicy, scopeOf, locateLines } from './config.mjs'
import {
  extractDefinitions,
  findAliasHits,
  maskCode,
  normalizeDefinition,
  similarity,
} from './scan.mjs'

const CANONICAL_SENSE = 'canonical'

function pairKey(term, scope) {
  return `${term} in ${scope}`
}

function overlap(value) {
  return value.toFixed(2)
}

/** The default scope is reserved, so it cannot be the subject of an exception. */
function scopeAdvice(scope) {
  return scope === DEFAULT_SCOPE
    ? 'declare a scope for these documents and an exception for it'
    : `declare an exception for scope "${scope}"`
}

/** A total order: file, line, column, rule id, pointer, then the related place. */
export function compareFindings(left, right) {
  const leftFile = left.location.file ?? null
  const rightFile = right.location.file ?? null
  if (leftFile === null && rightFile !== null) return 1
  if (rightFile === null && leftFile !== null) return -1
  if (leftFile !== null && rightFile !== null && leftFile !== rightFile) return byCodeUnit(leftFile, rightFile)
  const leftLine = left.line ?? 0
  const rightLine = right.line ?? 0
  if (leftLine !== rightLine) return leftLine < rightLine ? -1 : 1
  const leftColumn = left.column ?? 0
  const rightColumn = right.column ?? 0
  if (leftColumn !== rightColumn) return leftColumn < rightColumn ? -1 : 1
  if (left.ruleId !== right.ruleId) return byCodeUnit(left.ruleId, right.ruleId)
  const leftPointer = left.location.pointer ?? ''
  const rightPointer = right.location.pointer ?? ''
  if (leftPointer !== rightPointer) return byCodeUnit(leftPointer, rightPointer)
  return byCodeUnit(relatedKey(left), relatedKey(right))
}

function relatedKey(finding) {
  const related = finding.related
  if (related === undefined) return ''
  return `${related.location.file ?? ''}:${String(related.line ?? 0).padStart(9, '0')}:${related.location.pointer ?? ''}`
}

/**
 * Run the check.
 *
 * `documents` and `failures` come from `readCorpus`. `clock` is injected: the
 * library never reads a wall clock of its own, so the same inputs always
 * produce the same report.
 */
export function checkCorpus({
  glossary,
  glossaryFile,
  glossaryText = '',
  documents = [],
  failures = [],
  policy = parsePolicy(),
  clock = null,
}) {
  const { caseSensitive, similarityThreshold, limits } = policy
  const findings = []
  let incomplete = false

  for (const failure of failures) {
    incomplete = true
    findings.push(
      makeFinding(failure.ruleId, failure.message, {
        file: failure.file,
        pointer: failure.file === null ? null : '/',
      }),
    )
  }

  if (documents.length === 0) {
    incomplete = true
    findings.push(
      makeFinding('no-documents-checked', 'no corpus document was read, so nothing was compared against the glossary', {
        suggestion: 'Name at least one readable document relative to the root.',
      }),
    )
  }

  const keyToTerm = new Map()
  for (const entry of glossary.terms) {
    for (const surface of [entry.term, ...entry.aliases]) {
      keyToTerm.set(normalizeKey(surface, caseSensitive), entry.term)
    }
  }
  const keyOf = (label) => keyToTerm.get(normalizeKey(label, caseSensitive))
  const termByName = new Map(glossary.terms.map((entry) => [entry.term, entry]))
  const exceptionByPair = new Map(glossary.exceptions.map((entry) => [pairKey(entry.term, entry.scope), entry]))

  const glossaryLines = locateLines(
    glossaryText,
    [
      ...glossary.terms.map((entry) => entry.definition),
      ...glossary.exceptions.map((entry) => entry.definition),
      ...glossary.discouragedAliases.map((entry) => entry.alias),
    ],
    limits.maxLines,
  )
  const lineOf = (value) => glossaryLines.get(value) ?? null

  const occurrences = new Map(glossary.terms.map((entry) => [entry.term, []]))
  const aliasCount = new Map(glossary.terms.map((entry) => [entry.term, 0]))
  const aliasFindings = []
  const started = clock === null ? 0 : clock()
  const outOfTime = () => clock !== null && clock() - started >= limits.timeLimitMs

  let scanned = 0
  let definitionCount = 0
  let aliasHitCount = 0

  for (const document of documents) {
    if (outOfTime()) {
      incomplete = true
      findings.push(
        makeFinding(
          'limit-exceeded',
          `checking stopped at the timeLimitMs budget of ${limits.timeLimitMs}ms with ${scanned} of ${documents.length} documents scanned`,
          { suggestion: 'Raise limits.timeLimitMs, or check fewer documents in one run.' },
        ),
      )
      break
    }
    const masked = maskCode(document.lines)
    const scope = scopeOf(document.file, glossary.scopes)
    for (const definition of extractDefinitions(document.lines, masked, keyOf)) {
      const exception = exceptionByPair.get(pairKey(definition.term, scope))
      occurrences.get(definition.term).push({
        ...definition,
        file: document.file,
        scope,
        senseKey: exception === undefined ? CANONICAL_SENSE : `scope:${scope}`,
      })
      definitionCount += 1
    }
    for (const hit of findAliasHits(document.lines, masked, glossary.discouragedAliases, caseSensitive)) {
      aliasHitCount += 1
      aliasCount.set(hit.alias.prefer, aliasCount.get(hit.alias.prefer) + 1)
      const because = hit.alias.reason === null ? '' : ` ${hit.alias.reason}`
      aliasFindings.push(
        makeFinding(
          'discouraged-alias-used',
          `"${hit.alias.alias}" is a discouraged alias of "${hit.alias.prefer}"`,
          {
            file: document.file,
            pointer: `/lines/${hit.line}`,
            line: hit.line,
            column: hit.column,
            evidence: hit.raw,
            related: relatedLocation({
              file: glossaryFile,
              pointer: `/discouragedAliases/${hit.alias.index}/alias`,
              line: lineOf(hit.alias.alias),
            }),
            suggestion: `Use "${hit.alias.prefer}" instead.${because}`,
          },
        ),
      )
    }
    scanned += 1
  }

  const exercisedSenses = new Set()
  const overLimit = new Set()

  for (const term of glossary.terms) {
    const list = occurrences.get(term.term)
    const total = list.length + aliasCount.get(term.term)
    if (total > limits.maxOccurrencesPerTerm) {
      incomplete = true
      overLimit.add(term.term)
      findings.push(
        makeFinding(
          'limit-exceeded',
          `"${term.term}" has ${total} occurrences, over the maxOccurrencesPerTerm limit of ${limits.maxOccurrencesPerTerm}; it was not compared`,
          {
            file: glossaryFile,
            pointer: `/terms/${term.index}`,
            line: lineOf(term.definition),
            suggestion: 'Raise limits.maxOccurrencesPerTerm, or narrow the corpus for this run.',
          },
        ),
      )
    }
  }

  for (const finding of aliasFindings) findings.push(finding)

  for (const term of glossary.terms) {
    if (overLimit.has(term.term)) continue
    if (outOfTime()) {
      incomplete = true
      findings.push(
        makeFinding(
          'limit-exceeded',
          `comparison stopped at the timeLimitMs budget of ${limits.timeLimitMs}ms before "${term.term}" was compared`,
          { suggestion: 'Raise limits.timeLimitMs, or check fewer documents in one run.' },
        ),
      )
      break
    }
    const list = occurrences.get(term.term).slice().sort(compareOccurrences)
    const senses = new Map()
    for (const occurrence of list) {
      if (!senses.has(occurrence.senseKey)) senses.set(occurrence.senseKey, [])
      senses.get(occurrence.senseKey).push(occurrence)
    }
    const senseKeys = [...senses.keys()].sort(byCodeUnit)
    for (const senseKey of senseKeys) {
      const group = senses.get(senseKey)
      const scope = group[0].scope
      const exception = exceptionByPair.get(pairKey(term.term, scope))
      if (exception !== undefined) exercisedSenses.add(pairKey(term.term, scope))
      const authority = exception === undefined ? term.definition : exception.definition
      const authorityPointer =
        exception === undefined ? `/terms/${term.index}/definition` : `/exceptions/${exception.index}/definition`
      const authorityLabel =
        exception === undefined
          ? 'the canonical glossary definition'
          : `the "${exception.scope}" exception definition`

      for (const occurrence of group) {
        if (normalizeDefinition(occurrence.text) === normalizeDefinition(authority)) continue
        const score = similarity(occurrence.text, authority)
        if (score >= similarityThreshold) continue
        findings.push(
          makeFinding(
            'definition-off-glossary',
            `"${term.term}" is defined here in terms that do not match ${authorityLabel} (lexical overlap ${overlap(score)}, threshold ${overlap(similarityThreshold)})`,
            {
              file: occurrence.file,
              pointer: `/lines/${occurrence.line}`,
              line: occurrence.line,
              column: occurrence.column,
              evidence: occurrence.raw,
              related: relatedLocation({
                file: glossaryFile,
                pointer: authorityPointer,
                line: lineOf(authority),
                evidence: authority,
              }),
              suggestion:
                exception === undefined
                  ? `Restate the definition to agree with the glossary, or ${scopeAdvice(scope)} with a reason if this sense is intended.`
                  : `Restate the definition to agree with the "${exception.scope}" exception, or update that exception.`,
            },
          ),
        )
      }

      const anchor = group[0]
      for (let index = 1; index < group.length; index += 1) {
        const occurrence = group[index]
        if (normalizeDefinition(occurrence.text) === normalizeDefinition(anchor.text)) continue
        const score = similarity(occurrence.text, anchor.text)
        const conflicting = score < similarityThreshold
        const ruleId = conflicting ? 'definition-conflict' : 'definition-paraphrased'
        const scopeNote = senseKey === CANONICAL_SENSE ? '' : ` in scope "${scope}"`
        findings.push(
          makeFinding(
            ruleId,
            conflicting
              ? `"${term.term}" is defined here${scopeNote} in terms that contradict its first definition at ${anchor.file}:${anchor.line} (lexical overlap ${overlap(score)}, threshold ${overlap(similarityThreshold)})`
              : `"${term.term}" is restated here${scopeNote} in different words than at ${anchor.file}:${anchor.line} (lexical overlap ${overlap(score)})`,
            {
              file: occurrence.file,
              pointer: `/lines/${occurrence.line}`,
              line: occurrence.line,
              column: occurrence.column,
              evidence: occurrence.raw,
              related: relatedLocation({
                file: anchor.file,
                pointer: `/lines/${anchor.line}`,
                line: anchor.line,
                column: anchor.column,
                evidence: anchor.raw,
              }),
              suggestion: conflicting
                ? `Reconcile the two definitions, or ${scopeAdvice(scope)} with a reason if both senses are intended.`
                : 'Reuse one wording so readers do not have to compare them.',
            },
          ),
        )
      }
    }
  }

  for (const exception of glossary.exceptions) {
    if (exercisedSenses.has(pairKey(exception.term, exception.scope))) continue
    findings.push(
      makeFinding(
        'exception-unused',
        `the exception for "${exception.term}" in scope "${exception.scope}" matched no definition in that scope`,
        {
          file: glossaryFile,
          pointer: `/exceptions/${exception.index}`,
          line: lineOf(exception.definition),
          evidence: exception.reason,
          suggestion: 'Remove the exception, or check that its scope paths still match the corpus.',
        },
      ),
    )
  }

  if (scanned > 0 && definitionCount === 0) {
    findings.push(
      makeFinding(
        'no-definitions-found',
        `no definition of a glossary term was found in ${scanned} document${scanned === 1 ? '' : 's'}, so no definition could be compared`,
        {
          suggestion: 'Check that definitions use one of the recognised forms documented in docs/glossary-rules.md.',
        },
      ),
    )
  }

  findings.sort(compareFindings)

  let reported = findings
  if (findings.length > limits.maxFindings) {
    incomplete = true
    reported = findings.slice(0, limits.maxFindings)
    reported.push(
      makeFinding(
        'limit-exceeded',
        `${findings.length} findings exceed the maxFindings limit of ${limits.maxFindings}; ${findings.length - limits.maxFindings} were not reported`,
        { suggestion: 'Raise limits.maxFindings, or fix the reported findings and run again.' },
      ),
    )
  }

  const errors = reported.filter((finding) => finding.severity === 'error').length
  const warnings = reported.filter((finding) => finding.severity === 'warning').length
  const info = reported.filter((finding) => finding.severity === 'info').length

  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: scanned,
      errors,
      warnings,
      info,
      documents: documents.length,
      terms: glossary.terms.length,
      definitions: definitionCount,
      aliasHits: aliasHitCount,
    },
    findings: reported,
  }
}

function compareOccurrences(left, right) {
  if (left.file !== right.file) return byCodeUnit(left.file, right.file)
  if (left.line !== right.line) return left.line < right.line ? -1 : 1
  if (left.column !== right.column) return left.column < right.column ? -1 : 1
  return 0
}

/** The exit code the report contract assigns to a status. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

/** A human-readable rendering. The JSON report is the machine-readable one. */
export function formatReport(report) {
  const lines = []
  const { summary } = report
  lines.push(`${report.tool}: ${report.status}`)
  lines.push(
    `  ${summary.checked} of ${summary.documents} documents checked, ${summary.terms} glossary terms, ${summary.definitions} definitions, ${summary.aliasHits} discouraged alias uses`,
  )
  lines.push(`  ${summary.errors} errors, ${summary.warnings} warnings, ${summary.info} info`)
  for (const finding of report.findings) {
    const place = finding.location.file === undefined ? '(run)' : finding.location.file
    const line = finding.line === null ? '' : `:${finding.line}`
    const column = finding.column === null ? '' : `:${finding.column}`
    lines.push(`${place}${line}${column}  ${finding.severity}  ${finding.ruleId}  ${finding.message}`)
    if (finding.related !== undefined) {
      const other = finding.related
      const otherLine = other.line === null ? '' : `:${other.line}`
      lines.push(`    also at ${other.location.file ?? '(glossary)'}${otherLine}${other.location.pointer === undefined ? '' : ` ${other.location.pointer}`}`)
    }
  }
  return `${lines.join('\n')}\n`
}
