# glossary-term-consistency

Compare a canonical glossary against a document corpus and report where a term
is defined in two incompatible ways, where a discouraged alias is used, and
where a declared per-scope exception legitimately gives a term a different
sense.

Every conflict is reported with **both** places that disagree — file, line and
column of each — because the useful output is the pair of lines an editor has to
reconcile, not the news that something somewhere is inconsistent.

- **Repository:** [edilec/glossary-term-consistency](https://github.com/edilec/glossary-term-consistency)
- **Area:** Docs & Knowledge
- **License:** MIT
- Node 22+, ESM, **zero dependencies** — runtime and development both.

## Use

```sh
node bin/glossary-term-consistency.mjs \
  --root examples \
  --glossary examples/glossary.json \
  --config examples/policy.json \
  clean/handbook.md clean/physics/notes.md
```

```
glossary-term-consistency: pass
  2 of 2 documents checked, 3 glossary terms, 4 definitions, 0 discouraged alias uses
  0 errors, 0 warnings, 0 info
```

The deliberately broken corpus in the same directory shows the three things the
tool is for:

```sh
node bin/glossary-term-consistency.mjs \
  --root examples --glossary examples/glossary.json --config examples/policy.json \
  broken/handbook.md broken/billing/invoices.md broken/reference/api.md broken/physics/notes.md
```

```
glossary-term-consistency: fail
  4 of 4 documents checked, 3 glossary terms, 5 definitions, 2 discouraged alias uses
  4 errors, 0 warnings, 0 info
broken/billing/invoices.md:5:7  error  discouraged-alias-used  "artefact" is a discouraged alias of "artifact"
    also at examples/glossary.json:20 /discouragedAliases/0/alias
broken/reference/api.md:3:1  error  definition-conflict  "token" is defined here in terms that contradict its first definition at broken/handbook.md:6 (lexical overlap 0.00, threshold 0.50)
    also at broken/handbook.md:6 /lines/6
broken/reference/api.md:3:1  error  definition-off-glossary  "token" is defined here in terms that do not match the canonical glossary definition (lexical overlap 0.00, threshold 0.50)
    also at examples/glossary.json:15 /terms/2/definition
broken/reference/api.md:5:12  error  discouraged-alias-used  "api key" is a discouraged alias of "token"
    also at examples/glossary.json:25 /discouragedAliases/1/alias
```

`broken/physics/notes.md` defines `charge` as an electrostatic property, which
contradicts the billing definition in the same run — and is *not* reported,
because the glossary declares a `physics` scope and an exception for it with a
stated reason. Delete that exception and the same line is reported as a
conflict.

`--json` emits the machine-readable report on stdout instead. Add `--help` for
the full option list.

## Exit codes

| Code | Meaning |
| ---: | :--- |
| `0` | every definition agreed, and no discouraged alias was used |
| `1` | the corpus contradicts the glossary or itself |
| `2` | invalid usage or configuration (nothing on stdout), or an input that could not be read, decoded or confined (an `incomplete` report on stdout) |

A run that could not read its evidence is never a pass. If no document was read
at all, the report is `incomplete` and exits `2` even though the accompanying
finding is only a warning.

## Input

Two JSON files and a list of documents:

- **the glossary** (`--glossary`): terms with a canonical definition and
  optional accepted aliases; discouraged aliases that map to a preferred term;
  scopes, each owning path prefixes; and exceptions that give a term a different
  definition inside one scope. An exception must carry a `reason`.
- **the policy** (`--config`, optional): limits, the similarity threshold, and
  case sensitivity.
- **the corpus**: Markdown or plain text paths, given relative to `--root`, read
  in the order given. No directory is ever walked.

Unknown keys are rejected everywhere. The full schema, the rule catalog and the
limits are in [`docs/glossary-rules.md`](./docs/glossary-rules.md).

## Limits and non-goals

**It does not understand meaning.** Two definitions are compared by lexical
overlap — the Dice coefficient over their content words. That means a genuine
paraphrase using different vocabulary can be reported as a conflict, and two
definitions that contradict each other while sharing most of their words
(`"is always encrypted"` versus `"is never encrypted"`) will *not* be reported.
A clean run is evidence that the wording agrees, not that the corpus is
coherent. Tune `similarityThreshold` deliberately and read the findings; do not
treat exit 0 as a semantic guarantee.

**It only sees definition lines it recognises.** A definition written as a
paragraph, a table row, an HTML `<dl>`, or a sentence with the term in the
middle is invisible to it. The recognised shapes are listed in the docs. A
corpus where nothing matched still passes, so the report carries a
`no-definitions-found` warning and `summary.definitions` rather than letting a
silent zero look like agreement.

**It matches surface forms, not concepts.** Matching is whole-term only: a term
never matches inside a longer word, and a hyphenated compound such as
`build-artefact` is not an occurrence of `artefact`. There is no stemming,
lemmatisation, plural handling or spelling correction, so `artifacts` is not an
occurrence of `artifact` unless the glossary declares it.

**It cannot tell an intentional second sense from a mistake.** That judgement is
the operator's, expressed as a scope and an exception with a reason. An
undeclared second sense is reported as a conflict, which is the intended
behaviour.

**It reads only local files.** There is no network access, no telemetry and no
provider call. A glossary that lives in some other system has to be exported to
a local file first; nothing is inferred about the copy's freshness.

**`--glossary` and `--config` are trusted operator configuration**, resolved
against the working directory, and are not confined to `--root`. Only corpus
documents are confined, and that confinement is real: a path that is absolute or
contains `..` is refused, and the resolved real path must still be inside the
real root, so a symlink planted in the corpus cannot pull outside content into a
report.

**Input is data, never instruction.** Evidence excerpts are bounded and escaped,
and nothing read from a document changes what the tool does.

## Verify

```sh
npm run check
```

Runs `node --check` over every source and test file, the `node --test` suite,
the clean example end to end, and `npm pack --dry-run`. There are no
dependencies to install.

## License

MIT. See [LICENSE](./LICENSE).
