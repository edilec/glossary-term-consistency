/**
 * glossary-term-consistency: read a canonical glossary and a document corpus,
 * and report where a term is defined in two incompatible ways, where a
 * discouraged alias is used, and where a declared per-scope exception applies.
 *
 * The public surface is this module. `bin/glossary-term-consistency.mjs` is a
 * thin command line over it: it parses arguments, injects the one clock in the
 * tool, and maps the report's status onto the exit code.
 */

export {
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  REPORT_SCHEMA_VERSION,
  RULES,
  SEVERITIES,
  TOOL_ID,
  byCodeUnit,
  evidenceOf,
  makeFinding,
  relatedLocation,
  severityOf,
} from './rules.mjs'

export {
  DEFAULT_LIMITS,
  DEFAULT_SCOPE,
  DEFAULT_SIMILARITY_THRESHOLD,
  locateLines,
  normalizeKey,
  parseGlossary,
  parsePolicy,
  scopeOf,
} from './config.mjs'

export {
  cleanLabel,
  extractDefinitions,
  findAliasHits,
  maskCode,
  maskCodeSpans,
  normalizeDefinition,
  readCorpus,
  similarity,
  surfaceFormPattern,
} from './scan.mjs'

export { checkCorpus, compareFindings, exitCodeFor, formatReport } from './check.mjs'
