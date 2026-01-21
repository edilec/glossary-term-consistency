#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  ConfigError,
  checkCorpus,
  exitCodeFor,
  formatReport,
  parseGlossary,
  parsePolicy,
  readCorpus,
} from '../src/index.mjs'

/**
 * The one clock in the tool. `limits.timeLimitMs` is enforced against an
 * injected clock so the library stays deterministic; the command line injects
 * the process monotonic clock here, and the budget can only ever turn a run
 * into an explicit `limit-exceeded` with status `incomplete`.
 */
const clock = () => performance.now()

const HELP = `glossary-term-consistency

Compare a canonical glossary against a document corpus: conflicting
definitions, discouraged aliases, and the per-scope exceptions that make a
domain-specific sense legitimate.

Usage:
  glossary-term-consistency --glossary FILE [options] <doc.md> [doc.md ...]

Options:
  --glossary FILE  Canonical glossary (JSON, required)
  --config FILE    Policy: limits, similarity threshold, case sensitivity (JSON)
  --root DIR       Root the corpus paths are relative to (default: cwd)
  --json           Emit the machine-readable report on stdout
  -h, --help       Show this help

Corpus paths are given relative to --root, and are read in the order given; no
directory is walked, so the report never depends on filesystem enumeration
order. A path that is absolute, that contains a ".." segment, or that resolves
outside the real root once symbolic links are followed is refused, and such a
file is never read. --glossary and --config are operator configuration and are
resolved against the working directory.

Exit codes:
  0  every definition agreed, and no discouraged alias was used
  1  the corpus contradicts the glossary or itself
  2  invalid usage or configuration (no report), or an input that could not be
     read, decoded or compared (an "incomplete" report)
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { glossary: null, config: null, root: null, json: false, files: [] }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new ConfigError(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--glossary') options.glossary = takeValue('--glossary')
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument.startsWith('-')) throw new ConfigError(`Unknown option "${argument}"`)
    else options.files.push(argument)
  }

  if (options.glossary === null) throw new ConfigError('--glossary is required')
  if (options.files.length === 0) throw new ConfigError('at least one corpus document is required')
  return options
}

async function readJson(path, what) {
  let text
  try {
    text = await readFile(resolve(path), 'utf8')
  } catch (error) {
    throw new ConfigError(`Could not read the ${what} at "${path}" (${error.code ?? error.message})`)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`The ${what} at "${path}" is not valid JSON: ${error.message}`)
  }
  return { text, value }
}

/** A reported path is never an absolute host path. */
function reportedGlossaryPath(given) {
  return isAbsolute(given) ? basename(given) : given.split('\\').join('/')
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let policy
  let glossary
  let glossaryText
  try {
    policy = parsePolicy(options.config === null ? {} : (await readJson(options.config, 'policy')).value)
    const loaded = await readJson(options.glossary, 'glossary')
    glossaryText = loaded.text
    glossary = parseGlossary(loaded.value, { caseSensitive: policy.caseSensitive, limits: policy.limits })
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  let corpus
  try {
    corpus = await readCorpus(options.files, {
      root: options.root ?? process.cwd(),
      limits: policy.limits,
      clock,
    })
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const report = checkCorpus({
    glossary,
    glossaryFile: reportedGlossaryPath(options.glossary),
    glossaryText,
    documents: corpus.documents,
    failures: corpus.failures,
    policy,
    clock,
  })

  for (const failure of corpus.failures) {
    process.stderr.write(`skipped: ${failure.file ?? '(run)'}: ${failure.message}\n`)
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
  return exitCodeFor(report)
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`execution failed: ${error.message}\n`)
  process.exitCode = 2
}
