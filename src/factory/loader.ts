import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { ZodError } from "zod";
import { findUncoveredCycles } from "./cycles.js";
import { type Factory, FactorySchema } from "./schema.js";

export interface LoadedFactory {
  factory: Factory;
  sourcePath: string;
  sourceDir: string;
}

export class FactoryLoadError extends Error {
  constructor(
    message: string,
    readonly sourcePath: string,
    readonly location?: { line: number; col?: number },
  ) {
    super(message);
    this.name = "FactoryLoadError";
  }
}

export async function loadFactory(sourcePath: string): Promise<LoadedFactory> {
  const absolute = path.resolve(sourcePath);
  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (err) {
    throw new FactoryLoadError(`Could not read factory file: ${(err as Error).message}`, absolute);
  }

  const doc = parseDocument(raw, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    if (!e) throw new FactoryLoadError("YAML parse error", absolute);
    const linePos = e.linePos?.[0];
    throw new FactoryLoadError(
      `YAML parse error: ${e.message}`,
      absolute,
      linePos ? { line: linePos.line, col: linePos.col } : undefined,
    );
  }

  const data = doc.toJS();

  let factory: Factory;
  try {
    factory = FactorySchema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const dotted = issue ? issue.path.join(".") : "(root)";
      const detail = issue ? issue.message : "schema validation failed";
      throw new FactoryLoadError(`Schema error at ${dotted}: ${detail}`, absolute);
    }
    throw err;
  }

  validatePostSchema(factory, absolute);

  return {
    factory,
    sourcePath: absolute,
    sourceDir: path.dirname(absolute),
  };
}

function validatePostSchema(factory: Factory, sourcePath: string): void {
  const nodeIds = new Set(Object.keys(factory.nodes));

  for (const edge of factory.edges) {
    if (!nodeIds.has(edge.from)) {
      throw new FactoryLoadError(
        `Edge references undeclared node "from: ${edge.from}"`,
        sourcePath,
      );
    }
    if (!nodeIds.has(edge.to)) {
      throw new FactoryLoadError(`Edge references undeclared node "to: ${edge.to}"`, sourcePath);
    }
  }

  // Start nodes are nodes with no `on_success` inbound edges. `on_failure`
  // edges are recovery flow and don't disqualify a node from being an entry
  // point for the forward flow. See specs/graph-runner/spec.md.
  const onSuccessInbound = new Set<string>();
  for (const edge of factory.edges) {
    if (edge.when === "on_success") onSuccessInbound.add(edge.to);
  }
  const startNodes = [...nodeIds].filter((id) => !onSuccessInbound.has(id));
  if (startNodes.length === 0) {
    throw new FactoryLoadError(
      "Factory has no start node (every node is the target of an `on_success` edge)",
      sourcePath,
    );
  }

  const hasTerminal = Object.values(factory.nodes).some((n) => n.terminal);
  if (!hasTerminal) {
    throw new FactoryLoadError(
      "Factory has no terminal node (mark at least one node with `terminal: true`)",
      sourcePath,
    );
  }

  const uncovered = findUncoveredCycles(factory);
  if (uncovered.length > 0) {
    const cycle = uncovered[0];
    if (cycle) {
      throw new FactoryLoadError(
        `Cycle is not covered by any budget (nodes: ${cycle.nodes.join(", ")}). Add \`max_traversals\` to an edge in the cycle, or \`max_iterations\` to a node in it.`,
        sourcePath,
      );
    }
  }
}
