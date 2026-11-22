# mend — one patch tool for every AI edit format

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Buruhcrypto777/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Buruhcrypto777/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. It reads
a patch in one of four formats — unified diff, SEARCH/REPLACE blocks, V4A, or
JSON edits — finds the lines each edit names at the first of three matching
tiers, and writes every change or none.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
Referral: https://make.fun/r/1dmvtzwc

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- PATCH is the path of the patch file, relative to the working directory.
  When PATCH is absent or is `-`, the patch is read from standard input.

Node 22, standard library only. No install, no package, no native addon.
