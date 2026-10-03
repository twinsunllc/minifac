## Why

A workflow node that runs a step (`uses: implement`) cannot declare the
secrets that step needs. Scarif's documented shape is
`implement: { uses: implement, with: { secrets: [...] } }`. scarif-factory's
`declaring-a-secret` skill and its secrets gate use it, and scarif-web reads
`with.secrets` from the workflow file's nodes. minifac's loader refuses it:
`Node "implement" declares both uses: and with:; the two are mutually
exclusive`. So today only an inline `executor:` node can hold secrets.

The workaround is to put `with.secrets` in a local step file. It is unsafe,
because scarif-web reads only the workflow file and so does not see that the
job declares secrets (SCARIFW-2072, raised by cudrc-office; it blocks CUDRC's
first secrets run).

## What Changes

- **MODIFIED** `factory-schema` "Node `uses:` field as an alternative to
  inline executor": a `uses:` node still SHALL NOT declare `executor:`. It
  MAY declare a `with:` whose only key is `secrets`, a list. The loader
  copies the list unchanged into the inlined step's `with.secrets`.
- The loader refuses, with one sentence naming the node: any other `with:`
  key beside `uses:`, an empty `with: {}`, a non-mapping `with:`, a
  non-list `secrets`, and a node `with.secrets` when the step's own `with`
  already declares `secrets`. There is no override and no union.
- The entries' shape (a name, or `{ name, via }`) is not checked by minifac.
  The consumer that reads `with.secrets` checks it, as it does for an inline
  node.

## Impact

- Affected specs: `factory-schema`
- Affected code: `src/factory/loader.ts` (`validateNodeShape`),
  `src/step/inline.ts` (`inlineStepIntoNode`)
- No breaking change. Every node that loaded before loads the same; the only
  newly accepted shape is `uses:` + `with: { secrets: [...] }`.
- scarif-worker moves its minifac pin to the merged commit on main in a
  separate PR (SCARIFW-2072).
