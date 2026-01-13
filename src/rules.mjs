/**
 * The severity authority for glossary-term-consistency.
 *
 * Severity decides whether a run passes or fails, so it is declared exactly
 * once, here, and every finding takes its severity from this table. A rule id
 * that is not in the table throws instead of defaulting to anything, and
 * `docs/glossary-rules.md` is asserted against this object in both directions
 * by the test suite: a rule that exists in code but not in the catalog, or in
 * the catalog but not in code, fails the build.
 */

export const TOOL_ID = 'glossary-term-consistency'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

/** Rule catalog. Ids are stable; renaming one is a breaking change. */
export const RULES = Object.freeze({
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

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/** A problem with the run's configuration: there was never a subject to report on. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Look up a severity. An unknown rule id is a programming error, not a default. */
export function severityOf(ruleId) {
  if (!Object.hasOwn(RULES, ruleId)) throw new Error(`Unknown ruleId "${ruleId}"`)
  return RULES[ruleId]
}

const EVIDENCE_CODE_POINTS = 140

/**
 * Evidence is bounded and escaped.
 *
 * Control characters and the Unicode line separators become escape text, so one
 * finding stays one line and an excerpt of someone else's document can never be
 * mistaken for a directive to whatever reads the report.
 */
export function evidenceOf(text) {
  const characters = Array.from(String(text).trim())
  const bounded =
    characters.length > EVIDENCE_CODE_POINTS
      ? `${characters.slice(0, EVIDENCE_CODE_POINTS).join('')} [...]`
      : characters.join('')
  let out = ''
  for (const character of bounded) {
    const code = character.codePointAt(0)
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += character
  }
  return out
}

/**
 * Build one finding. `severity` is never passed in: it is looked up, so no
 * construction site can quietly disagree with the catalog.
 */
export function makeFinding(ruleId, message, where = {}) {
  const { file = null, pointer = null, line = null, column = null, evidence = null, related = null, suggestion = null } = where
  const location = {}
  if (file !== null) location.file = file
  if (pointer !== null) location.pointer = pointer
  const finding = {
    ruleId,
    severity: severityOf(ruleId),
    message,
    location,
    line,
    column,
  }
  if (evidence !== null) finding.evidence = evidenceOf(evidence)
  if (related !== null) finding.related = related
  if (suggestion !== null) finding.suggestion = suggestion
  return finding
}

/** A second location for the rules that compare two places. */
export function relatedLocation({ file = null, pointer = null, line = null, column = null, evidence = null }) {
  const location = {}
  if (file !== null) location.file = file
  if (pointer !== null) location.pointer = pointer
  const related = { location, line, column }
  if (evidence !== null) related.evidence = evidenceOf(evidence)
  return related
}

/** Sort by UTF-16 code unit. Locale collation varies with the ICU data a Node build carries. */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}
