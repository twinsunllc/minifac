## 1. Update `examples/sdd.yaml`

- [ ] 1.1 Add `permission_mode: "bypass_permissions"` to the `with:` block of the `propose` node.
- [ ] 1.2 Add `permission_mode: "bypass_permissions"` to the `with:` block of the `apply` node.
- [ ] 1.3 Add `permission_mode: "bypass_permissions"` to the `with:` block of the `verify` node.
- [ ] 1.4 Add `permission_mode: "bypass_permissions"` to the `with:` block of the `archive` node.
- [ ] 1.5 Rewrite the `propose` prompt: drop the "Exit 0 when validate is clean. Exit non-zero..." paragraph and replace it with an instruction that the final assistant text MUST end with `MINIFAC_STATUS: succeeded` when `openspec validate <CHANGE_NAME>` is clean, or `MINIFAC_STATUS: failed\nREASON: <single line>` naming the unresolved validation error otherwise. Keep all responsibility text (scaffold + write artifacts + validate) intact.
- [ ] 1.6 Rewrite the `apply` prompt similarly: drop the "Exit 0 only when every checkbox..." paragraph; instruct the model to emit `MINIFAC_STATUS: succeeded` only when every `tasks.md` checkbox is `- [x]`, or `MINIFAC_STATUS: failed\nREASON:` naming the blocking task. Keep responsibility text intact.
- [ ] 1.7 Rewrite the `verify` prompt similarly: drop the "Exit 0 only if every command exits 0. Exit non-zero..." paragraph; instruct the model to emit `MINIFAC_STATUS: succeeded` only when every verify command exits 0, or `MINIFAC_STATUS: failed\nREASON:` naming the failing command and including relevant output. Keep responsibility text intact (run the target repo's verify commands, then `openspec validate` once more).
- [ ] 1.8 Rewrite the `archive` prompt similarly: drop the "Exit 0 on a clean exit; exit non-zero..." paragraph; instruct the model to emit `MINIFAC_STATUS: succeeded` only when `openspec archive <CHANGE_NAME>` exits clean, or `MINIFAC_STATUS: failed\nREASON:` naming the archive error. Keep responsibility text intact.

## 2. Update `examples/sdd.md`

- [ ] 2.1 In the "Per-node contract" section, replace each node's "Success signal: ... exits 0" and "Failure signal: ... exits non-zero" lines with the sentinel-based contract: "Success signal: emits `MINIFAC_STATUS: succeeded`" / "Failure signal: emits `MINIFAC_STATUS: failed` with a `REASON:` line." Keep all other contract text unchanged.
- [ ] 2.2 In the "Fields users edit when copying" section, mention `permission_mode` as a field that the shipped template sets to `bypass_permissions` and that downstream copies may want to lower (with the caveat that lowering it requires supplying an `allowed_tools` allowlist appropriate to the target repo). Frame this as an optional advanced edit, not one of the two required edits.
- [ ] 2.3 Add a new top-level section titled "Status signaling" between "Per-node contract" and "Fields users edit when copying" (or just before "Friction" — pick whichever reads better). The section SHALL document the sentinel contract end-to-end: the exact regex (lifted from the `node-executor` spec), the success and failure shapes (`MINIFAC_STATUS: succeeded` on one line; `MINIFAC_STATUS: failed` followed by `REASON: ...` on the next line), and a copy-paste block that custom-prompt authors can drop at the end of any node prompt to remain compliant.
- [ ] 2.4 Add a new top-level section titled "Security posture" (after "Status signaling" or near the top — pick whichever reads better). The section SHALL document the user-trust-cwd framing: every spawned session runs with `permission_mode: "bypass_permissions"`, which grants full authority inside the resolved `cwd`; the user is responsible for pointing the factory at a directory they accept full-authority edits to; the prompts ship in this repo and are readable before invocation. Call out that downstream copies that lower the permission mode must supply their own `allowed_tools` allowlist.
- [ ] 2.5 Add a migration paragraph (one paragraph; the bottom of the document is fine, or under "Friction") that addresses users who copied `examples/sdd.yaml` before this change: their copies will silently report `succeeded` while doing no work. The fix is two edits per node — add `permission_mode: "bypass_permissions"` to each `with:` block, and update each prompt's success/failure language to instruct the model on the `MINIFAC_STATUS` sentinel.

## 3. Update `src/factory/sdd-example.test.ts`

- [ ] 3.1 Add a test asserting that each of the four nodes (`propose`, `apply`, `verify`, `archive`) declares `with.permission_mode === "bypass_permissions"`.
- [ ] 3.2 Add a test asserting that each of the four node prompts (`with.prompt`, treated as a string) contains the literal substring `MINIFAC_STATUS`.
- [ ] 3.3 Keep the existing six tests passing without behavioral changes; only add the two new assertions.

## 4. Validate

- [ ] 4.1 Run `npm test` from the repo root; all factory tests pass.
- [ ] 4.2 Run `openspec validate sdd-factory-uses-claude-controls` from the repo root; the change validates clean.
- [ ] 4.3 Re-read `examples/sdd.yaml` end-to-end and confirm: (a) every node has `permission_mode: "bypass_permissions"`, (b) every prompt contains `MINIFAC_STATUS`, (c) no prompt still uses "Exit 0" / "Exit non-zero" as the success/failure signaling language.
- [ ] 4.4 Re-read `examples/sdd.md` end-to-end and confirm the "Status signaling", "Security posture", and migration sections are present and the per-node contract section uses sentinel language.
