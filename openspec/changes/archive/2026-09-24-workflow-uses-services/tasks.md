## 1. Schema and merge

- [x] 1.1 `src/factory/schema.ts`: `UsesServicesSchema` (list of
      non-empty strings, duplicates refused); optional `uses_services`
      on `FactoryLayerSchema` and `FactorySchema`, both still `.strict()`
- [x] 1.2 `src/factory/extends.ts`: `mergeLayers` takes
      `uses_services` from the entry layer only

## 2. Tests

- [x] 2.1 `schema.test.ts`: accept a list; refuse a scalar, an empty
      entry, a non-string entry, a map and a duplicate; other unknown
      top-level keys still refused
- [x] 2.2 `uses-services.test.ts`: the same refusals through
      `loadFactory`, naming the file and the key; the `extends:` cases
      (own list, base not inherited, derived replaces base, invalid
      base named); a factory repo whose `factory.yaml` carries design
      D5's `services:` block and a `library:` pin loads the same as one
      without it

## 3. Docs

- [x] 3.1 `docs/concepts/Factory.md`: the top-level field and its
      non-inheritance
- [x] 3.2 ADR 0045 and the decisions index
- [x] 3.3 CHANGELOG
