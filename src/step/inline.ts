import { FactoryLoadError } from "../factory/loader-error.js";
import type { FactoryNode } from "../factory/schema.js";
import { substitute } from "../runner/substitute.js";
import { StepLoadError } from "./loader-error.js";
import { loadStep } from "./loader.js";
import { resolveStepRef } from "./resolve.js";
import { type Step, matchesDeclaredType } from "./schema.js";

const TOKEN_RE = /\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/g;

export interface InlineArgs {
  factoryPath: string;
  nodeId: string;
  node: FactoryNode & { uses?: unknown; inputs?: unknown };
  callerCwd: string;
}

/**
 * The flat node produced by inlining a step into a `uses:` node. Carries
 * the resolved `executor` and `with`, plus a non-enumerable `__inputs`
 * property that the runner reads at dispatch time to resolve
 * `{{ inputs.* }}` tokens.
 */
export type InlinedNode = FactoryNode & {
  /** Non-enumerable. Present on every step-inlined node, absent on inline nodes. */
  readonly __inputs?: Record<string, unknown>;
};

/** Read the inputs map a runner attaches to a step-inlined node. */
export function getInlinedInputs(node: object): Record<string, unknown> | undefined {
  const value = (node as { __inputs?: unknown }).__inputs;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export async function inlineStepIntoNode(args: InlineArgs): Promise<InlinedNode> {
  const { factoryPath, nodeId, node, callerCwd } = args;
  const usesRaw = node.uses;
  if (typeof usesRaw !== "string" || usesRaw.length === 0) {
    throw new FactoryLoadError(`Node "${nodeId}" has invalid \`uses:\` value`, factoryPath);
  }

  let stepPath: string;
  try {
    stepPath = await resolveStepRef(usesRaw, callerCwd);
  } catch (err) {
    if (err instanceof StepLoadError) {
      throw new FactoryLoadError(`Node "${nodeId}": ${err.message}`, factoryPath);
    }
    throw err;
  }

  let step: Step;
  try {
    const loaded = await loadStep(stepPath);
    step = loaded.step;
  } catch (err) {
    if (err instanceof StepLoadError) {
      throw new FactoryLoadError(
        `Node "${nodeId}" step \`${stepPath}\`: ${err.message}`,
        factoryPath,
      );
    }
    throw err;
  }

  const nodeInputsRaw = node.inputs;
  if (
    nodeInputsRaw !== undefined &&
    (typeof nodeInputsRaw !== "object" || nodeInputsRaw === null || Array.isArray(nodeInputsRaw))
  ) {
    throw new FactoryLoadError(`Node "${nodeId}" \`inputs:\` must be an object`, factoryPath);
  }
  const nodeInputs = (nodeInputsRaw as Record<string, unknown> | undefined) ?? {};
  const stepInputs = step.inputs ?? {};

  // Reject unknown input keys
  for (const key of Object.keys(nodeInputs)) {
    if (!Object.hasOwn(stepInputs, key)) {
      throw new FactoryLoadError(
        `Node "${nodeId}" supplies unknown input \`${key}\` for step \`${stepPath}\``,
        factoryPath,
      );
    }
  }

  // Resolved input map: declared step inputs only.
  const resolvedInputs: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(stepInputs)) {
    const supplied = Object.hasOwn(nodeInputs, key) ? nodeInputs[key] : undefined;
    if (supplied === undefined) {
      if (def.required === true) {
        throw new FactoryLoadError(
          `Node "${nodeId}" missing required input \`${key}\` for step \`${stepPath}\``,
          factoryPath,
        );
      }
      if (Object.hasOwn(def, "default")) {
        resolvedInputs[key] = def.default;
      }
      // else: optional, no default — leave absent. `{{ inputs.<key> }}`
      // resolves to "" at dispatch time.
      continue;
    }
    // Templated values: a `{{ brief.* }}` or `{{ run.* }}` token is a
    // string, so a `type: "string"` declaration passes naturally. We
    // skip the type check only for that case.
    if (typeof supplied === "string" && TOKEN_RE.test(supplied)) {
      TOKEN_RE.lastIndex = 0;
      resolvedInputs[key] = supplied;
      continue;
    }
    if (!matchesDeclaredType(def.type, supplied)) {
      const got = describeRuntimeType(supplied);
      throw new FactoryLoadError(
        `Node "${nodeId}" input \`${key}\` type mismatch for step \`${stepPath}\`: declared \`${def.type}\`, got \`${got}\``,
        factoryPath,
      );
    }
    resolvedInputs[key] = supplied;
  }

  // Eagerly substitute `{{ inputs.<name> }}` tokens at inline time using the
  // resolved inputs map. Brief and run tokens stay verbatim (they belong to
  // dispatch time). This makes the resolved factory node show its
  // effective `with:` shape with inputs folded in — useful for snapshots
  // and structural tests, and for steps whose default values are
  // themselves `{{ run.* }}` / `{{ brief.* }}` tokens.
  const inlinedWith: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.with)) {
    if (typeof v === "string") {
      inlinedWith[k] = substitute(v, { inputs: resolvedInputs });
    } else {
      inlinedWith[k] = v;
    }
  }

  // Build the resolved node. Strip `uses:` and `inputs:`; keep
  // node-level fields the source declared.
  const out: FactoryNode = {
    executor: step.executor,
    terminal: node.terminal ?? false,
    with: inlinedWith,
    output_nudge_budget: node.output_nudge_budget,
  };
  if (node.max_iterations !== undefined) out.max_iterations = node.max_iterations;
  if (node.cwd !== undefined) out.cwd = node.cwd;
  if (node.outputs !== undefined) out.outputs = node.outputs;

  // Attach the inputs map as a non-enumerable property so it doesn't
  // appear in serialized factory snapshots but is reachable at runtime.
  Object.defineProperty(out, "__inputs", {
    value: resolvedInputs,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return out as InlinedNode;
}

function describeRuntimeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
