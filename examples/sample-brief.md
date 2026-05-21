---
change: example-change
factory: sdd
# depends_on lists the change names of other briefs whose completion
# is a precondition for running this one. A dep is "satisfied" only
# when its file lives in `inputs/done/<name>.md`. The loader defaults
# missing values to `[]`, so omitting the field entirely is the same
# as declaring no deps.
# depends_on:
#   - other-change
---

## Background

A one-paragraph statement of what the change addresses and why it
matters right now. This is what gets dropped verbatim into the
propose node's prompt via `{{ brief.body }}`.

## What to do

A bulleted or prose description of the intended work, scoped to what
the factory should accomplish. The propose node embeds this section
(and everything else in the body) verbatim into its prompt.

## Out of scope

What the factory should not pull forward.

## Acceptance criteria

How "done" is judged for this change.
