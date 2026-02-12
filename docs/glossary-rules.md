# Rules, configuration, limits and determinism

This document is the reference for what `glossary-term-consistency` checks, what
it refuses to guess, and what it guarantees about its own output.

## What counts as a definition

The tool does not read prose. It reads *definition lines*, and a definition line
is one of a small, fixed set of shapes. A line is a definition of a glossary term
when all of this holds:

1. It is not inside a fenced code block (` ``` ` or `~~~`).
2. After an optional prefix of up to eight spaces or tabs, any number of
   blockquote markers (`>`), one list marker (`-`, `*`, `+`, `1.`, `1)`) and one
   ATX heading marker (`#` to `######`), the rest of the line matches
   `label separator definition`.
3. The separator is a colon followed by at least one space, an em dash (`—`) or
   en dash (`–`) with optional spaces, or a hyphen with a space on both sides.
   A hyphen without spaces around it is never a separator, so `state-of-the-art`
   is not read as a definition of `state`.
4. The label, after up to three layers of `**`, `__`, `*`, `_` or backticks are
   stripped, matches a glossary term or one of its accepted aliases **as a
   whole**. `The artifact: ...` is not a definition of `artifact`, because the
   label is `The artifact`.
5. Something non-empty follows the separator.

The label is compared after Unicode NFC normalisation, whitespace collapsing and
(unless `caseSensitive` is set) case folding with `toLowerCase`.

## Senses, scopes and exceptions

A term may legitimately mean different things in different parts of a corpus.
That is expressed by declaring a **scope** — an id and the path prefixes it owns
— and an **exception** that gives the term a different definition inside that
scope. An exception must carry a `reason`; one without it is refused, because an
exception nobody can review is indistinguishable from a mistake.

A document belongs to the scope whose declared path prefix matches it most
specifically; prefixes match whole path segments, so `docs/physics` does not
claim `docs/physicsy/notes.md`. A document no scope claims belongs to the
reserved scope `default`, which cannot be declared and cannot carry an
exception.

Definitions are grouped by term **and by sense**. The sense of an occurrence is
the scope's exception when one governs it, and the canonical glossary entry
otherwise. Two senses are never compared with each other, so a declared
domain-specific meaning is never reported as a conflict with the canonical one.

Inside one sense, the first occurrence in sort order is the **anchor**, and
every later occurrence is compared to it. `N` divergent definitions therefore
produce `N - 1` findings rather than `N * (N - 1) / 2`.

## How two definitions are compared

Two definitions that normalise to the same text (emphasis marks removed,
whitespace collapsed, trailing punctuation removed, case folded) agree.

Otherwise they are compared by **lexical overlap**: the Dice coefficient over
their content words, where a content word is a run of letters, digits,
apostrophes and hyphens that is not in a small fixed stopword list. Overlap
below `similarityThreshold` (default `0.5`) is a conflict; overlap at or above
it is a restatement.

This measures *wording*, not *meaning*. See the README's limits section for what
that means the tool cannot conclude.

## Rule catalog

Rule ids are stable. Renaming one is a breaking change and is recorded in the
changelog. Severity is defined once, in `RULES` in `src/rules.mjs`, and the test
suite asserts that table against this one in both directions: a rule in code but
not here, or here but not in code, fails the build.

| ruleId | Severity | What it means |
| :--- | :--- | :--- |
| `definition-conflict` | error | A term is defined twice in the same sense, and the two definitions disagree. Both places are reported: the finding's own location and its `related` location |
| `definition-off-glossary` | error | A definition in the corpus disagrees with the definition that governs it — the canonical glossary entry, or the scoped exception. `related` points at the glossary line |
| `discouraged-alias-used` | error | A discouraged alias occurs in prose outside code. `suggestion` names the preferred term and the declared reason |
| `input-not-utf8` | error | An input's bytes are not valid UTF-8. It was not checked |
| `input-unreadable` | error | An input could not be resolved, inspected or read, or is not a regular file. It was not checked |
| `limit-exceeded` | error | A declared limit was reached. The message names the limit and what was not done |
| `path-outside-root` | error | An input resolves outside the real root once symbolic links are followed. It was not read |
| `exception-unused` | warning | A declared exception matched no definition in its scope, so the corpus no longer exercises it |
| `no-definitions-found` | warning | Documents were read, but no definition of any glossary term was found in them |
| `no-documents-checked` | warning | No corpus document was read at all, so nothing was compared |
| `definition-paraphrased` | info | A term is restated in different words that still overlap above the threshold |

`definition-conflict` and `definition-off-glossary` can both fire for one
definition: contradicting another document and contradicting the glossary are
two separate facts, and fixing one does not necessarily fix the other.

## Report

The report follows the catalog's report contract. Beyond the contract's fields:

- `line` and `column` are 1-based and are present on every finding, `null` where
  the finding is about the run rather than about a place.
- `location.pointer` is `/lines/<n>` for a corpus document and a JSON Pointer
  into the glossary (`/terms/2/definition`, `/exceptions/0`,
  `/discouragedAliases/1/alias`) for a glossary location.
- `related` carries the second place for the rules that compare two places:
  `{ location, line, column, evidence? }`.
- `summary` carries `checked` (documents scanned in full) and `errors`,
  `warnings`, `info`, plus `documents` (inputs given), `terms`, `definitions`
  and `aliasHits`.

Findings are sorted by `location.file` (documents first, run-level findings
last), then `line`, `column`, `ruleId`, `location.pointer` and finally the
related location. All string comparisons are by UTF-16 code unit: no
`localeCompare`, whose collation depends on the ICU data a Node build carries.

## Status and exit code

| Status | When | Exit |
| :--- | :--- | ---: |
| `pass` | Documents were read and no `error` finding was raised | 0 |
| `fail` | At least one `error` finding | 1 |
| `incomplete` | Evidence was missing: an input that could not be read, decoded or confined, a limit reached, or no document read at all | 2 |

`incomplete` wins over both others. A run that read nothing is never a pass: if
no document was read, `no-documents-checked` is raised *and* the report is
marked incomplete, and that flag is what prevents the pass, because the finding
itself is only a warning.

A configuration error — an unknown option, an unknown configuration key, an
unreadable or invalid glossary, an input path that is absolute, contains `..` or
is repeated — writes a message to stderr, writes **nothing** to stdout, and
exits 2. There is no report because the run never had a subject.

## Configuration

`--glossary FILE` (required) and `--config FILE` are operator configuration and
are resolved against the working directory. Corpus paths are resolved against
`--root` and confined to it. Unknown keys are rejected everywhere.

A corpus document is decoded with `TextDecoder('utf-8', { fatal: true })`; bytes
that do not decode are `input-not-utf8` and are not checked. Leading byte-order
marks — `TextDecoder` removes one, a file re-encoded twice carries another — and
CRLF line endings are removed before anything is compared.

### Glossary

```json
{
  "schemaVersion": "1",
  "terms": [
    { "term": "artifact", "definition": "A file produced by a build.", "aliases": ["build artifact"] }
  ],
  "discouragedAliases": [
    { "alias": "artefact", "prefer": "artifact", "reason": "The handbook uses the US spelling." }
  ],
  "scopes": [{ "id": "physics", "paths": ["clean/physics"] }],
  "exceptions": [
    { "term": "charge", "scope": "physics", "definition": "...", "reason": "..." }
  ]
}
```

- `terms` must be non-empty: a glossary with no terms can check nothing.
- A surface form — a term or one of its accepted `aliases` — may be claimed by
  only one term, and a discouraged alias may not also be an accepted form.
- `prefer` must name a declared term; `reason` is optional on a discouraged
  alias and required on an exception.
- A scope id matches `[a-z0-9][a-z0-9-]{0,39}`, may not be `default`, and its
  paths must be relative, must not contain `..`, and may not be claimed by two
  scopes.
- Two scopes may not share an id, and one alias may not be discouraged twice.
  Both are compared as keys, so under the default `caseSensitive: false` the
  spellings `artefact` and `Artefact` are the same discouraged alias.
- Every configured string is stored trimmed and may not be blank: a term or an
  alias is at most 120 characters, a definition at most 2000, a reason at most
  500 and a scope path at most 400.

### Policy

```json
{
  "schemaVersion": "1",
  "caseSensitive": false,
  "similarityThreshold": 0.5,
  "limits": { "maxDocuments": 50 }
}
```

`similarityThreshold` is a number in `[0, 1]`. `caseSensitive` changes both term
lookup and alias matching, and must be a boolean: `"yes"` is refused rather than
read as `false`. `schemaVersion` is optional here, and must be `"1"` when it is
given.

## Limits

Every limit is enforced, and exceeding one is an explicit `limit-exceeded`
finding with status `incomplete` — never a silent truncation and never a pass.

| Limit | Default | Effect when exceeded |
| :--- | ---: | :--- |
| `maxDocuments` | 500 | The run stops before any document is read |
| `maxFileBytes` | 1048576 | That file is not read |
| `maxLines` | 20000 | That file is not checked |
| `maxTerms` | 2000 | The glossary is refused as a configuration error |
| `maxOccurrencesPerTerm` | 1000 | That term is not compared |
| `maxFindings` | 1000 | The findings after the limit are not reported, and the count that was dropped is stated |
| `timeLimitMs` | 10000 | Reading or comparing stops where it is, and the report says how far it got |

`timeLimitMs` is measured against an injected clock. The library never reads a
clock of its own; the command line injects `performance.now`. `timeLimitMs: 0`
therefore stops at the first check, which is how the test suite proves the
command line really wires the clock through.

## Determinism

Running the tool twice over identical inputs produces byte-identical stdout. No
wall clock, locale, random source, hash iteration order or directory enumeration
affects the output: no directory is ever walked, inputs are processed in the
order given, terms in the order the glossary declares them, and every string
comparison is by code unit.
