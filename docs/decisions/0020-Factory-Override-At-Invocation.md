---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0020: Factory override at invocation

## Context

Today a [[Brief]]'s `factory:` field is authoritative — `minifac
run foo` runs the brief through whatever factory the file declares.
To run the same brief through a different factory (for A/B
comparison, model variations, factory iteration), you'd have to
copy the brief file and change its `factory:` field, producing two
files that say the same thing. That's wasteful and obscures the
intent ("I'm trying the same brief through two factories").

With [[0019-Run-Scoped-Branches]] giving each run a unique branch,
the per-run artifacts are already distinct. The only missing piece
is a CLI affordance to override the brief's factory at invocation
time.

## Decision

**New `--factory <name>` flag on `minifac run`** that overrides
the brief's `factory:` frontmatter for that invocation.

```
minifac run foo --factory sdd-with-codex
minifac run foo --factory minifac:sdd      # built-in passthrough
```

Resolution rules:

- The CLI flag wins over the brief's declared factory
- The flag value is resolved through the same lookup precedence
  as the brief's factory field (per
  [[0008-File-Per-Factory-Composition]]):
  local `.minifac/factories/<name>.yaml` first, built-in
  `examples/<name>.yaml` second
- `minifac:<name>` prefix forces built-in resolution (skip local)

**Lockfile scope widens to `(repo-hash, change, factory)`.** Two
runs of the same brief through the *same* factory still serialize
(running them in parallel makes no sense and likely indicates a
bug). Two runs of the same brief through *different* factories
proceed concurrently — that's the whole point.

**Branch name discriminator stays unique without encoding
factory.** Per [[0019-Run-Scoped-Branches]], the slug (first 6 hex
of the run UUID) is already unique per run; the branch name
`run/<change>-<slug>` distinguishes two runs regardless of which
factory they used. The factory information is in [[Runs-DB]]
(`factory_name` column, already present).

This means `minifac runs --change foo` shows all attempts of
`foo` across all factories, with the factory column making which-
was-which obvious:

```
RUN     CHANGE   FACTORY            STATUS      BRANCH                ENDED
a7b3c1  foo      sdd                succeeded   run/foo-a7b3c1        12m ago
c91d2f  foo      sdd-with-codex     succeeded   run/foo-c91d2f        8m ago
```

The user picks which one to merge via `minifac merge`.

## Consequences

- A/B factory comparisons become natural: `minifac run foo` then
  `minifac run foo --factory <other>`. Two branches, diffable,
  pick the better one.
- Model comparisons via a factory that differs only in `model:` —
  same brief, two runs, see which produced better code.
- Factory iteration: tweak a factory; re-run a known brief; diff
  against the prior run's branch.
- Eval/benchmarking shape becomes possible: a small library of
  "fixture" briefs run against candidate factories.
- The brief's `factory:` becomes the *default*; the brief is no
  longer hardcoded to one factory.
- Lockfile widens; concurrent runs against the same brief require
  distinct factory choices.

## Alternatives considered

- **Edit the brief's `factory:` field per attempt.** Rejected —
  produces noisy commits, obscures intent, makes comparison
  harder.
- **A new "experiment" concept layered on top of briefs.**
  Rejected — overengineered. The brief is the input; the factory
  is the implementation; the run is the artifact. Adding a
  fourth concept duplicates what the existing three already
  express.
- **Make `factory:` in the brief optional; require it on the
  CLI.** Rejected — breaks the "self-describing brief" property
  from [[0005-Brief-Schema]].
- **Encode factory in the brief filename** (`foo.sdd.md`,
  `foo.sdd-with-codex.md`). Rejected — one brief per factory by
  construction; loses the "same input, different implementations"
  framing.

## Open questions (in scope for the proposal phase)

- Should `minifac autorun` ([[0016-Auto-Mode]]) gain a parallel
  `--factory` flag, so autorun-scheduled runs all go through a
  specified factory? Probably yes; cheap to add.
- Should `minifac briefs --ready` predicate account for whether
  the brief has already succeeded through *this* factory vs *any*
  factory? Probably "any factory" — once a brief has succeeded
  through one factory and been merged, it's done regardless of
  which factory produced it.

## Related

- [[Brief]] — `factory:` field becomes default, not exclusive
- [[Factory]] — same lookup precedence as today; just from CLI
  flag rather than brief field
- [[Run]] — `factory_name` column carries the actual factory used
- [[Worktree]] — lockfile scope widens
- [[0005-Brief-Schema]] — brief's `factory:` is now a default
- [[0008-File-Per-Factory-Composition]] — lookup precedence
  unchanged
- [[0019-Run-Scoped-Branches]] — provides the per-run branch
  identity this depends on
- [[Open-Questions]] — adds the autorun-factory-flag question
