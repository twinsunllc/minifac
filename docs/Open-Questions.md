---
tags: [living-doc]
---

# Open Questions

Decisions deliberately deferred. Each has a named trigger — a condition
that, if it happens, surfaces the question for real and earns it a
proposal.

When a question becomes a decision, write the decision note and remove
it from here. When a question's premise turns out wrong, capture that
in a decision note.

## Reusable steps

### Step marketplace / registry
**Question:** Where do externally-shared [[Step]]s live, how are they
distributed, and how does pinning + supply-chain trust work?
**Trigger:** A second repo wants to depend on a step authored in
another repo's `.minifac/steps/`; copy-paste becomes the friction.
**v0 stance:** Local-only steps; tool-version-locked. Bundled
`minifac:*` references ship with the package per
[[0030-Bundle-Builtins]]. The eventual remote-fetch
resolver (cross-repo / cross-org sharing via git URLs) is sketched
in [[Reference]] § Direction; trigger to brief is "first user
wants to share a step across multiple repos."

### Step authoring helper
**Question:** Should there be a `minifac step <name>` CLI verb (and
matching Claude Code skill) for one-question-at-a-time step
authoring, analogous to brief authoring?
**Trigger:** Step authoring becomes frequent enough that hand-rolling
YAML feels slow.
**Likely shape:** Mirror the brief-authoring patterns
([[0005-Brief-Schema]] / brief-authoring skill).

### Step versioning independent of minifac
**Question:** Do steps get their own SemVer independent of the tool,
or do they ride the tool's version?
**Trigger:** A step needs to be supported across multiple minifac
versions, or someone pins an older step with a newer minifac.
**v0 stance:** Tool-version-locked. See [[0018-Reusable-Steps]].

## Brief authoring & input

### Brief substitution syntax
**Question:** How does the factory's prompt template reference brief
content? Mustache (`{{ brief.body }}`)? Something else?
**Trigger:** First time a non-trivial substitution (multi-line content,
escaping, conditionals) reveals the friction.
**v0 stance:** Mustache-style `{{ namespace.field }}`, shipped in
factory-inputs-core; the typing question still open.

## Factory composition

### Independent factory versioning
**Question:** Do factories get their own SemVer independent of the
minifac tool, or do they ride the tool's version?
**Trigger:** A factory needs to be supported across multiple minifac
versions, or someone wants to pin an older factory with a newer minifac.
**v0 stance:** Tool-version-locked. See [[0008-File-Per-Factory-Composition]].

### Cross-repo factory registries
**Question:** Can a custom factory in repo A be referenced by repo B?
**Trigger:** Two repos want the same custom factory and copy-paste
becomes the friction point.
**Note:** Same resolver layer as the step marketplace question —
[[Reference]] § Direction sketches a unified resolver chain
(bundled → user-local → cached-remote → fetch-fresh) covering both
steps and factory `extends:`. Whether factories are also a sharing
unit (vs. always composed locally from shared steps) is a smaller
sub-question inside that.

### Autorun `--factory` flag
**Question:** Should `minifac autorun` ([[0016-Auto-Mode]]) accept a
`--factory <name>` flag so scheduled runs all go through a specified
factory (and, by extension, accept an array for "run every brief
through every listed factory")?
**Status:** Deferred to the `auto-mode` proposal. The answer is
"yes" — `minifac run --factory` ([[0020-Factory-Override-At-Invocation]])
has shipped and `autorun` will inherit the same override pattern when
the `auto-mode` change lands. Pre-specifying it here would commit a
surface area that has no implementation yet.

## Callback intervention surface — design re-scope

**Question:** What does the bidirectional intervention surface ADR 0017
proposed actually look like, now that structured outputs have been
split off into [[0027-Node-Outputs]] and the MCP transport
([[0029-Node-Outputs-MCP]]) is the channel for them?

The original 0017 framing bundled "structured per-node payloads" with
"bidirectional intervention" (Ctrl-C-equivalent, "hey also do X"
mid-run, studio chat). The outputs work split off the first
responsibility cleanly. What's left for 0017 is just *intervention* —
which is a smaller, more focused surface, and probably wants different
trade-offs than the original ADR captured.

Also unresolved: the authentication model. Opt-in per-node is one
thing; trusting a separately-authenticated client (Studio, curl, an
MCP client) is another.

**Trigger:** Concrete need for in-process mid-run intervention
(separate from the [[Run-TUI]]'s `q quit` affordance). Likely tied to
when Studio work starts.

**v0 stance:** ADR 0017 stays as-is for now; the
`callback-status-signaling` brief is blocked-pending-design via a
sentinel `depends_on` entry. When the design is re-scoped, edit the
brief (or replace ADR 0017 with a successor) and clear the dep.

## Status signaling

### Hook-enforced sentinel
**Question:** Should the spawned Claude session run a Stop hook that
extracts the [[Sentinel]] from the transcript and writes structured
status? More robust than parsing stdout for the magic string.
**Trigger:** Sentinel parsing feels fragile in practice (model forgets,
format drifts under model upgrades) AND callback transport
([[0017-Callback-Status-Signaling]]) isn't an option for some reason.
**Likely shape:** Configurable Stop hook attached when the runner
spawns the child claude process. Belt-and-suspenders for the
sentinel-fallback path; the callback covers the active surface.

## Edge & cycle semantics

### Cycle-back on merge conflict
**Question:** How does a factory express "if the merge check
fails, cycle back through `apply` with the conflict context so the
model can resolve it"?
**Trigger:** Auto-merge halt-mode (see [[autorun-auto-merge]]) bites
often enough in unattended sessions that the operator wants the
factory to self-heal trivial conflicts without intervention.
**Status:** The probe prerequisite is satisfied — `minifac:check-merge`
ships as a built-in (see the `check-merge-step` capability spec)
and exits non-zero on conflict, so factories MAY already wire an
`on_failure` edge from a `check-merge` node back to `apply`. The
remaining gate is **structured node-outputs**: a blind retry
without conflict context (file list, hunks, base SHA) burns cycles
guessing. The shipped SDD factory therefore declines to declare
such an edge in v0; that decision flips when node-outputs
([[0027-Node-Outputs]] et al.) is mature enough to carry
conflict context between iterations.
**Likely shape:** No new `when:` value (we rejected
`on_merge_conflict` as overfit — adding a keyword per failure mode
is a bad precedent). The conflict context flows through node
outputs so the retried `apply` knows what to fix.

## Concurrency & queueing

### Machine-wide concurrency cap
**Question:** Should minifac enforce a max number of concurrent runs
for cost / rate-limit reasons?
**Trigger:** A user blows their API budget by accident.
**v0 stance:** User manages concurrency via `--max-concurrent` on
[[Auto-Mode]]; per-change-name lockfile prevents collision but doesn't
cap total.

### Cost-aware scheduling
**Question:** Once persisted run costs accumulate in [[Runs-DB]],
should [[Auto-Mode]] enforce a `--max-spend-per-hour` or similar?
**Trigger:** Sustained autorun against a real backlog reveals cost
visibility as a felt need.

## Storage

### Beads as state substrate
**Question:** When SQLite's structured-data limits start to hurt
(threaded comments, assignees, rich state machines), do we swap to
beads for brief state?
**Trigger:** Real need for issue-tracker semantics.
**v0 stance:** Derived state from SQLite + brief files is enough.
See [[0011-SQLite-for-Runs]] and [[0015-Brief-Deps-and-State]].

### Run history retention
**Question:** Do old runs get auto-pruned from [[Runs-DB]], or kept
forever?
**Trigger:** runs.db gets large enough to slow queries or feel wasteful.
**Likely shape:** A `minifac prune --runs --older-than <duration>` flag.

## Daemon & viewer

### Daemon-side scheduling
**Question:** Should the daemon support cron expressions, webhook
triggers, or file-watch triggers for unattended factory runs?
**Trigger:** Nightly automation becomes a real workflow (system cron
+ `minifac autorun` covers the case for now).

### Auth and remote exposure
**Question:** When does the daemon need authentication and TLS?
**Trigger:** Someone wants to expose it beyond localhost.
**v0 stance:** Localhost-only by design.

## Studio (separate project)

### Visual workflow designer
**Question:** Should [[Studio]] include a visual factory authoring
mode (React Flow, drag-nodes-and-edges), or stay
inspection-and-chat only?
**v0 stance / strong leaning:** Inspection and chat only. See
[[Roadmap]] § Studio for the direction. Revisit once
chat-with-run is real and we have evidence about what users
actually want.

### Engine + studio coupling
**Question:** Is the daemon's HTTP API + a published types package
enough to keep engine and studio loosely coupled, or do we
eventually want a monorepo with shared internals?
**Trigger:** Cross-cutting changes between engine and studio become
frequent and atomic-ship matters (probably >1/month).
**v0 stance:** Separate repos, HTTP API is the contract. See
[[Roadmap]] § Studio for the packaging rationale.

### Chat-with-running-node UX
**Question:** What does the actual chat affordance look like when
a node is mid-run? Inline in the run stream? Side panel? Floating?
**Trigger:** Studio's chat surface starts implementation.

## Open-source readiness

### License choice
**Question:** MIT, Apache 2.0, BSL, or something else?
**Trigger:** Open-sourcing actually happens.

### Install path
**Question:** Publish `minifac` to npm? Bundle a single executable
via `pkg`/`bun build --compile`? Homebrew formula?
**Trigger:** Open-sourcing actually happens.
**Note:** npm is the path of least resistance for a TypeScript CLI;
revisit if cross-platform distribution becomes painful.
