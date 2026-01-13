/**
 * Configuration: the policy file, the canonical glossary, and the limits.
 *
 * Everything here is operator configuration. A problem with it is a
 * `ConfigError`: the run never had a subject, so it produces a message on
 * stderr and no report, per the catalog's report contract. Unknown keys are
 * rejected rather than ignored, because a one-character typo that silently
 * disables a check turns a real failure into a green run.
 */

import { CONFIG_SCHEMA_VERSION, ConfigError } from './rules.mjs'

/** Every limit is enforced. Exceeding one is an explicit finding, never a silent truncation. */
export const DEFAULT_LIMITS = Object.freeze({
  maxDocuments: 500,
  maxFileBytes: 1_048_576,
  maxLines: 20_000,
  maxTerms: 2_000,
  maxOccurrencesPerTerm: 1_000,
  maxFindings: 1_000,
  timeLimitMs: 10_000,
})

export const DEFAULT_SIMILARITY_THRESHOLD = 0.5

const POLICY_KEYS = Object.freeze(['schemaVersion', 'caseSensitive', 'similarityThreshold', 'limits'])
const GLOSSARY_KEYS = Object.freeze(['schemaVersion', 'terms', 'discouragedAliases', 'scopes', 'exceptions'])
const TERM_KEYS = Object.freeze(['term', 'definition', 'aliases'])
const DISCOURAGED_KEYS = Object.freeze(['alias', 'prefer', 'reason'])
const SCOPE_KEYS = Object.freeze(['id', 'paths'])
const EXCEPTION_KEYS = Object.freeze(['term', 'scope', 'definition', 'reason'])

export const DEFAULT_SCOPE = 'default'
const SCOPE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u
const MAX_TERM_LENGTH = 120
const MAX_DEFINITION_LENGTH = 2_000
const MAX_REASON_LENGTH = 500

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireKeys(value, allowed, where) {
  if (!isRecord(value)) throw new ConfigError(`${where} must be a JSON object`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ConfigError(`Unknown configuration key "${key}" in ${where}`)
  }
}

function requireString(value, where, maxLength) {
  if (typeof value !== 'string') throw new ConfigError(`${where} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new ConfigError(`${where} must not be empty`)
  if (trimmed.length > maxLength) throw new ConfigError(`${where} must be at most ${maxLength} characters`)
  return trimmed
}

/** Case folding is explicit and locale-independent: `toLowerCase`, never `toLocaleLowerCase`. */
export function normalizeKey(text, caseSensitive) {
  const collapsed = String(text).normalize('NFC').replace(/\s+/gu, ' ').trim()
  return caseSensitive ? collapsed : collapsed.toLowerCase()
}

/** Validate the optional policy file. A missing key takes the documented default. */
export function parsePolicy(value = {}) {
  requireKeys(value, POLICY_KEYS, 'the policy')
  if (value.schemaVersion !== undefined && value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Policy schemaVersion must be "${CONFIG_SCHEMA_VERSION}"`)
  }
  if (value.caseSensitive !== undefined && typeof value.caseSensitive !== 'boolean') {
    throw new ConfigError('Policy caseSensitive must be a boolean')
  }
  let threshold = DEFAULT_SIMILARITY_THRESHOLD
  if (value.similarityThreshold !== undefined) {
    if (typeof value.similarityThreshold !== 'number' || !Number.isFinite(value.similarityThreshold)) {
      throw new ConfigError('Policy similarityThreshold must be a finite number')
    }
    if (value.similarityThreshold < 0 || value.similarityThreshold > 1) {
      throw new ConfigError('Policy similarityThreshold must be between 0 and 1')
    }
    threshold = value.similarityThreshold
  }
  const limits = { ...DEFAULT_LIMITS }
  if (value.limits !== undefined) {
    requireKeys(value.limits, Object.keys(DEFAULT_LIMITS), 'policy limits')
    for (const [key, given] of Object.entries(value.limits)) {
      const floor = key === 'timeLimitMs' ? 0 : 1
      if (!Number.isSafeInteger(given) || given < floor) {
        throw new ConfigError(`Policy limit "${key}" must be an integer >= ${floor}`)
      }
      limits[key] = given
    }
  }
  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    caseSensitive: value.caseSensitive === true,
    similarityThreshold: threshold,
    limits: Object.freeze(limits),
  })
}

function parseScopes(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new ConfigError('Glossary scopes must be an array')
  const scopes = []
  const seenIds = new Set()
  const seenPaths = new Map()
  raw.forEach((entry, index) => {
    const where = `scopes[${index}]`
    requireKeys(entry, SCOPE_KEYS, where)
    const id = requireString(entry.id, `${where}.id`, 40)
    if (!SCOPE_ID.test(id)) throw new ConfigError(`${where}.id must match ${SCOPE_ID.source}`)
    if (id === DEFAULT_SCOPE) {
      throw new ConfigError(`${where}.id "${DEFAULT_SCOPE}" is reserved for documents no scope claims`)
    }
    if (seenIds.has(id)) throw new ConfigError(`Duplicate scope id "${id}"`)
    seenIds.add(id)
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      throw new ConfigError(`${where}.paths must be a non-empty array`)
    }
    const paths = entry.paths.map((path, pathIndex) => {
      const value = requireString(path, `${where}.paths[${pathIndex}]`, 400)
      const normalized = value.replace(/\\/gu, '/').replace(/\/+$/u, '')
      if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
        throw new ConfigError(`${where}.paths[${pathIndex}] must be a relative path inside the root`)
      }
      if (normalized.split('/').includes('..')) {
        throw new ConfigError(`${where}.paths[${pathIndex}] must not contain a ".." segment`)
      }
      const owner = seenPaths.get(normalized)
      if (owner !== undefined) {
        throw new ConfigError(`Scope path "${normalized}" is claimed by both "${owner}" and "${id}"`)
      }
      seenPaths.set(normalized, id)
      return normalized
    })
    scopes.push(Object.freeze({ id, paths: Object.freeze(paths), index }))
  })
  return scopes
}

/**
 * Validate the canonical glossary.
 *
 * Two surface forms may never resolve to the same key: an accepted alias that
 * collides with another term, or a discouraged alias that is also a term, would
 * make the report depend on iteration order rather than on the glossary.
 */
export function parseGlossary(value, { caseSensitive = false, limits = DEFAULT_LIMITS } = {}) {
  requireKeys(value, GLOSSARY_KEYS, 'the glossary')
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Glossary schemaVersion must be "${CONFIG_SCHEMA_VERSION}"`)
  }
  if (!Array.isArray(value.terms) || value.terms.length === 0) {
    throw new ConfigError('Glossary terms must be a non-empty array: a glossary with no terms can check nothing')
  }
  if (value.terms.length > limits.maxTerms) {
    throw new ConfigError(`Glossary declares ${value.terms.length} terms, over the maxTerms limit of ${limits.maxTerms}`)
  }

  const keyOwner = new Map()
  const terms = value.terms.map((entry, index) => {
    const where = `terms[${index}]`
    requireKeys(entry, TERM_KEYS, where)
    const term = requireString(entry.term, `${where}.term`, MAX_TERM_LENGTH)
    const definition = requireString(entry.definition, `${where}.definition`, MAX_DEFINITION_LENGTH)
    const aliases = []
    if (entry.aliases !== undefined) {
      if (!Array.isArray(entry.aliases)) throw new ConfigError(`${where}.aliases must be an array`)
      entry.aliases.forEach((alias, aliasIndex) => {
        aliases.push(requireString(alias, `${where}.aliases[${aliasIndex}]`, MAX_TERM_LENGTH))
      })
    }
    for (const surface of [term, ...aliases]) {
      const key = normalizeKey(surface, caseSensitive)
      const owner = keyOwner.get(key)
      if (owner !== undefined) {
        throw new ConfigError(`Surface form "${surface}" is claimed by both "${owner}" and "${term}"`)
      }
      keyOwner.set(key, term)
    }
    return Object.freeze({ term, definition, aliases: Object.freeze(aliases), index })
  })

  const termByName = new Map(terms.map((entry) => [entry.term, entry]))

  const discouragedAliases = []
  if (value.discouragedAliases !== undefined) {
    if (!Array.isArray(value.discouragedAliases)) {
      throw new ConfigError('Glossary discouragedAliases must be an array')
    }
    const seen = new Set()
    value.discouragedAliases.forEach((entry, index) => {
      const where = `discouragedAliases[${index}]`
      requireKeys(entry, DISCOURAGED_KEYS, where)
      const alias = requireString(entry.alias, `${where}.alias`, MAX_TERM_LENGTH)
      const prefer = requireString(entry.prefer, `${where}.prefer`, MAX_TERM_LENGTH)
      if (!termByName.has(prefer)) throw new ConfigError(`${where}.prefer "${prefer}" is not a declared term`)
      const key = normalizeKey(alias, caseSensitive)
      if (keyOwner.has(key)) {
        throw new ConfigError(`${where}.alias "${alias}" is also an accepted surface form of "${keyOwner.get(key)}"`)
      }
      if (seen.has(key)) throw new ConfigError(`Duplicate discouraged alias "${alias}"`)
      seen.add(key)
      const reason =
        entry.reason === undefined ? null : requireString(entry.reason, `${where}.reason`, MAX_REASON_LENGTH)
      discouragedAliases.push(Object.freeze({ alias, prefer, reason, key, index }))
    })
  }

  const scopes = parseScopes(value.scopes)
  const scopeIds = new Set(scopes.map((scope) => scope.id))

  const exceptions = []
  if (value.exceptions !== undefined) {
    if (!Array.isArray(value.exceptions)) throw new ConfigError('Glossary exceptions must be an array')
    const seen = new Set()
    value.exceptions.forEach((entry, index) => {
      const where = `exceptions[${index}]`
      requireKeys(entry, EXCEPTION_KEYS, where)
      const term = requireString(entry.term, `${where}.term`, MAX_TERM_LENGTH)
      if (!termByName.has(term)) throw new ConfigError(`${where}.term "${term}" is not a declared term`)
      const scope = requireString(entry.scope, `${where}.scope`, 40)
      if (!scopeIds.has(scope)) throw new ConfigError(`${where}.scope "${scope}" is not a declared scope`)
      const definition = requireString(entry.definition, `${where}.definition`, MAX_DEFINITION_LENGTH)
      if (entry.reason === undefined) {
        throw new ConfigError(`${where}.reason is required: an exception without a stated reason cannot be reviewed`)
      }
      const reason = requireString(entry.reason, `${where}.reason`, MAX_REASON_LENGTH)
      const pair = `${term} in ${scope}`
      if (seen.has(pair)) throw new ConfigError(`Duplicate exception for term "${term}" in scope "${scope}"`)
      seen.add(pair)
      exceptions.push(Object.freeze({ term, scope, definition, reason, index }))
    })
  }

  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    terms: Object.freeze(terms),
    discouragedAliases: Object.freeze(discouragedAliases),
    scopes: Object.freeze(scopes),
    exceptions: Object.freeze(exceptions),
  })
}

/**
 * The scope a document belongs to: the longest declared path prefix that owns
 * it, or the reserved default scope. Two scopes can never declare the same
 * prefix, so the longest match is unique.
 */
export function scopeOf(file, scopes) {
  let best = DEFAULT_SCOPE
  let bestLength = -1
  for (const scope of scopes) {
    for (const path of scope.paths) {
      if (file !== path && !file.startsWith(`${path}/`)) continue
      if (path.length > bestLength) {
        best = scope.id
        bestLength = path.length
      }
    }
  }
  return best
}

/**
 * Locate a glossary value's line by finding the first line that contains its
 * JSON encoding. A value that is pretty-printed across lines, or written with
 * different escaping, resolves to `null` rather than to a guess.
 */
export function locateLines(text, values, maxLines = DEFAULT_LIMITS.maxLines) {
  const found = new Map()
  const pending = new Set(values.filter((value) => typeof value === 'string' && value !== ''))
  if (pending.size === 0) return found
  const needles = new Map([...pending].map((value) => [value, JSON.stringify(value)]))
  const lines = text.split('\n')
  const limit = Math.min(lines.length, maxLines)
  for (let index = 0; index < limit && pending.size > 0; index += 1) {
    const line = lines[index]
    for (const value of pending) {
      if (line.includes(needles.get(value))) {
        found.set(value, index + 1)
        pending.delete(value)
      }
    }
  }
  return found
}
