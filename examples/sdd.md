# sdd.yaml — the SDD factory

This is the canonical Spec-Driven Development factory. It encodes the
`propose → apply → verify → archive` loop that minifac itself uses, as
a runnable graph of `claude` nodes.

```
propose ──▶ apply ──▶ verify ──▶ archive (terminal)
              ▲           │
              └── on_failure
                  (max_traversals: 3)
```

## How to use it

The shipped file is a **template**, not a runnable singleton. Running
`minifac run examples/sdd.yaml` unedited is not the intended workflow —
you'll get prompts that talk about a literal change called
`<CHANGE_NAME>` and a `cwd` pointing at `/path/to/target/repo`.

To use it on a real change:

1. Copy `examples/sdd.yaml` to something like `sdd-my-change.yaml`
   (anywhere on your machine; `minifac run` takes a path).
2. Replace every occurrence of `<CHANGE_NAME>` in the file with the
   real change name (e.g. `add-shell-executor`). It appears inside
   each node's `prompt`.
3. Set every node's `cwd` to the absolute path of the target repo.
   All four nodes need the same value (see "Friction" below).
4. Run `minifac run path/to/sdd-my-change.yaml`.

The target repo must have OpenSpec installed and the relevant verify
commands wired up (typically `npm test`, `npm run build`,
`npm run check`).

## Per-node contract

Each node is binding at the contract level — responsibility, OpenSpec
CLI commands invoked, and the success/failure signal. The prompt text
is implementation; rewrite it however you like as long as the contract
holds. The binding version lives in
`openspec/specs/sdd-factory/spec.md`.

### propose

- **Inputs:** the change name and rough intent (carried in the prompt
  itself, edited per copy).
- **Invokes:** `openspec new change <CHANGE_NAME>`, then writes
  `proposal.md`, `design.md`, spec deltas, `tasks.md`. Drives
  `openspec validate <CHANGE_NAME>` until clean.
- **Success signal:** node exits 0; validate is clean.
- **Failure signal:** node exits non-zero with a message naming the
  unresolved validation error.

### apply

- **Inputs:** propose's output via `ctx.history`. On a retry, verify's
  failure output is also in history.
- **Invokes:** reads `openspec/changes/<CHANGE_NAME>/tasks.md`, works
  each unchecked `- [ ]`, marks them `- [x]`. May run local
  lints/builds as it goes.
- **Success signal:** every checkbox in `tasks.md` is `- [x]`; node
  exits 0.
- **Failure signal:** node exits non-zero with a message identifying
  the blocking task. There is no `apply → propose` recovery edge —
  failure here ends the run.

### verify

- **Inputs:** propose + apply output via `ctx.history`.
- **Invokes:** the target repo's verify commands in `cwd`. For most
  Node/TS repos that is `npm test`, `npm run build`,
  `npm run check`. Then `openspec validate <CHANGE_NAME>` once more.
- **Success signal:** every verify command exits 0; node exits 0.
- **Failure signal:** any verify command exits non-zero; node exits
  non-zero, output names the failing command. Failure routes back to
  `apply` on the `verify → apply` edge (`when: on_failure`,
  `max_traversals: 3`). After three retries the budget is exhausted
  and the run ends as `failed`.

### archive

- **Inputs:** full prior run via `ctx.history`.
- **Invokes:** `openspec archive <CHANGE_NAME>`.
- **Success signal:** archive exits 0; node exits 0. This is the
  terminal node — success ends the run.
- **Failure signal:** node exits non-zero, names the archive error.

## Fields users edit when copying

Exactly two, repeated across four nodes:

1. **`<CHANGE_NAME>` in each node's prompt.** Eight references (two per
   prompt on average). A find-and-replace across the YAML is the
   intended workflow.
2. **`cwd` on each of the four nodes.** All four should resolve to the
   same absolute path — the target repo.

Everything else (topology, budgets, executor) is binding and is
covered by the spec.

## Friction (known and deferred)

These are real friction points with the v0 design. Each is deferred to
its own future proposal so it gets the scope it deserves:

- **Factory-level `cwd:` default.** Setting the same `cwd` on every
  node is repetitive. A top-level `cwd:` with node-level override
  would clean it up, but it introduces resolve-order and override
  precedence questions that earn their own proposal.
- **Templating (`--var change=<name>`).** A real variable-substitution
  mechanism would remove the find-and-replace step. It's a feature
  with syntax, escaping rules, and per-field opt-in/opt-out
  decisions — also its own proposal.
- **Native `shell` executor for verify.** Running `npm test` via a
  `claude` node is slower and noisier than spawning a process. A
  `shell` executor would be a drop-in replacement at this node: change
  `executor: claude` to `executor: shell`, swap the `with:` shape, no
  topology change. That's a `node-executor` proposal.
- **Remote-CI watch verify mode.** A future change could add an
  opt-in mode that pushes the branch and polls GitHub Actions (or
  equivalent) instead of running locally — useful when the only true
  gate is the remote pipeline. It must remain opt-in; many factories
  will run on repos with no CI at all.

If any of those start blocking you for real work, that's the signal to
open a proposal — not before.
