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
}

export type ResolvedNode = FactoryNode & { id: string };

export interface NodeExecutor {
  readonly type: string;
  run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent>;
}
