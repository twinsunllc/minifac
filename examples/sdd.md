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

The SDD factory is **brief-driven**. You don't edit `examples/sdd.yaml`
per change; instead you author a brief at `inputs/<change-name>.md`
and invoke the factory by name.

**Authoring the brief.** The fastest way to start a new change is
the brief-authoring helper: run `minifac brief <change-name>` from
the terminal (or `/brief <change-name>` in Claude Code) and it
walks you one question at a time through the canonical schema,
writing `inputs/<change-name>.md` when you're done. The CLI verb
also supports `--from <file>` for scripted (YAML/JSON) answers.
You can also hand-edit the file in any editor — see
[`sample-brief.md`](./sample-brief.md) for the shape.

Once the brief exists:

1. Author `inputs/<change-name>.md`. Frontmatter must declare
   `change: <change-name>` and `factory: sdd`; the body is free-form
   markdown describing what the change should do. See
   [`sample-brief.md`](./sample-brief.md) for the canonical shape.
2. Invoke `minifac run <change-name>`. The CLI's lookup precedence
   resolves the bare name to `inputs/<change-name>.md`, loads the
   brief, resolves `factory: sdd` to `examples/sdd.yaml`, and runs
   the factory with the brief in scope.
3. The runner substitutes `{{ brief.change }}` (the change name) and
   `{{ brief.body }}` (the brief body) into the node prompts before
   dispatch.

The target repo (whichever directory each node's `cwd` points at) must
have OpenSpec installed and the relevant verify commands wired up
(typically `npm test`, `npm run build`, `npm run check`).

### Worktree-by-default

`minifac run <change>` creates a fresh git worktree at
`~/.minifac/worktrees/<repo-hash>-<change>/`, branches off
`base_branch` from the brief (defaulting to caller's `HEAD`), and runs
every node inside it. Each node's `cwd: "{{ run.cwd }}"` resolves to
the worktree path automatically, so the shipped factory does not
hard-code any target path. The branch and worktree are left in place
when the run ends — review and merge the branch like any other
contributor's; reclaim disk with `minifac prune` when you're done.

For CI environments, read-only factories, or when you want the factory
to run inside your existing checkout, pass `--in-place` (or set
`mode: in-place` in the brief frontmatter). That skips worktree
creation; the factory runs in `process.cwd()`.

> **Migration from pre-`factory-inputs-core` copies.** If you have a
> hand-copied `sdd-<name>.yaml` from before the `factory-inputs-core`
> change, you have two options:
>
> 1. Delete your copy and use the shipped `examples/sdd.yaml`. Author
>    a brief at `inputs/<name>.md` and invoke `minifac run <name>`.
>    This is the intended workflow.
> 2. Convert your copy in place: replace every `<CHANGE_NAME>` with
>    `{{ brief.change }}`, add `brief: required` at the top level, and
>    author a brief alongside. Invoke it by brief path
>    (`minifac run path/to/your/brief.md`).
>
> Direct factory-YAML invocation (`minifac run examples/sdd.yaml`) is
> no longer supported. The binding contract lives in
> `openspec/specs/sdd-factory/spec.md`.

## Per-node contract

Each node is binding at the contract level — responsibility, OpenSpec
CLI commands invoked, and the success/failure signal. The prompt text
is implementation; rewrite it however you like as long as the contract
holds. The binding version lives in
`openspec/specs/sdd-factory/spec.md`.

### propose

- **Inputs:** the change name (`{{ brief.change }}`) and the brief
  body (`{{ brief.body }}`), both substituted into the prompt at
  dispatch time by the runner.
- **Invokes:** `openspec new change {{ brief.change }}`, then writes
  `proposal.md`, `design.md`, spec deltas, `tasks.md`. Drives
  `openspec validate {{ brief.change }}` until clean.
- **Success criterion:** `openspec validate {{ brief.change }}` exits
  0 and every required artifact (proposal, design, spec deltas, tasks)
  is on disk.
- **Failure criterion:** validate could not be made clean, or a
  required artifact could not be written. The failure description
  should name the unresolved validation error.

### apply

- **Inputs:** propose's output via `ctx.history`. On a retry, verify's
  failure output is also in history.
- **Invokes:** reads `openspec/changes/{{ brief.change }}/tasks.md`,
  works each unchecked `- [ ]`, marks them `- [x]`. May run local
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
  `npm run check`. Then `openspec validate {{ brief.change }}` once
  more.
- **Success criterion:** every verify command exits 0 (and
  `openspec validate {{ brief.change }}` is still clean).
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
  1. `openspec archive {{ brief.change }}`.
  2. If and only if step 1 exited 0, `git add -A` followed by
     `git commit -m "Archive: {{ brief.change }}"` with a 2–3 line
     body summarising which capability specs were folded and which
     change directory was moved into `openspec/changes/archive/`,
     plus the repo-standard
     `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
     trailer.

  The commit step is part of the node's contract, not an
  afterthought: `openspec archive` rewrites files on disk and moves
  the change directory, but it does not stage or commit. Without the
  commit, a successful run leaves the target repo's working tree
  dirty for the next loop to inherit and a human to disentangle.
- **Does not invoke:** `git push`. The factory never pushes; that is
  a human decision.
- **Success criterion:** both `openspec archive {{ brief.change }}`
  and the subsequent `git commit` exit 0. This is the terminal
  node — success ends the run.
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

## Fields the brief supplies

The brief supplies what used to be hand-edits:

1. **`{{ brief.change }}`** — the change name. The brief's frontmatter
   `change:` field is substituted everywhere `{{ brief.change }}`
   appears in any node's `prompt`.
2. **`{{ brief.body }}`** — the brief's markdown body, dropped into
   the propose node's `## Intent for this change` section. This is
   how per-change intent reaches the propose prompt without
   per-change YAML edits.

The per-node `cwd` is the template `"{{ run.cwd }}"` — the runner
substitutes the worktree path it created for this run. Brief-less
factory invocations get a generated worktree key
(`<repo-hash>-<factory>-<timestamp>`) so distinct runs don't collide.

Everything else (topology, budgets, executor, permission mode) is
binding and is covered by the spec.

## Template tokens

The runner reserves the following `{{ brief.<field> }}` tokens for
substitution inside any node `with.prompt`:

| Token                     | Source                            |
|---------------------------|-----------------------------------|
| `{{ brief.change }}`      | brief frontmatter `change:`       |
| `{{ brief.body }}`        | brief body (markdown after fence) |
| `{{ brief.factory }}`     | brief frontmatter `factory:`      |
| `{{ brief.base_branch }}` | brief frontmatter `base_branch:` (empty when absent) |
| `{{ brief.model }}`       | brief frontmatter `model:` (empty when absent)       |

The runner also resolves the `run.*` namespace. v0 ships one field:

| Token             | Source                                                 |
|-------------------|--------------------------------------------------------|
| `{{ run.cwd }}`   | the worktree path (or `process.cwd()` under `--in-place`) |

Substitution applies to both `with.prompt` AND `cwd`. Unknown
identifiers under any known namespace pass through verbatim (no
substitution, no error) — room for future fields without surprising
existing factories.

## Friction (known and deferred)

These are real friction points with the v0 design. Each is deferred to
its own future proposal so it gets the scope it deserves:

- **Factory-level `cwd:` default.** Every shipped node currently sets
  `cwd: "{{ run.cwd }}"`, which is repetitive. A top-level `cwd:` with
  node-level override would clean it up, but it introduces
  resolve-order and override precedence questions that earn their own
  proposal.
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

## Customizing the SDD factory for your repo

The built-in SDD factory is one shape that works for minifac itself.
Your repo probably runs verify a different way (`bun test`, `pytest`,
`cargo test`, etc.). Rather than copying the whole YAML, extend it.

1. From your repo root, run `minifac init` to create `inputs/`,
   `.minifac/`, and `.minifac/factories/`. Add `--with-sdd` to get a
   starter `.minifac/factories/sdd.yaml` you can edit.
2. Edit `.minifac/factories/sdd.yaml`. Keep the `extends:
   "minifac:sdd"` line at the top and redeclare only the node(s) you
   want to change. See `docs/concepts/Factory.md` for the worked
   example.

How `factory:` resolves from a brief:

- `factory: sdd` → tries `.minifac/factories/sdd.yaml` first, falls
  back to the built-in (`examples/sdd.yaml`). Use this for the normal
  case: your customizations apply automatically.
- `factory: minifac:sdd` → always the built-in, skipping any local
  override. Use this when a specific brief needs the canonical loop
  regardless of repo customizations.

The override is **replace-at-node-level**: redeclaring `verify`
replaces the whole node from the base, not just the field you want to
change. Copy the base's `with.permission_mode` / `allowed_tools` /
etc. into your override if you still need them.
