## 1. Update `examples/sdd.yaml`

- [x] 1.1 Rewrite the `archive` node's prompt so it instructs the model in this strict order: (a) run `openspec archive <CHANGE_NAME>`; (b) if and only if step (a) exits 0, run `git add -A` followed by `git commit -m "Archive: <CHANGE_NAME>"` with a 2–3 line body summarising what was folded into canonical specs and which change directory was moved, plus a trailing `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` line; (c) if both succeed, emit `MINIFAC_STATUS: succeeded`; otherwise emit `MINIFAC_STATUS: failed` with a `REASON:` line naming the failing step. The prompt SHALL NOT mention `git push`.
- [x] 1.2 Confirm no other node's prompt changes. `propose`, `apply`, and `verify` remain byte-identical to the pre-change shipped file.

## 2. Update `examples/sdd.md`

- [x] 2.1 In the "Per-node contract" section under the `archive` heading, document the commit step: subject line `Archive: <CHANGE_NAME>`, 2–3 line body, `Co-Authored-By:` trailer; ordering (archive → commit → sentinel); and the rule that a failed commit yields `MINIFAC_STATUS: failed`.
- [x] 2.2 In the "Status signaling" section (or wherever the archive node's success/failure shapes are documented), note that the success path requires both `openspec archive <CHANGE_NAME>` and the subsequent `git commit` to exit 0.
- [x] 2.3 Add a one-paragraph migration note for users who copied `examples/sdd.yaml` before this change. Their archive node will continue to leave the archive moves uncommitted; the fix is to rewrite the archive prompt to add the `git commit` step. The note can sit alongside the existing pre-this-change migration paragraph.

## 3. Update `src/factory/sdd-example.test.ts`

- [x] 3.1 Add a test asserting that the `archive` node's prompt (`factory.nodes.archive.with.prompt`, treated as a string) contains the literal substring `git commit`.
- [x] 3.2 Add a test asserting that the same prompt contains the literal substring `Archive:` (with the colon), pinning the subject-line convention.
- [x] 3.3 Keep the existing eight tests passing without behavioral changes; only add the two new assertions.

## 4. Validate

- [x] 4.1 Run `npm test` from the repo root; all factory tests pass.
- [x] 4.2 Run `openspec validate sdd-factory-archive-commits` from the repo root; the change validates clean.
- [x] 4.3 Re-read `examples/sdd.yaml` end-to-end and confirm the archive prompt: (a) names `openspec archive <CHANGE_NAME>` as step 1; (b) names `git add -A && git commit -m "Archive: <CHANGE_NAME>"` as step 2, conditional on step 1 exiting 0; (c) routes both `openspec archive` failure and `git commit` failure to `MINIFAC_STATUS: failed` with diagnostic `REASON:` lines; (d) does not mention `git push`.
- [x] 4.4 Re-read `examples/sdd.md` end-to-end and confirm the archive section documents the commit step (subject convention + ordering + failure mode) and a migration paragraph addresses pre-change copies.
