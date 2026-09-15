## 1. Fix

- [x] 1.1 In `mergeLayers`, before overlaying a derived layer's nodes,
      reject any node id absent from the accumulated base that the
      layer's own `edges:` does not name; `FactoryLoadError` cites the
      derived layer and names the node id, the base's `extends:`
      reference and path, and the base's node ids

## 2. Tests

- [x] 2.1 The `veriy` typo case: override of a node the base lacks, no
      edges → load error naming `veriy`, `minifac:base`, the base path,
      and `plan, verify`
- [x] 2.2 A new node declared alongside `edges:` that don't reference it
      → load error
- [x] 2.3 Multi-level chain: the check names the immediate base (`mid`)
- [x] 2.4 Update "derived layer can add a new node" to wire the node
- [x] 2.5 Confirm 2.1–2.3 fail against the unfixed `extends.ts`

## 3. Verify

- [x] 3.1 tsc, `npm run check`, `npm test`,
      `openspec validate --all --strict`
