# minifac

**Structured AI workflows for your codebase.**

Write a one-page brief describing what should change. minifac
dispatches it through a *factory* — a small directed graph of
agent + tool nodes — on a fresh git worktree. The output is a
branch with passing tests, ready to merge.

```bash
npx minifac init --with-sdd           # scaffold inputs/, .minifac/, and an sdd factory
npx minifac run hello                 # one-node smoke test — confirms install works
npx minifac brief add-rate-limiting   # interactive Q&A → inputs/add-rate-limiting.md
npx minifac run   add-rate-limiting   # propose → apply → verify → archive
npx minifac merge add-rate-limiting   # fast-forward into main
```

A factory you don't have to write is included: `sdd` walks Claude
through propose → apply → verify → archive on each brief, looping
back from verify to apply on failed checks until the gate passes
or a budget is exhausted. Run `minifac autorun` to leave a daemon
polling `inputs/` and dispatching ready briefs as they appear —
queue work in the morning, come back to merge-ready branches.

```
propose ──▶ apply ──▶ verify ──┬──▶ archive
   ▲                            │
   └────── (cycle on failure) ──┘
```

## How it feels

A brief is a single markdown file you'd be comfortable handing
to a colleague:

```markdown
---
change: add-rate-limiting
factory: sdd
base_branch: main
---

## Background

We're getting hit with 401-retry storms from a misbehaving client.
The retry loop is uncapped on our side too.

## What to do

Add a token-bucket rate limiter to the /v1/auth endpoint. Default
budget: 10 req/sec per IP, 600 req/hour. Limits configurable via
env vars (RATE_LIMIT_*). Tests cover the default budget, the env
override, and the 429 response shape.

## Acceptance criteria

- `npm test` passes
- `RATE_LIMIT_PER_SECOND=1 curl ... -X POST ... ` returns 429 on
  the second request within the same second
```

`minifac run add-rate-limiting` then:

1. Creates `~/.minifac/worktrees/run-add-rate-limiting-<slug>/`
   from `main`
2. Cuts a branch `run/add-rate-limiting-<slug>`
3. Runs `sdd`: **propose** writes a change spec, **apply**
   implements it, **verify** runs your test/build/lint gates,
   **archive** folds the spec into the canonical record
4. If verify fails, routes back to apply with the failure
   message in context (bounded retries)
5. On success, marks the brief done (moves `inputs/add-rate-limiting.md`
   → `inputs/done/`) and leaves you a branch to merge

Every run is structured: typed input, typed output, persisted
event log under `~/.minifac/runs.db`. You can replay, audit, and
compare runs after the fact.

## Three rules

1. **Small core.** A graph runner, a streaming executor, a viewer.
   One TypeScript package, one SQLite file. That's the substrate.
2. **Plain naming.** A node is a node, not a "worker" or "agent
   persona." A factory is a factory. No metaphor-shaped
   vocabulary to learn.
3. **Spec-driven from day one.** Every behavior change in minifac
   itself goes through the same `sdd` factory it ships. Dogfood
   is the test.

## What a factory looks like

```yaml
name: sdd
brief: required

nodes:
  propose:
    uses: minifac:openspec-propose
    inputs: { change: "{{ brief.change }}", brief_body: "{{ brief.body }}" }
    cwd: "{{ run.cwd }}"
  apply:
    uses: minifac:openspec-apply
    inputs: { change: "{{ brief.change }}" }
    cwd: "{{ run.cwd }}"
  verify:
    uses: minifac:openspec-verify
    inputs: { change: "{{ brief.change }}" }
    cwd: "{{ run.cwd }}"
  archive:
    uses: minifac:openspec-archive
    inputs: { change: "{{ brief.change }}" }
    cwd: "{{ run.cwd }}"
  check-merge:
    uses: minifac:check-merge
    cwd: "{{ run.cwd }}"
    terminal: true

edges:
  - { from: propose, to: apply }
  - { from: apply,   to: verify }
  - { from: verify,  to: archive }
  - { from: verify,  to: apply, when: on_failure, max_traversals: 3 }
  - { from: archive, to: check-merge }
```

Factories are first-class and small enough to write yourself.
The bundled `sdd` factory handles the propose/apply/verify/archive
shape and is a good starting template, but the real leverage is
authoring factories that match your team's workflow — a release-prep
factory, a doc-drift watcher, a triage-then-dispatch pipeline. The
schema is intentionally narrow (nodes + edges + a few knobs), and
per-repo customization composes via `extends:` (override one node)
or per-node `uses:` references to reusable steps.

## Install

```bash
# Use directly without installing
npx minifac run hello

# Install globally
npm install -g minifac
minifac --version
```

Requires Node 22+. The bundled `sdd` factory dispatches the
`claude` CLI; install Claude Code separately and make sure
`claude` is on `$PATH`.

### From source

```bash
git clone https://github.com/twinsunllc/minifac
cd minifac
npm install
npm run build
node dist/cli.js run hello
```

Use `npm link` to put your local build on `$PATH`.

## Going deeper

- **[`CHANGELOG.md`](CHANGELOG.md)** — what shipped in each
  release
- **[`docs/CLI.md`](docs/CLI.md)** — full command reference
- **[`docs/concepts/`](docs/concepts/)** — Factory, Brief,
  Worktree, Executor, Runner, Sentinel, Cycle, Run, SDD-Loop,
  Runs-DB, Auto-Mode, Run-TUI, Step
- **[`docs/decisions/`](docs/decisions/)** — append-only
  architectural decisions: the why behind each call and what
  was rejected
- **[`docs/Roadmap.md`](docs/Roadmap.md)** — what's queued,
  in-flight, deferred
- **[`examples/sdd.md`](examples/sdd.md)** — the full SDD
  factory's per-node contract

### Selected features worth knowing about

- **Dependent briefs.** A brief can declare
  `depends_on: [other-change]`. `minifac run` refuses to start
  while a dep is unmerged; `minifac briefs --ready` shows
  what's unblocked.
- **Reusable steps.** Nodes can `uses:` a published step
  (`examples/steps/<name>.yaml` or per-repo
  `.minifac/steps/<name>.yaml`) instead of inlining their body.
  Steps are typed-input, versioned units of behavior.
- **Factory composition via `extends:`.** Derive a factory by
  overriding one node and keeping the rest. Combines with
  reusable steps.
- **A/B factory comparison.** `--factory <name>` overrides the
  brief's declared factory; the per-(change, factory) lockfile
  lets you race two factories on the same brief.
- **Worktree mode is the default.** `--in-place` opts out for
  CI or read-only factories that don't need isolation.

## Status

**v0.1 — first public release.** The core is real (graph
runner, SDD factory, daemon + viewer, brief authoring, autorun,
TUI, run-scoped branches + merge verb, dependent briefs,
reusable steps). Expect rough edges. Please file issues at
[github.com/twinsunllc/minifac/issues](https://github.com/twinsunllc/minifac/issues).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:
minifac uses spec-driven development on itself, so most behavior
changes go through `minifac run <change>` against the bundled
SDD factory. Docs / typos / formatting can skip the dance.

GitHub Actions are SHA-pinned per
[`docs/decisions/0024-CI-Security-Policy.md`](docs/decisions/0024-CI-Security-Policy.md);
update with
[`pinact`](https://github.com/suzuki-shunsuke/pinact). CI
rejects deps published less than 3 days ago — supply-chain
hygiene.

## License

MIT. See [LICENSE](LICENSE).
