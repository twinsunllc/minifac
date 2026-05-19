import type { Factory, FactoryNode } from "../factory/schema.js";

export type NodeEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | {
      kind: "status";
      status: "started" | "succeeded" | "failed";
      meta?: unknown;
    };

export interface RunHistoryEntry {
  nodeId: string;
  iteration: number;
  emittedAt: number;
  event: NodeEvent;
}

export interface RunContext {
  factory: Factory;
  history: readonly RunHistoryEntry[];
  nodeId: string;
  iteration: number;
  cwd: string;
}

export type ResolvedNode = FactoryNode & { id: string };

export interface NodeExecutor {
  readonly type: string;
  run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent>;
}
