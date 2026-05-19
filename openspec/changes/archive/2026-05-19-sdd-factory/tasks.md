## 1. Author the factory

- [x] 1.1 Create `examples/sdd.yaml` with the four nodes (`propose`, `apply`, `verify`, `archive`), `archive` marked `terminal: true`, all nodes using `executor: claude` and a placeholder `cwd`
- [x] 1.2 Add the four edges in `examples/sdd.yaml`: `propose → apply`, `apply → verify`, `verify → archive` (all defaulting to `on_success`), and `verify → apply` with `when: "on_failure"` and `max_traversals: 3`
- [x] 1.3 Write each node's `with.prompt` so it fulfills the per-node contract in `specs/sdd-factory/spec.md` — propose drives `openspec new change` + writes artifacts + `openspec validate`; apply works `tasks.md`; verify runs the target repo's test/build/check; archive runs `openspec archive`. Use a `<CHANGE_NAME>` placeholder users edit per copy
- [x] 1.4 Confirm `loadFactory("examples/sdd.yaml")` succeeds and resolves `propose` as the sole start node, `archive` as the sole terminal, and the `verify → apply` cycle as covered by the edge budget

## 2. Document the factory

- [x] 2.1 Create `examples/sdd.md` documenting each node's contract: responsibility, OpenSpec CLI commands invoked, success/failure signal, and what `ctx.history` each node receives
- [x] 2.2 In `examples/sdd.md`, document the copy-and-edit workflow explicitly: copy `sdd.yaml` to `sdd-<changename>.yaml`, replace `<CHANGE_NAME>` in every prompt, set each node's `cwd` to the target repo
- [x] 2.3 In `examples/sdd.md`, note the deferred friction (factory-level `cwd:`, templating, native `shell` executor) so readers know it's not an oversight

## 3. Update the README

- [x] 3.1 In `README.md`'s "Run the example" section, add a subsection for `examples/sdd.yaml` that names the two edits required (change name in prompts, per-node `cwd`) and links to `examples/sdd.md`
- [x] 3.2 Confirm the README still accurately describes `hello.yaml` as the trivial starter and `sdd.yaml` as the SDD-workflow example

## 4. Test the factory's shape

- [x] 4.1 Add a test (alongside the existing factory loader tests) that calls `loadFactory("examples/sdd.yaml")` and asserts: four nodes by id, four edges with the documented `when` values, `verify → apply` has `max_traversals === 3`, `archive.terminal === true`, no other node terminal, no other budgets declared
- [x] 4.2 Add an assertion (or a second test) confirming the resolved start-node set is exactly `{propose}`
- [x] 4.3 Run `npm test` to confirm new and existing tests pass

## 5. Validate

- [x] 5.1 Run `openspec validate sdd-factory` and confirm clean
- [x] 5.2 Run `npm run build` and `npm run check` to confirm the repo still passes verify locally
