# Kura's mend — one patch tool for every AI edit format

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/srimuryaticitra-cpu/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/srimuryaticitra-cpu/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, in any of
four formats: unified diffs (even with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and text-editor tool calls as JSON. Every file is changed
or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file; when absent or `-`, the patch is read from
  standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` applied, `1` some edits failed (each reported, nothing
written), `2` usage / missing patch / unknown format / parse error.

## Matching

Old lines are found at the first of three tiers where they occur: exact,
then ignoring trailing spaces and tabs, then ignoring leading and trailing
spaces and tabs (re-indenting the new lines). A context line is always written
as the file's own line.

## Requirements

Node 22, standard library only. No dependencies, no network, deterministic.
