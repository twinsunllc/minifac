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

## Runner & history

### Run-wide history exceeds context window
**Question:** How does the [[Runner]] keep the per-node prompt under
the model's context limit when a long-running, multi-iteration, or
large-implementation run produces history beyond the budget? Today
the entire run-wide history is concatenated and sent to every node;
the `run-history-persistence` dogfood hit "Prompt is too long" at
the verify node because apply's accumulated history blew past the
1M-token window.
**Trigger:** Already firing. This already broke one dogfood; the
manual workaround was to finish verify+archive by hand. Surface a
real proposal next.
**Likely shape:** Per-node history filters (each node declares what
it actually needs — e.g., `history: ["verify"]` or `history:
"last-iter"`); summarization of older iterations; or a side-channel
where history is written to a file and the node reads what it wants.

## Brief authoring & input

### Brief dependencies and state
**Question:** How are inter-brief dependencies (`depends_on`) and
brief-level state (ready / in-progress / blocked / done) captured?
**Trigger:** Backlog of briefs becomes unmanageable, or `auto-mode`
becomes desirable.
**Likely shape:** `depends_on` field added to [[Brief]] frontmatter
(loader is already permissive-on-extras per [[0005-Brief-Schema]]);
state lives in [[Runs-DB]] (which [[0011-SQLite-for-Runs]] designed for).

### Brief substitution syntax
**Question:** How does the factory's prompt template reference brief
content? Mustache (`{{ brief.body }}`)? Plain string interpolation?
Something else?
**Trigger:** First time a non-trivial substitution (multi-line content,
escaping, conditionals) reveals the friction.

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

## Status signaling

### Hook-enforced sentinel
**Question:** Should the spawned Claude session run a Stop hook that
extracts the [[Sentinel]] from the transcript and writes structured
status? More robust than parsing stdout for the magic string.
**Trigger:** Sentinel parsing feels fragile in practice (model forgets,
format drifts under model upgrades).
**Likely shape:** Configurable Stop hook attached when the runner
spawns the child claude process.

### Callback / MCP status transport
**Question:** Should status signaling move to an HTTP POST or MCP tool
call instead of sentinel-in-text? Tamper-resistant and *bidirectional*.
**Trigger:** First real need for mid-run human-in-the-loop interaction
(pause-and-ask, structured feedback during apply, "leave a comment in
the viewer and the factory picks it up").
**Why eventual:** Sentinel is one-way and only at the end. Mid-run
two-way interaction structurally requires the callback shape.

## Concurrency & queueing

### Machine-wide concurrency cap
**Question:** Should minifac enforce a max number of concurrent runs
for cost / rate-limit reasons?
**Trigger:** A user blows their API budget by accident.
**v0 stance:** User manages concurrency; per-change-name lockfile
prevents collision but doesn't cap total.

### Auto-mode work scheduling
**Question:** When a long-running minifac picks the next ready brief,
what's the policy? FIFO? Priority field? Dependency-first?
**Trigger:** `auto-mode` proposal earns its way in.

## Storage

### Beads as state substrate
**Question:** When SQLite's structured-data limits start to hurt
(threaded comments, assignees, rich state machines), do we swap to
beads for brief state?
**Trigger:** Real need for issue-tracker semantics.
**v0 stance:** SQLite is enough. See [[0011-SQLite-for-Runs]].

### Run history retention
**Question:** Do old runs get auto-pruned from [[Runs-DB]], or kept
forever?
**Trigger:** runs.db gets large enough to slow queries or feel wasteful.
**Likely shape:** A `minifac prune --runs --older-than 90d` flag on
the existing prune command.

## Daemon & viewer

### Daemon-side scheduling
**Question:** Should the daemon support cron expressions, webhook
triggers, or file-watch triggers for unattended factory runs?
**Trigger:** Nightly automation becomes a real workflow (system cron
+ `minifac run` covers the case for now).

### Auth and remote exposure
**Question:** When does the daemon need authentication and TLS?
**Trigger:** Someone wants to expose it beyond localhost.
**v0 stance:** Localhost-only by design.
