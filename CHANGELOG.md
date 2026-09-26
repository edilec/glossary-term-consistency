# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a definition reader for a fixed, documented set of definition-line shapes:
  list, heading, blockquote and bare labels, separated by a colon, an em or en
  dash, or a spaced hyphen, with the label matched **whole** against the
  glossary so a sentence that merely contains a term is not a definition of it;
- sense grouping: definitions are compared within a term *and* a sense, where a
  sense is the scoped exception governing the document or the canonical glossary
  entry, so a declared domain-specific meaning is never a false conflict;
- `definition-conflict` and `definition-off-glossary`, each reported with both
  places that disagree — file, line and column of the occurrence and of the
  other definition, glossary locations carrying a JSON Pointer;
- `discouraged-alias-used`, matched whole-term only, outside fenced code blocks
  and inline code spans, with the preferred term and the declared reason in the
  suggestion;
- `exception-unused` for a scoped exception the corpus no longer exercises, and
  `no-definitions-found` so a corpus in which nothing matched cannot look like
  agreement;
- one frozen `ruleId -> severity` table that every finding takes its severity
  from; an unknown rule id throws, and the table is asserted against the
  documented catalog in both directions;
- real path confinement for the corpus: an absolute path, a `..` segment or a
  repeated input is refused, and the resolved real path must be inside the real
  root, so a symlink planted in the corpus cannot pull out-of-root content into
  a report;
- strict decoding with `TextDecoder('utf-8', { fatal: true })`: encoding
  validity is never inferred from decoded text, so a file containing a literal
  U+FFFD is checked normally and undecodable bytes are always `incomplete`.
  Every leading byte-order mark is removed — `TextDecoder` removes one, and a
  file re-encoded twice carries another — and so is a CRLF ending, so a
  document written on Windows is read exactly as its LF twin is;
- enforced limits on documents, bytes, lines, glossary terms, occurrences per
  term, findings and wall-clock time, each an explicit `limit-exceeded` finding
  with status `incomplete` rather than a silent truncation;
- a CLI with `--glossary`, `--config`, `--root`, `--json` and `--help`, the two
  documented shapes of exit 2 — a configuration error with empty stdout, an
  unreadable input as an `incomplete` report — and exit codes 0 / 1 / 2;
- a clean example corpus and a deliberately broken one sharing a glossary that
  declares a `physics` scope and an exception with a reason;
- the rule catalog, the definition grammar, the configuration schema, the limits
  and the determinism guarantee in `docs/glossary-rules.md`.

### Notes

- Determinism: no `localeCompare`, no wall clock outside an injected one, no
  random source and no directory walk. Inputs are processed in the order given,
  terms in the order the glossary declares them, and every string comparison is
  by UTF-16 code unit.
- The comparison is lexical, not semantic. `README.md` states what that means
  the tool cannot conclude.

No release has been published.
