## 1. Project skeleton

- [ ] 1.1 Add `package.json` with name `minifac`, type `module`, Node 22+ engines field, and the planned `bin` entry for `minifac`
- [ ] 1.2 Add `tsconfig.json` (strict mode, ES2023 target, NodeNext module, `noUncheckedIndexedAccess`, declaration output)
- [ ] 1.3 Add `biome.json` for lint + format; add a top-level `format` and `lint` script
- [ ] 1.4 Add `vitest.config.ts` and a `test` script
- [ ] 1.5 Install runtime deps (`zod`, `yaml`, `commander`) and dev deps (`typescript`, `vitest`, `@biomejs/biome`, `@types/node`)
- [ ] 1.6 Create `src/` with an `index.ts` that re-exports the public surface, plus an empty placeholder test to prove the toolchain runs

## 2. Factory schema (capability: `factory-schema`)

- [ ] 2.1 Define the Zod schema for a factory document: `name`, optional `description`, `nodes` map, `edges` array; reject unknown top-level keys
- [ ] 2.2 Define the node Zod schema: required `executor`, optional `terminal` (default `false`), `max_iterations` (positive int), `cwd`, and free-form `with`; reject unknown top-level node keys
- [ ] 2.3 Define the edge Zod schema: required `from`, `to`; optional `max_traversals` (positive int) and `when` (enum: `on_success` | `on_failure`, default `on_success`)
- [ ] 2.4 Implement the loader: read the file, parse with the `yaml` package preserving source positions, run Zod, and emit errors that include line/column when available
- [ ] 2.5 Implement post-parse validation: edges reference declared nodes; factory contains at least one start node (no inbound edges); factory contains at least one `terminal: true` node
- [ ] 2.6 Implement cycle detection and budget coverage check: reject any cycle not covered by an edge `max_traversals` or a node `max_iterations` on the cycle
- [ ] 2.7 Export the typed `Factory` type via `z.infer` and a `loadFactory(path: string): Promise<Factory>` function
- [ ] 2.8 Tests covering every scenario in `specs/factory-schema/spec.md` (minimal valid factory; camelCase rejection; missing executor; unknown node keys; opaque `with`; edge to undeclared node; unknown `when`; unbounded cycle rejection; bounded cycle accepted; missing terminal node; YAML syntax error line number)

## 3. Node executor (capability: `node-executor`)

- [ ] 3.1 Define `NodeEvent` discriminated union (`stdout` | `stderr` | `status`) and the `NodeExecutor` interface with `type` and `run(node, ctx): AsyncIterable<NodeEvent>`
- [ ] 3.2 Implement an `ExecutorRegistry` keyed by `type`; reject duplicate registration; expose `get(type)` and `register(executor)`
- [ ] 3.3 Implement `claude-runner.ts`: validate `with:` (require `prompt: string`, optional `model`, optional pass-through args), spawn `claude --input-format stream-json --output-format stream-json` as a child process honoring resolved `cwd`, parse stdout line-by-line into `stdout` events, forward stderr as `stderr` events, yield terminal `succeeded`/`failed` status based on exit code; detect missing binary and yield a clear `failed` status
- [ ] 3.4 Implement the stream-json input serializer: take `ctx.history` plus the node's `prompt` and emit a stream-json document on the child's stdin (close stdin after writing). Snapshot-test the wire format so changes are deliberate
- [ ] 3.5 Tests for the registry (registration, duplicate-rejection, lookup-miss)
- [ ] 3.6 Tests for the `claude` runner using a stubbed binary on `$PATH` (success, non-zero exit, missing binary, missing `prompt`, history serialization, cwd resolution); cover every scenario in `specs/node-executor/spec.md`

## 4. Graph runner (capability: `graph-runner`)

- [ ] 4.1 Implement the run-state model: per-node execution counts, per-edge traversal counts, the run-wide ordered history (`RunHistoryEntry[]`), and an event stream output
- [ ] 4.2 Implement start-node resolution and the scheduling loop: pick eligible nodes (respecting iteration budgets), build a `RunContext` (factory, snapshot of history at scheduling time, current `nodeId`, `iteration`, resolved `cwd`), execute them via the executor registry, consume their events, append every event to the history, and forward to the consumer
- [ ] 4.3 Implement edge evaluation on node completion: filter by `when` (`on_success` / `on_failure`), enforce `max_traversals`, schedule the resolved successors
- [ ] 4.4 Implement termination semantics: terminal-success ends the run; uncovered failure / drained graph / budget exhaustion ends as failed with a categorized reason
- [ ] 4.5 Build the structured `RunResult` (`status`, `reason`, per-node execution log with counts and statuses, total duration)
- [ ] 4.6 Export `runFactory(factory, options): Promise<RunResult>` taking an event consumer callback
- [ ] 4.7 Resolve `cwd`: relative `cwd` values resolve against the factory file's directory; absolute paths are honored as-is; if absent, the factory file's directory is used
- [ ] 4.8 Tests covering every scenario in `specs/graph-runner/spec.md` (start nodes; multi-start; `when` filtering on success and failure; edge budget; node budget; terminal success; budget exhaustion; terminal node in a cycle; streaming order; history accumulation across nodes; cycle re-entry sees prior iteration; cwd resolution)

## 5. Run CLI (capability: `run-cli`)

- [ ] 5.1 Wire up `commander`: top-level `minifac` program with a `run <factory>` subcommand; support `--help` / `-h` / `--version`
- [ ] 5.2 Implement the run handler: load factory, instantiate registry with `claude`, call `runFactory`, write events to stdout/stderr with `[<node_id>] ` prefix (status events to stderr in a distinct format)
- [ ] 5.3 Map `RunResult` and load errors to exit codes (`0`, `1`, `2`, `3` per spec); ensure errors are flushed before exit
- [ ] 5.4 Make the package executable: `bin` entry, shebang on the CLI entrypoint, and a build step that emits the runnable JS
- [ ] 5.5 Tests covering every scenario in `specs/run-cli/spec.md` (valid run end-to-end; missing file; output prefixing; status format distinct; exit codes 0/1/2/3; `--help` / `--version`)

## 6. Hello-world example factory

- [ ] 6.1 Add `examples/hello.yaml`: a single node with `executor: claude`, `terminal: true`, and a simple `with: { prompt: ... }`
- [ ] 6.2 Add a top-level `README` section pointing at the example and showing the `minifac run examples/hello.yaml` invocation
- [ ] 6.3 Manually run `minifac run examples/hello.yaml` end-to-end against a real `claude` CLI and confirm streaming output + exit code 0

## 7. Tooling polish

- [ ] 7.1 Add `npm run build` (tsc) and `npm run start` (run the built CLI) scripts; wire `prepare`/`prepublish` as appropriate
- [ ] 7.2 Add a top-level `npm test` that runs vitest in CI mode; verify `npm run lint` and `npm run format` pass on the codebase
- [ ] 7.3 Add a brief `CONTRIBUTING` note (inline in `README` is fine) describing the SDD workflow — propose-apply-verify-archive — for future changes
