## 1. Rule

- [x] 1.1 `src/factory/start-nodes.ts`: `startNodeIds(factory)` — no
      inbound edge from another node (any `when`; self-loops ignored)
      or `start: true`; declaration order
- [x] 1.2 `src/factory/schema.ts`: optional boolean `start` on
      `NodeSchema`, no default
- [x] 1.3 `src/step/inline.ts`: carry `start` through inlining
- [x] 1.4 `src/factory/cycles.ts`: `findEntryCycles` (cyclic SCCs no
      edge enters from outside)
- [x] 1.5 `src/factory/loader.ts`: validate with `startNodeIds`; the
      zero-start error names the entry cycle and both fixes
- [x] 1.6 `src/runner/run.ts`: seed the queue with `startNodeIds`

## 2. Tests

- [x] 2.1 `start-nodes.test.ts` unit coverage
- [x] 2.2 Loader: F6 shape, `p`/`v` loop bare vs declared, self-loop,
      no-start message, non-boolean `start`
- [x] 2.3 Runner: F6 probe (`a b z` / `a b ask`), `start: true`
      dispatch at begin
- [x] 2.4 Inlining preserves `start:`; schema accepts/rejects
- [x] 2.5 Existing entry-in-cycle fixtures declare `start: true`;
      `sdd-example` uses the shared helper

## 3. Spec + docs

- [x] 3.1 graph-runner "Start nodes" MODIFIED; factory-schema
      "Node `start:` field" ADDED
- [x] 3.2 ADR 0040; `Factory.md`, `Runner.md`

## 4. Verify

- [x] 4.1 `npx tsc --noEmit`, `npx biome check .`, `npx vitest run`,
      `npx openspec validate --all --strict`
