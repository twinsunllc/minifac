import type { Factory, FactoryNode, NodeOutputIndex } from "../factory/schema.js";

export type NodeEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | {
      kind: "status";
      status: "started" | "succeeded" | "failed";
      meta?: unknown;
    };

/**
 * One entry per completed node execution. The runner accumulates these in
 * `priorResults` and threads them into each scheduled node's RunContext.
 * See `docs/decisions/0014-Structured-Prior-Results.md` and
 * `docs/decisions/0027-Node-Outputs.md`.
 */
export interface NodeResult {
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  reason: string | null;
  startedAt: number;
  endedAt: number;
  outputs: NodeOutputIndex | null;
}

/**
 * One event emitted by a node executor, tagged with the emitting node and
 * its iteration. Used as the argument shape for the runner's `onEvent`
 * streaming callback and for raw event persistence in the Runs-DB. NOT
 * accumulated into per-node prompts — that's `priorResults`.
 */
export interface EmittedEvent {
  nodeId: string;
  iteration: number;
  emittedAt: number;
  event: NodeEvent;
}

export interface RunContext {
  factory: Factory;
  priorResults: readonly NodeResult[];
  nodeId: string;
  iteration: number;
  cwd: string;
  /** Absolute path to the per-node-per-iteration outputs directory. The
   * runner creates this directory (mkdirp) before invoking the executor. */
  outputsDir: string;
  /** Absolute path to the per-dispatch `.mcp.json` config file emitted by
   * the runner when the executor's `supportsMcp` is `true` and the run's
   * MCP server is in scope. Executors that speak MCP forward this to their
   * CLI's `--mcp-config` argument. Empty / undefined when the runner has
   * not emitted a config (e.g. unit-test invocations outside the runner,
   * or executors with `supportsMcp: false`). */
  mcpConfigPath?: string;
}

export type ResolvedNode = FactoryNode & { id: string };

export interface NodeExecutor {
  readonly type: string;
  /** Whether the executor's underlying runtime can connect to an MCP server
   * and invoke its tools. When `true`, the runner registers per-node MCP
   * tools for declared `type: "value"` outputs, emits a per-dispatch
   * `.mcp.json`, and threads its path through `ctx.mcpConfigPath`. When
   * `false`, all of the above are skipped and the executor falls back to
   * the filesystem-JSON transport for `value` outputs. See ADR-0029 and
   * the `node-executor` capability's "Executor `supportsMcp` capability
   * flag" requirement. */
  readonly supportsMcp: boolean;
  run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent>;
}
