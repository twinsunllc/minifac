## Context

ADR 0043 exposed run-level state (`run.follow_up`, `run.prior_asks`) to
a graph as always-resolving tokens. Scarif's split change asks for the
same thing for a split child (`run.split`) and a resumed split parent
(`run.split_integration`), with field access such as
`{{ run.split.parent_branch }}`, and asks that both also reach "the node
preamble". See ADR 0044.

## Decisions

### A dotted sub-path, only under these two tokens

The token grammar allowed one field. `{{ run.split.parent_branch }}`
needs a path. A general dotted grammar for every namespace would change
what `{{ brief.x.y }}` and `{{ inputs.a.b }}` mean, so the sub-path
resolves only under `run.split` and `run.split_integration`. Every other
token that carries one passes through verbatim, as it did when the
grammar did not match it at all. Only plain-object keys walk; an array
is a leaf, so there is no indexing. A prompt reads `{{ run.split.group }}`
as JSON.

### None-values: `null` for the object, empty for a field

`{{ run.split }}` is `null` on a non-child, which is what the scarif-spec
change says. A field of an absent object renders the empty string, the
`run.feedback` convention: a literal token reads as an instruction.

### The preamble is a prompt block, not the executor's stdin preamble

`run.follow_up` reaches nodes only through tokens today. The claude
executor's stdin preamble is the `priorResults` JSON, whose wire format
the node-executor spec pins. So "the node preamble" is a runner-level
block prepended to the substituted prompt, following ADR 0042's
human-answer block (ADR 0007's runner-injects precedent), and only for
split runs, so that every other run's prompts stay byte-identical.

### Snake_case, opaque

The objects mirror the claim's `factory.split` as Scarif sends it. The
runner renders them and does not interpret them.
