## Context

`hello.yaml` exercises the schema with one node and zero edges. That's
enough to prove the toolchain runs end-to-end but not enough to exercise
the load-bearing v0 design decisions: cycles, failure routing,
multi-node history pass-through, per-node `cwd`, and edge budgets.

minifac already uses the SDD workflow (`/opsx:propose` → `/opsx:apply`
→ verify → `/opsx:archive`) by hand. Encoding that as a factory does two
things at once: it gives anyone with OpenSpec a working SDD runner they
can point at any repo, and it gives minifac a real second example that
stresses every v0 feature the runner ships with.

Constraints carried in:

- v0 only. The only executor is `claude`. The factory must run today
  without new runners, no daemon, no storage adapters.
- Snake_case YAML keys.
- No anthropomorphic metaphors in user-facing docs — nodes are nodes.
- Zero new dependencies; preferably zero changes to the canonical
  factory/runner/executor specs.

## Goals / Non-Goals

**Goals:**

- Ship `examples/sdd.yaml` that loads, validates, and runs end-to-end
  against an OpenSpec-equipped target repo using only the v0 `claude`
  executor.
- Document each node's contract (inputs, OpenSpec CLI commands invoked,
  success signal) precisely enough that the prompts can be rewritten
  without re-litigating the design.
- Exercise the cycle / failure-routing / budget machinery at least once
  in the shipped examples.
- Make zero changes to the canonical schema, runner, or executor specs
  if it can be avoided.

**Non-Goals:**

- Introducing a `shell` executor. Verify uses `claude` with tool access
  to invoke the test/build/check commands in the target repo. A native
  `shell` executor is its own change.
- Introducing factory templating (`--var change=<name>`) or a
  factory-level `cwd:` default. Both are noted as friction; both are
  deferred to their own changes when the second consumer exists.
- Running this factory against minifac as a release gate (CI / on
  push). It ships as a working example; orchestration is a separate
  concern.
- Specifying full prompt text. Prompts are implementation. This design
  fixes the *contract* (what each node must accomplish, what it
  invokes, what it must emit).

## Decisions

### Decision: Verify is a `claude` node, not a new `shell` executor

The verify step needs to run `npm test && npm run build && npm run
check` (or the target repo's equivalent) and report pass/fail. The
obvious-shaped thing is a `shell` executor — one process spawn, one
exit code.

Today's `claude` executor already has tool access in `cwd`. A
`claude` node prompted to run those commands and report status is
sufficient. It is slower and noisier than a dedicated `shell` runner,
but it works on v0 without touching the schema or executor registry.

**Choice:** `claude` for verify. Document the verify node's prompt
contract clearly so that a future `shell` executor is a drop-in
replacement: change `executor: claude` to `executor: shell`, swap the
`with:` shape, no topology change.

**Alternatives considered:** Add a `shell` executor in this change.
Rejected — that would bundle two changes (schema/executor surface +
ship the example) into one proposal. The CLAUDE.md anti-goal "no
premature subsystems" applies: ship the example first; let the
friction of running verify-via-claude motivate the shell executor
when (if) it's worth the spec dance.

### Decision: One factory per change, copy `sdd.yaml` per use

The factory has to know which change name to act on (`propose` writes
to `openspec/changes/<name>/`; `apply` reads from there; verify
expects that change's artifacts; archive folds it in).

Options:

- (a) Hard-code one change name per copy of the YAML.
- (b) Add factory templating so users pass `--var change=<name>` on
  `minifac run`.
- (c) Pass the change name via stdin / environment / some other
  side-channel.

**Choice:** (a) — copy `sdd.yaml` to `sdd-<changename>.yaml` (or any
name) and edit the prompts to reference the change. The `sdd.yaml` we
ship uses a placeholder change name and is documented as a template
to copy.

**Rationale:** (b) requires a schema change (templating /
substitution) that deserves its own proposal — it's a feature with
syntax, scope, escaping rules, and second-order effects (does it apply
to `cwd:` too? `name:`? executor `with:`?). (c) is worse than (b)
because it hides state from the YAML. (a) ships today with zero
schema work and zero precedent set. When templating becomes load-
bearing — second factory wants it, real friction — that's the time
to propose it.

### Decision: Topology — linear flow plus single retry loop on verify

```
propose ──▶ apply ──▶ verify ──▶ archive (terminal)
              ▲           │
              └── on_failure
                  (max_traversals: 3)
```

- Four nodes: `propose`, `apply`, `verify`, `archive`.
- `archive` is the only terminal node.
- Forward edges (`on_success`, the default): `propose → apply`,
  `apply → verify`, `verify → archive`.
- One recovery edge: `verify → apply` with `when: "on_failure"` and
  `max_traversals: 3`.

What we deliberately do not include:

- **No `apply → propose` recovery edge.** If apply can't make sense of
  the proposal, the right answer in v0 is to fail the run with a
  clear error from the apply node and let the human re-run after
  fixing the proposal. Adding apply → propose introduces a second
  budget to reason about and a second-order cycle (propose → apply →
  propose → apply → verify → apply...) that doesn't pay for itself at
  v0. Easy to add later if a real failure pattern justifies it.
- **No `propose → terminal` shortcut.** propose always proceeds to
  apply on success. If propose decides there's nothing to do, it
  should fail with a clear message; a degenerate-success path adds
  complexity for an edge case.

`propose` is the only start node (it has no `on_success` inbound
edges). `verify → apply` is `on_failure`, so per the graph-runner spec
it does not disqualify `apply` from being reachable but does not make
it a start node either. The cycle `apply → verify → apply` is covered
by `max_traversals: 3` on the `verify → apply` edge, satisfying the
loader's bounded-cycle requirement.

### Decision: Budget — verify → apply retries capped at 3

`max_traversals: 3` on `verify → apply`. Meaning: apply runs at most
4 times total (initial + 3 retries), verify runs at most 4 times.

**Rationale:** A small integer that's clearly bigger than 1 ("you
got one shot") and clearly smaller than infinity. Three retries is
roughly the band where a real implementation either converges or
reveals a structural problem that more retries won't fix. Bias is
toward small — easier to bump up in a later change than to argue
about whether 10 was always overkill.

### Decision: Every node carries `cwd: <target repo>`; documented as friction

All four nodes will set `cwd` to the target repo path. This is
repetitive and a factory-level `cwd:` default would clean it up. We
do not propose that here — see Open Questions.

In `sdd.yaml` the cwd is a placeholder (e.g.
`/path/to/target/repo`) which users must edit alongside the change
name. The README and `sdd.md` call this out explicitly.

### Decision: No schema, runner, or executor changes

Walked through what `sdd.yaml` needs against each canonical spec:

- `factory-schema`: every key used (`name`, `description`, `nodes`,
  `edges`, `executor`, `terminal`, `cwd`, `with`, `from`, `to`,
  `when`, `max_traversals`) is in v0. ✓
- `graph-runner`: cycle-with-budget, failure routing, terminal node,
  multiple iterations of the same node — all v0. ✓
- `node-executor`: `claude` executor with `prompt` in `with:` and an
  honored `cwd` — all v0. ✓
- `run-cli`: `minifac run examples/sdd.yaml` is the existing
  interface. ✓

So this change ships with one new capability spec (`sdd-factory`)
documenting the *factory's* contract, and zero modifications to
existing capability specs.

### Decision: Per-node contract is documented in `examples/sdd.md`

Each node's contract — what its prompt must accomplish, which
OpenSpec CLI commands it invokes, what it emits to signal success or
failure — lives in `examples/sdd.md` next to the YAML. The spec
(`specs/sdd-factory/spec.md`) carries the binding requirements
(topology, budgets, start/terminal); the example doc carries the
human-readable per-node walkthrough.

**Rationale:** Two audiences. The spec is the contract the change
process protects. The example doc is what someone running the
factory reads. Keeping them separate means we can update the
walkthrough without going through a spec change, but topology and
budget changes still require a proposal.

## Per-node contract (summary; full text in `examples/sdd.md`)

**propose**
- Inputs: change description (from the prompt itself, edited per copy)
- Must invoke: `openspec new change <name>`, then write `proposal.md`,
  `design.md`, spec deltas, `tasks.md`, and run `openspec validate
  <name>` until clean.
- Success signal: validate exits 0; node exits 0.
- Failure signal: validate cannot be made to pass; node exits non-zero
  with a message naming the unresolved validation error.

**apply**
- Inputs: `ctx.history` contains propose's output, so apply sees the
  proposal/design/tasks/specs that just landed.
- Must invoke: read `openspec/changes/<name>/tasks.md`, work each
  unchecked `- [ ]` item, mark `- [x]` as done, commit when
  appropriate. May run lints/builds locally as it works.
- Success signal: all checkboxes in `tasks.md` are `- [x]`; node
  exits 0.
- Failure signal: a task is structurally impossible (e.g. needs a
  schema change not in the proposal); node exits non-zero with a
  message identifying the blocking task. (No `apply → propose`
  recovery edge — see topology decision.)

**verify**
- Inputs: `ctx.history` contains propose + apply output.
- Must invoke: the target repo's verify commands. For minifac that's
  `npm test`, `npm run build`, `npm run check`. The verify node's
  prompt names them explicitly per repo.
- Success signal: all verify commands exit 0; node exits 0.
- Failure signal: any verify command exits non-zero; node exits non-
  zero with output that names which check failed. The runner traverses
  `verify → apply` (on_failure), so apply's next iteration sees this
  failure in its `ctx.history` and is expected to address it.

**archive**
- Inputs: `ctx.history` contains the full prior run.
- Must invoke: `openspec archive <name>`.
- Success signal: archive command exits 0; node exits 0.
- This node is `terminal: true`; its success ends the run.

## Risks / Trade-offs

- **[Verify-via-claude is slower and noisier than a shell exec]** →
  Mitigation: document the contract precisely so a future `shell`
  executor is a drop-in replacement. The factory's topology and node
  responsibilities don't change; only the verify node's `executor` and
  `with:` shape do.
- **[Hard-coding the change name means every run is a copy-edit]** →
  Mitigation: README and `sdd.md` call this out as the documented
  workflow. Templating is a real feature with real scope; it earns its
  own proposal when it earns its own consumer.
- **[Repeated `cwd: <target repo>` on every node is friction]** →
  Mitigation: documented as an open question. Adding a factory-level
  `cwd:` default would be a small schema change but introduces resolve-
  order questions (factory-level vs node-level precedence, env-var
  interpolation, etc.) that deserve their own proposal once a second
  factory wants it.
- **[max_traversals: 3 might be wrong]** → Mitigation: it's one
  integer in one YAML file. Bumping it is a one-line proposal, or even
  a docs-only tweak if we decide example budgets aren't spec-binding.
  Starting small forces the per-iteration prompts to be focused.
- **[The factory could quietly stop working if `openspec` CLI surface
  changes]** → Mitigation: the load-time test covers shape, not
  behavior, so it'll keep passing even if `openspec new change` flags
  drift. Document in `sdd.md` which OpenSpec CLI version the example
  is known to work against. Bumping that is a docs change, not a spec
  one.

## Migration Plan

N/A. This change adds new files (`examples/sdd.yaml`, `examples/sdd.md`,
a test file) and edits the README. No data, no existing users of an
`sdd.yaml`, no deployed surface.

## Open Questions

These are deliberately *not* resolved by this change. Each is its own
future proposal if and when the friction justifies it:

- **Factory-level `cwd:` default.** Every node in `sdd.yaml` sets the
  same `cwd`. A top-level `cwd:` (with node-level override) would
  clean it up. Defer — needs a second example wanting it before we
  spec the precedence rules.
- **Templating / variables.** A `--var change=<name>` mechanism would
  remove the copy-and-edit workflow. Defer — it's a real feature with
  real scope (syntax, escaping, which fields participate); ship the
  copy workflow first.
- **Native `shell` executor.** Verify-via-claude is the workaround;
  a shell executor is the real answer. Defer — it's a new entry in
  the executor registry, which is its own proposal under
  `node-executor`.
- **Running `sdd.yaml` against minifac itself in CI.** Plumbing the
  factory into the release process is orchestration, not a feature of
  the factory. Defer.
- **Remote-CI watch as a verify option.** Today `verify` runs the
  target repo's verify commands directly in `cwd` — effectively a
  local-machine version of CI. For matrix tests, infra/workflow
  changes, and integration tests that only exist on the CI runner,
  the only true gate is the remote pipeline (GitHub Actions, etc.).
  A future change could add an *opt-in* CI-watch mode on the verify
  node — e.g. `with: { mode: "watch_ci", branch: "..." }` — that
  pushes the branch, polls the pipeline, and surfaces its result as
  the node's status. **It must remain optional**, not required for
  all workflows: many factories will run on a target repo with no CI
  configured, or want the fast local-only loop. New surface area when
  added: a git-push side effect, a `gh`-or-equivalent dependency,
  polling logic, and substantially longer run times. Probably wants
  to land after `serve-and-viewer` so long polls have somewhere to
  stream their state. Defer.
