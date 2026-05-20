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

> **Migration note for old copies.** If you copied `examples/sdd.yaml`
> before the `sdd-factory-uses-claude-controls` change, your copy will
> run today but report `succeeded` on every node while doing no actual
> work — the spawned `claude` sessions cannot write files or run
> side-effecting Bash under the CLI's default permission policy, and
> the prompts use the older "Exit 0 / non-zero" signaling that the
> runner no longer relies on. To migrate, make two edits per node:
> add `permission_mode: "bypass_permissions"` to each `with:` block,
> and rewrite each prompt's success/failure language to instruct the
> model on the `MINIFAC_STATUS` sentinel (see "Status signaling"
> below). The binding contract lives in
> `openspec/specs/sdd-factory/spec.md`.

> **Migration note for old copies (archive commit).** If you copied
> `examples/sdd.yaml` before the `sdd-factory-archive-commits`
> change, your archive node will run `openspec archive <CHANGE_NAME>`
> cleanly and emit `MINIFAC_STATUS: succeeded`, but it will leave
> the resulting moves and spec folds uncommitted in your target
> repo's working tree. The fix is one edit: rewrite the archive
> node's prompt so that, after `openspec archive` exits 0 and before
> the sentinel, it runs `git add -A` followed by
> `git commit -m "Archive: <CHANGE_NAME>"` (with a short body and
> the `Co-Authored-By:` trailer). Treat a commit failure as a node
> failure. The binding contract lives in
> `openspec/specs/sdd-factory/spec.md`; the shipped
> `examples/sdd.yaml` is the reference implementation.

> **Migration note for old copies (sentinel boilerplate).** If you
> copied `examples/sdd.yaml` before the `runner-sentinel-injection`
> change, your copy will carry a `## Status signaling` block at the
> end of every node's prompt. Those blocks are now redundant — the
> runner auto-injects the same instructions before sending the
> prompt to the CLI. You can delete the block from every node; the
> per-node responsibility prose stays. Existing copies that still
> carry the block continue to work (the model sees the redundant
> instructions twice, which is harmless), so the migration is
> aesthetic, not correctness-driven. The binding contract lives in
> `openspec/specs/node-executor/spec.md` (requirement: "Status
> signaling via sentinel marker") and
> `openspec/specs/sdd-factory/spec.md`.

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
- **Success criterion:** `openspec validate <CHANGE_NAME>` exits 0
  and every required artifact (proposal, design, spec deltas, tasks)
  is on disk.
- **Failure criterion:** validate could not be made clean, or a
  required artifact could not be written. The failure description
  should name the unresolved validation error.

### apply

- **Inputs:** propose's output via `ctx.history`. On a retry, verify's
  failure output is also in history.
- **Invokes:** reads `openspec/changes/<CHANGE_NAME>/tasks.md`, works
  each unchecked `- [ ]`, marks them `- [x]`. May run local
  lints/builds as it goes.
- **Success criterion:** every checkbox in `tasks.md` is `- [x]`.
- **Failure criterion:** a task is structurally blocked (for example,
  it requires a schema change not in the proposal). The failure
  description should name the blocking task. There is no
  `apply → propose` recovery edge — failure here ends the run.

### verify

- **Inputs:** propose + apply output via `ctx.history`.
- **Invokes:** the target repo's verify commands in `cwd`. For most
  Node/TS repos that is `npm test`, `npm run build`,
  `npm run check`. Then `openspec validate <CHANGE_NAME>` once more.
- **Success criterion:** every verify command exits 0 (and
  `openspec validate <CHANGE_NAME>` is still clean).
- **Failure criterion:** any verify command exits non-zero. The
  failure description must name the failing command and the
  diagnosable output — the next `apply` iteration reads that text
  out of `ctx.history`, so make it actionable. Failure routes back
  to `apply` on the `verify → apply` edge (`when: on_failure`,
  `max_traversals: 3`). After three retries the budget is exhausted
  and the run ends as `failed`.

### archive

- **Inputs:** full prior run via `ctx.history`.
- **Invokes (in strict order):**
  1. `openspec archive <CHANGE_NAME>`.
  2. If and only if step 1 exited 0, `git add -A` followed by
     `git commit -m "Archive: <CHANGE_NAME>"` with a 2–3 line body
     summarising which capability specs were folded and which change
     directory was moved into `openspec/changes/archive/`, plus the
     repo-standard `Co-Authored-By: Claude Opus 4.7 (1M context)
     <noreply@anthropic.com>` trailer.

  The commit step is part of the node's contract, not an
  afterthought: `openspec archive` rewrites files on disk and moves
  the change directory, but it does not stage or commit. Without the
  commit, a successful run leaves the target repo's working tree
  dirty for the next loop to inherit and a human to disentangle.
- **Does not invoke:** `git push`. The factory never pushes; that is
  a human decision.
- **Success criterion:** both `openspec archive <CHANGE_NAME>` and
  the subsequent `git commit` exit 0. This is the terminal node —
  success ends the run.
- **Failure criterion:** either step exits non-zero. The failure
  description should name which step (`openspec archive` or
  `git commit`) failed, and the relevant error. The failure path
  covers both `openspec archive` errors and `git commit` errors
  (e.g. a target-repo pre-commit hook rejecting the commit). A hook
  rejection at this stage is a human concern — there is no
  `on_failure` edge from `archive` and adding one would be the
  wrong fix.

## Status signaling

Each node's status is communicated by a `MINIFAC_STATUS:` sentinel
emitted as the final line of the model's final assistant message.
The `claude` executor parses the sentinel out of the stream-json
`result` event; the sentinel beats the CLI exit code in both
directions (a `succeeded` sentinel with a non-zero exit reports
`succeeded`; a `failed` sentinel with a zero exit reports `failed`).
If no sentinel is found, the executor falls back to exit-code
semantics, but the SDD factory does not rely on that fallback.

**The runner owns the mechanics.** The `claude` executor
auto-injects a canonical sentinel-emission instruction block into
every outgoing prompt before sending it to the CLI. Factory authors
do NOT re-state the regex, the literal endings, or the
"must-be-last" rule in their YAML prompts. Each node's prompt only
declares its per-node success and failure *criteria* (e.g. "every
verify command exits 0").

For reference, the executor matches this regex against the final
`result` field:

```
/^MINIFAC_STATUS:[ \t]*(succeeded|failed)\b[ \t]*(?:\r?\nREASON:[ \t]*(.*))?/m
```

The two literal acceptable endings are:

```
MINIFAC_STATUS: succeeded
```

and

```
MINIFAC_STATUS: failed
REASON: schema validation failed for required field 'verify-mode'
```

If you author a custom node prompt, you don't need to add a
sentinel-instructions block — the runner appends one for you. If you
explicitly opt out via `emit_sentinel_instructions: false` in the
node's `with:` block, then teaching the model to emit the marker
becomes your responsibility (response-side parsing is unaffected by
the knob).

## Security posture

Every spawned `claude` session runs with
`permission_mode: "bypass_permissions"`, which grants the session full
authority inside its resolved `cwd`: `Write`, `Edit`, and side-effecting
`Bash` invocations are auto-approved without prompting. This is the
posture the four SDD nodes actually need — `propose` writes the
change artifacts, `apply` edits arbitrary files in the target repo,
`verify` runs `npm test` / `npm run build` / `openspec validate`,
and `archive` runs `openspec archive`.

The security model is **user-trust-cwd**:

- The user chose the `cwd`. The factory grants full authority inside
  it; the user is responsible for pointing the factory at a directory
  whose contents they accept full-authority edits to.
- The prompts ship in this repo and are readable before invocation —
  there is no remote prompt-injection vector in the shipped factory.
- The field is literally named `bypass_permissions`. Anyone copying
  the factory and reading the YAML can see the posture.

Downstream copies are free to tighten this — e.g. set
`permission_mode: "accept_edits"` and supply an `allowed_tools`
allowlist appropriate to the target repo (typically including
`Bash(openspec:*)`, `Bash(npm:*)`, `Bash(git:*)`, and whatever else
your verify commands invoke). The shipped template does not maintain
such an allowlist because keeping it correct as the OpenSpec CLI and
verify commands evolve would be a maintenance tax not worth paying for
a template the user is expected to read and copy.

## Fields users edit when copying

The two required edits, repeated across four nodes:

1. **`<CHANGE_NAME>` in each node's prompt.** Eight references (two per
   prompt on average). A find-and-replace across the YAML is the
   intended workflow.
2. **`cwd` on each of the four nodes.** All four should resolve to the
   same absolute path — the target repo.

One optional, advanced edit:

3. **`permission_mode` on each node's `with:` block.** The shipped
   template sets this to `"bypass_permissions"`, which grants the
   spawned session full authority inside `cwd` (see "Security posture"
   above). Downstream copies that want a tighter posture can lower it
   to `"accept_edits"` and add an `allowed_tools` allowlist
   appropriate to their target repo. Don't lower it without supplying
   the allowlist — `accept_edits` still gates side-effecting `Bash`,
   so an unconfigured `verify` node will fail on `npm test`.

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
