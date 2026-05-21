# minifac docs

The project's knowledge vault. Concept notes describe *what things are*;
decision notes describe *why we chose this and what we rejected*. Both
link liberally via `[[wikilinks]]` — readable on GitHub (as plain text),
navigable in [Obsidian](https://obsidian.md), fine in any markdown editor.

## Concepts

The system has a small vocabulary. Click any of these to read what it is.

- [[Factory]] — the workflow definition (a directed possibly-cyclic graph)
- [[Brief]] — the per-change input that drives a factory
- [[Run]] — one invocation of a factory against a brief
- [[Worktree]] — the isolated git working tree minifac creates per run
- [[Executor]] — what actually runs a node (`claude` today, eventually `shell`)
- [[Runner]] — the orchestrator that walks the graph and streams events
- [[Sentinel]] — how a node signals success/failure to the runner
- [[Cycle]] — bounded recovery loops in the graph
- [[SDD-Loop]] — the canonical factory: propose/apply/verify/archive
- [[Runs-DB]] — persistent run history
- [[Auto-Mode]] — long-running `minifac autorun` that picks up ready briefs

## Decisions

Append-only log under `decisions/`. Each decision is immutable once
accepted; superseded by new decisions rather than edited. See
`decisions/README.md` for the convention and the template.

## Living docs

- [[Roadmap]] — current proposal sequence, in-flight work, deferred items
- [[Open-Questions]] — decisions deferred with named triggers

## Conventions

- Concept notes use `Title-Case` filenames (`Brief.md`, `Worktree.md`)
- Decision notes use `NNNN-Kebab-Case` (`0001-Spec-Driven-Development.md`)
- Aliases in frontmatter let `[[briefs]]` resolve to [[Brief]]
- Wikilinks resolve folder-agnostically — `[[Factory]]` works from any note
- Living docs (Roadmap, Open-Questions) are mutable; decision notes are not

## Reading order for a newcomer

1. This README
2. [[Roadmap]] — what we're building and what's next
3. [[Factory]] and [[Brief]] — the two central concepts
4. `decisions/0004-Factory-vs-Input-Separation.md` — the architectural framing
5. Browse other concept notes as needed; backlinks in Obsidian help

## Updating

- A new decision lands → write a new decision note, link to it from
  affected concept notes and from [[Roadmap]]
- A concept evolves → edit the concept note; do not edit existing
  decision notes (write a superseding one if the underlying decision
  changed)
- A deferred question fires → write the decision note, remove the
  entry from [[Open-Questions]]
