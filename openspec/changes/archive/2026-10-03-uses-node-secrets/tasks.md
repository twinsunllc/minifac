## 1. Loader

- [x] 1.1 `src/factory/loader.ts`: `validateNodeShape` replaces the blanket
      `uses:` + `with:` refusal with `validateUsesWith`, which accepts a
      `with:` whose only key is `secrets` (a list) and refuses any other key,
      an empty `with: {}`, a non-mapping `with:` and a non-list `secrets`
- [x] 1.2 `src/step/inline.ts`: `inlineStepIntoNode` copies the node's
      `with.secrets` into the inlined `with`, and refuses it when the step's
      `with` already declares `secrets`

## 2. Tests

- [x] 2.1 `src/step/inline.test.ts`: merge unchanged and in order; refusal
      when the step declares `secrets` (equal list and different list); a
      step's own `secrets` survive when the node declares none
- [x] 2.2 `src/factory/uses-loader.test.ts`: accept a built-in-path step, a
      factory-repo root `steps/` step and an empty list; refuse other keys,
      step-declared `secrets`, `with: {}`, non-list `secrets` and a
      non-mapping `with:`, each naming the node in one sentence
- [x] 2.3 `src/library/library.test.ts`: accept a library step

## 3. Docs

- [x] 3.1 `docs/concepts/Factory.md`: node-fields text and the `with` /
      `uses` rows
- [x] 3.2 ADR 0046
- [x] 3.3 CHANGELOG
