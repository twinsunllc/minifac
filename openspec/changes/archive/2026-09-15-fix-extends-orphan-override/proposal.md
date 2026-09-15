## Why

ADR 0008 says an `extends:` override naming a node the base does not
declare "errors at load time, which is the right failure mode". The
loader instead merges `{ ...base.nodes, ...layer.nodes }`, so the
override is added as a new node (issue #34; scarif-factory FINDINGS F31).
A layer overriding `veriy` (typo for `verify`) loaded clean with nodes
`plan verify veriy`; with no inbound `on_success` edge, `veriy` is also
inferred as a start node and runs when the run begins. The consumer
contract (scarif-spec `factory-repo-contract`) requires the load error.

The current `factory-schema` spec also says new nodes "SHALL be added",
with a scenario adding an unwired `audit` node — the same hazard,
spec'd. Adding a node through `extends:` is a real capability worth
keeping; adding one *silently and unwired* is not.

## What Changes

- **FIXED** A derived-layer node id that the accumulated base lacks is
  accepted as an addition **only when the same layer's `edges:` names
  it** as an endpoint. Otherwise it is an override of a node the base
  lacks and the loader throws `FactoryLoadError` citing the derived
  layer, naming the node id, the base's `extends:` reference and path,
  and the base's node ids.
- **MODIFIED** `factory-schema` "Replace-at-node-level merge semantics":
  the new-node rule gains the wiring condition; the "Override adds a new
  node" scenario now wires `audit`; three new scenarios (the `veriy`
  typo, a new node the layer's edges don't reference, multi-level
  chains).

### Why wiring, not "every unknown id is an error"

The strict reading of ADR 0008 would remove additions entirely, forcing
a full copy of the base to add one node — the drift the consumer
contract exists to prevent. Wiring is the property that separates an
intended addition from a typo: an unwired new node is exactly the node
that would be inferred as a start node and dispatched at run start. A
layer adding a node must already declare `edges:` to connect it (edges
replace wholesale), so no legitimate factory pays anything.

## Impact

- `src/factory/extends.ts` (`mergeLayers`)
- `src/factory/extends.test.ts`: the add-a-node test now wires its node;
  three new tests
- Breaking only for a layer that adds an unwired node — which today runs
  that node as an extra start node. No shipped example does.
