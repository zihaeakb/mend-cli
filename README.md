# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zihaeakb/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zihaeakb/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and `mend` reads all four to one written specification (`SPEC.md`),
finds the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is
  relative to it.
- `PATCH` is the patch file, relative to the working directory. When absent
  or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

Old lines are found at the first of three tiers at which they occur at least
once: exact, then ignoring trailing spaces/tabs, then ignoring leading and
trailing spaces/tabs. Unified hunks take the occurrence nearest their stated
line number; SEARCH/REPLACE blocks require exactly one occurrence; V4A
chunks take the first occurrence at or after the cursor (after their anchor,
when one is given).

## Exit codes and output

- `0`: the tree is written; one line per changed path (`A`, `D`, `M`, or `R`
  for a move), then `ok: <n> files`.
- `1`: nothing is written; one `error: <code> <path>` line per failed edit,
  then `failed: <k> of <n> edits`.
- `2`: nothing is written; exactly one line — `error: usage`, `error:
  no-patch`, `error: format`, or `error: parse <N>`.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the trial runner from the kit; keep as is.
- `check.ts` — runs `main.ts` on the practice set:
  `node check.ts <practice.json>`.
- `SPEC.md` — the full specification.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9v4hjgyv&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
