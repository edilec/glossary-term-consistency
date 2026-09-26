/** Shared fixtures for the test suite. Not a test file itself. */

import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(ROOT, 'bin', 'glossary-term-consistency.mjs')

/** A glossary object literal, so a test can change exactly one field of it. */
export function glossaryValue(overrides = {}) {
  return {
    schemaVersion: '1',
    terms: [
      {
        term: 'artifact',
        definition: 'A file produced by a build and stored for later use.',
        aliases: ['build artifact'],
      },
      { term: 'charge', definition: 'An amount of money billed to a customer account.' },
      { term: 'token', definition: 'A short-lived credential that authorises an API request.' },
    ],
    discouragedAliases: [
      { alias: 'artefact', prefer: 'artifact', reason: 'The handbook uses the US spelling.' },
      { alias: 'api key', prefer: 'token', reason: 'Access is granted by tokens.' },
    ],
    scopes: [{ id: 'physics', paths: ['physics'] }],
    exceptions: [
      {
        term: 'charge',
        scope: 'physics',
        definition: 'A property of matter that causes it to experience a force in an electromagnetic field.',
        reason: 'The physics explainers use the electrostatic sense.',
      },
    ],
    ...overrides,
  }
}

/** A document in the shape `readCorpus` produces. */
export function doc(file, text) {
  return { file, given: file, lines: text.split('\n') }
}

/** Create a temporary directory tree. `files` maps a relative path to its content. */
export async function makeTree(files) {
  const base = await mkdtemp(join(tmpdir(), 'glossary-term-consistency-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(base, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return base
}

/** A clock that advances by a fixed step on every read, so a budget is reached deterministically. */
export function steppingClock(step) {
  let now = 0
  return () => {
    const value = now
    now += step
    return value
  }
}

/** Run the real command line. */
export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? ROOT,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
