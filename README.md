[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/faridzafrizal01-ui/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/faridzafrizal01-ui/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format. mend applies an edit that an AI model wrote to a tree of
text files, reading all four formats models actually produce:

- unified diffs, including hunks whose line numbers are wrong (they are matched by content, at
  three loosening tiers, nearest to where the header says they belong);
- SEARCH/REPLACE blocks;
- V4A patches (`*** Begin Patch` … `*** End Patch`);
- text-editor tool calls as JSON, one object or a JSON array.

Every edit in a patch is checked against the tree as the earlier edits left it, and the patch is
atomic: when any edit fails, nothing is written and every failure is reported, one line each.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`--check` reports exactly what would change without writing; `--strict` matches lines exactly.
The full contract is [SPEC.md](SPEC.md). An entry for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Layout

- `main.ts` — the mend CLI itself (Node 22, standard library only).
- `runner.ts` — the make.fun trial runner, kept as the kit ships it; `main.ts` hands over to it
  when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs the kit's public practice set against this build.
- `SPEC.md` — the specification mend implements.

MIT licensed.
