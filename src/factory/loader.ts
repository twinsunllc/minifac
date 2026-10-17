import path from "node:path";
import { validateCommandWith } from "../executor/command.js";
import {
  LibraryError,
  type LibraryGitOptions,
  type LibraryPin,
  type ProjectLayout,
  loadProjectLayout,
} from "../library/library.js";
import { inlineStepIntoNode } from "../step/inline.js";
import { findEntryCycles, findUnbudgetedCycles, findUncoveredCycles } from "./cycles.js";
import { resolveExtendsChain } from "./extends.js";
import { FactoryLoadError } from "./loader-error.js";
import {
  ROUTE_WHEN,
  synthesizeRouteOutputs,
  terminalRoutingNodes,
  validateRoutes,
} from "./routes.js";
import type { Factory, FactoryNode } from "./schema.js";
import { startNodeIds } from "./start-nodes.js";
import { validateValueEdges } from "./value-edges.js";

export { FactoryLoadError };

/**
 * Options for {@link loadFactory}. `env` reaches the library's git children
 * only (see {@link LibraryGitOptions}); `process.env` is never modified.
 * `strictBudgets` turns every `uncovered_cycle` {@link FactoryLoadWarning}
 * into a {@link FactoryLoadError} (ADR 0053); other warnings stay warnings.
 */
export type LoadFactoryOptions = LibraryGitOptions & { strictBudgets?: boolean };

/**
 * A problem that does not stop the factory loading by default, told apart
 * by `code`:
 *
 * - `uncovered_cycle`: an elementary cycle with no budget inside a component
 *   that carries one elsewhere (ADR 0053). It becomes a load error at the
 *   next major version, or now under `strictBudgets`.
 * - `terminal_routes`: a `terminal: true` node that declares `routes:`. Its
 *   success ends the run, so its routes are only ever taken on a judged
 *   failure (ADR 0055).
 */
export type FactoryLoadWarning = UncoveredCycleWarning | TerminalRoutesWarning;

export interface UncoveredCycleWarning {
  code: "uncovered_cycle";
  /** Absolute path of the factory file that was loaded. */
  sourcePath: string;
  /** The uncovered cycle's nodes, in cycle order. */
  nodes: string[];
  /** The edge to cap with `max_traversals`; `when` is its key form
   *  (`edgeWhenKey`), e.g. `on_failure`, `output:result.decision="revise"`,
   *  or `route` for a `routes:` entry. */
  edge: { from: string; to: string; when: string };
  message: string;
}

export interface TerminalRoutesWarning {
  code: "terminal_routes";
  /** Absolute path of the factory file that was loaded. */
  sourcePath: string;
  /** The terminal node that declares `routes:`. */
  node: string;
  message: string;
}

/** The one-line form the CLI writes to stderr for a load warning. */
export function formatFactoryLoadWarning(warning: FactoryLoadWarning): string {
  return `warning: ${warning.sourcePath}: ${warning.message}`;
}

export interface LoadedFactory {
  factory: Factory;
  sourcePath: string;
  sourceDir: string;
  /**
   * The project's pinned library, resolved to a sha, when the project
   * declares one. Recorded on the run so "which workflow ran" is answerable
   * after the fact (ADR 0039).
   */
  library?: LibraryPin;
  /**
   * Load warnings (ADR 0053). {@link loadFactory} always sets it, to `[]`
   * when the factory is clean; it is optional so a `LoadedFactory` built by
   * hand (tests, embedders) still type-checks.
   */
  warnings?: FactoryLoadWarning[];
}

/**
 * Load and validate a factory from `sourcePath`.
 *
 * Load pipeline (in order):
 *   1. Resolve the `extends:` chain → a single merged factory.
 *   2. Validate node-shape rules (`uses:`/`executor:` mutual exclusion etc.).
 *   3. Inline step references on every node that declared `uses:`.
 *   4. Run post-schema validation (cycles, terminal node, edge endpoints).
 *
 * `callerCwd` is the project root. It is used for `extends:` and `uses:`
 * lookup (local: `<callerCwd>/.minifac/`, plus root `steps/` / `workflows/`
 * in a factory repo; built-in: `<callerCwd>/examples/`), and it is where
 * the project's `library:` pin is read from (`.minifac/config.yaml` or
 * `factory.yaml`). A declared library is fetched and verified before
 * anything else resolves, so a branch or stale pin fails the load.
 *
 * `options.env` is merged into the environment of each git child that reaches
 * the library's remote (for example a `GIT_CONFIG_*` insteadOf lending a
 * token), and nowhere else.
 */
export async function loadFactory(
  sourcePath: string,
  callerCwd: string = process.cwd(),
  options: LoadFactoryOptions = {},
): Promise<LoadedFactory> {
  const absolute = path.resolve(sourcePath);
  let layout: ProjectLayout;
  try {
    layout = await loadProjectLayout(callerCwd, options);
  } catch (err) {
    if (err instanceof LibraryError) throw new FactoryLoadError(err.message, absolute);
    throw err;
  }
  const resolved = await resolveExtendsChain(absolute, callerCwd, layout);

  validateNodeShape(resolved.factory, absolute);
  await inlineSteps(resolved.factory, absolute, callerCwd, layout);
  validateCommandNodes(resolved.factory, absolute);
  const warnings = validatePostSchema(resolved.factory, absolute);
  const uncoveredCycles = warnings.filter((w) => w.code === "uncovered_cycle");
  if (options.strictBudgets === true && uncoveredCycles.length > 0) {
    throw new FactoryLoadError(
      `${uncoveredCycles.map((w) => w.message).join(" ")} (Strict budgets refuse uncovered cycles; see docs/decisions/0053-Loop-Budgets-Per-Cycle.md.)`,
      absolute,
    );
  }

  const loaded: LoadedFactory = {
    factory: resolved.factory,
    sourcePath: absolute,
    sourceDir: path.dirname(absolute),
    warnings,
  };
  if (layout.library !== undefined) {
    const { repo, ref, sha } = layout.library;
    loaded.library = { repo, ref, sha };
  }
  return loaded;
}

/**
 * Validate the `uses:` / `executor:` / `with:` / `inputs:` interplay on
 * every node. Runs after schema parse, before step inlining.
 *
 * Beside `uses:`, `with:` may hold exactly one key, `secrets` (an array);
 * `inlineStepIntoNode` merges it into the inlined step's `with` (ADR 0046).
 */
function validateNodeShape(factory: Factory, sourcePath: string): void {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    const n = node as FactoryNode & { uses?: unknown; inputs?: unknown };
    const hasUses = typeof n.uses === "string" && n.uses.length > 0;
    const hasInputs = n.inputs !== undefined;
    const hasExecutor = typeof n.executor === "string" && n.executor.length > 0;
    const hasWith = n.with !== undefined;

    if (hasUses && hasExecutor) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares both \`uses:\` and \`executor:\`; the two are mutually exclusive`,
        sourcePath,
      );
    }
    if (hasUses && hasWith) validateUsesWith(nodeId, n.with, sourcePath);
    if (hasInputs && !hasUses) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`inputs:\` without \`uses:\`; \`inputs:\` is only valid alongside \`uses:\``,
        sourcePath,
      );
    }
    if (!hasUses && !hasExecutor) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares neither \`uses:\` nor \`executor:\`; one is required`,
        sourcePath,
      );
    }
    if (n.uses !== undefined && !hasUses) {
      // covers empty-string and non-string-after-schema (defensive)
      throw new FactoryLoadError(`Node "${nodeId}" has invalid \`uses:\` value`, sourcePath);
    }
  }
}

/**
 * A `with:` beside `uses:` may hold only `secrets`, and `secrets` must be an
 * array. The entries' own shape (a name or `{ name, via }`) is left to the
 * consumer that reads it, as it is for an inline node's `with.secrets`.
 */
function validateUsesWith(nodeId: string, withValue: unknown, sourcePath: string): void {
  // The schema already refuses a non-mapping `with:`; this keeps the rule whole here.
  if (withValue === null || typeof withValue !== "object" || Array.isArray(withValue)) {
    throw new FactoryLoadError(
      `Node "${nodeId}" declares \`uses:\` with a \`with:\` that is not a mapping; beside \`uses:\`, \`with:\` may hold only \`secrets\``,
      sourcePath,
    );
  }
  const keys = Object.keys(withValue);
  const others = keys.filter((k) => k !== "secrets");
  if (others.length > 0) {
    throw new FactoryLoadError(
      `Node "${nodeId}" declares both \`uses:\` and \`with:\` keys other than \`secrets\` (${others.join(", ")}); the two are mutually exclusive, and beside \`uses:\`, \`with:\` may hold only \`secrets\``,
      sourcePath,
    );
  }
  if (keys.length === 0) {
    throw new FactoryLoadError(
      `Node "${nodeId}" declares \`uses:\` with an empty \`with:\`; beside \`uses:\`, \`with:\` may hold only \`secrets\``,
      sourcePath,
    );
  }
  if (!Array.isArray((withValue as { secrets?: unknown }).secrets)) {
    throw new FactoryLoadError(
      `Node "${nodeId}" declares \`with.secrets\` beside \`uses:\` that is not a list`,
      sourcePath,
    );
  }
}

async function inlineSteps(
  factory: Factory,
  factoryPath: string,
  callerCwd: string,
  layout: ProjectLayout,
): Promise<void> {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    const n = node as FactoryNode & { uses?: unknown; inputs?: unknown };
    if (typeof n.uses !== "string" || n.uses.length === 0) continue;
    const inlined = await inlineStepIntoNode({
      factoryPath,
      nodeId,
      node: n,
      callerCwd,
      layout,
    });
    factory.nodes[nodeId] = inlined;
  }
}

/**
 * Validate the `with:` of every `executor: command` node against the command
 * executor's schema (ADR 0051). Runs after step inlining, so it sees the
 * `with:` a `uses:` node resolved to; a step file's own `with:` was already
 * checked when the step loaded, so a failure here names an inline node (or a
 * `with.secrets` a `uses:` node merged in). Other executors are untouched.
 */
function validateCommandNodes(factory: Factory, sourcePath: string): void {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    if (node.executor !== "command") continue;
    const issue = validateCommandWith(node.with);
    if (issue !== null) {
      throw new FactoryLoadError(`Node "${nodeId}" with.${issue}`, sourcePath);
    }
  }
}

/**
 * Validate every `resume:` reference against the resolved factory.
 *
 * Three rules, all load-time (see specs/factory-schema "Node `resume:`
 * field"):
 *
 *   1. the target must be a declared node id;
 *   2. a node may not resume itself;
 *   3. the target's declared `cwd` string must match the declaring node's.
 *
 * Rule 3 is the non-obvious one: `claude` scopes sessions per project
 * directory, so a session started in one cwd is not resumable from a node
 * running in another. Comparison is on the declared (pre-substitution)
 * string — both nodes normally say `{{ run.cwd }}` — because the resolved
 * values don't exist yet at load time.
 *
 * Deliberately NOT checked: reachability. The graph is cyclic by design,
 * so "the target always runs first" isn't statically decidable; an
 * unreachable target fails at dispatch with `resume_unavailable`.
 */
function validateResume(factory: Factory, sourcePath: string, nodeIds: Set<string>): void {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    const target = node.resume;
    if (target === undefined) continue;

    if (target === nodeId) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`resume: ${target}\`; a node cannot resume itself`,
        sourcePath,
      );
    }
    if (!nodeIds.has(target)) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`resume: ${target}\` but no node "${target}" is declared`,
        sourcePath,
      );
    }

    const targetNode = factory.nodes[target];
    const ownCwd = node.cwd;
    const targetCwd = targetNode?.cwd;
    if (ownCwd !== targetCwd) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`resume: ${target}\` but their \`cwd\` differs ("${nodeId}": ${describeCwd(ownCwd)}, "${target}": ${describeCwd(targetCwd)}). A resumed session is scoped to the directory it was started in.`,
        sourcePath,
      );
    }
  }
}

function describeCwd(cwd: string | undefined): string {
  return cwd === undefined ? "<unset>" : `\`${cwd}\``;
}

function validatePostSchema(factory: Factory, sourcePath: string): FactoryLoadWarning[] {
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
  // Routes are edges (ADR 0055): their endpoints are checked here, before
  // start-node inference reads them, and the routing node gets its
  // synthesized `next` output before value edges are checked against outputs.
  validateRoutes(factory, sourcePath);
  synthesizeRouteOutputs(factory, sourcePath);

  // Start nodes are nodes with no inbound edge from another node (any
  // `when`), plus any node declaring `start: true`. See `start-nodes.ts`
  // and specs/graph-runner/spec.md ("Start nodes").
  if (startNodeIds(factory).length === 0) {
    const cycles = findEntryCycles(factory)
      .map((c) => c.nodes.join(" → "))
      .join("; ");
    throw new FactoryLoadError(
      `Factory has no start node: every node has an inbound edge. The graph is entered only through the cycle ${cycles}. Mark the entry node with \`start: true\`, or remove the edge into it.`,
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

  validateResume(factory, sourcePath, nodeIds);
  validateValueEdges(factory, sourcePath);

  const uncovered = findUncoveredCycles(factory);
  if (uncovered.length > 0) {
    const cycle = uncovered[0];
    if (cycle) {
      throw new FactoryLoadError(
        `Cycle is not covered by any budget (nodes: ${cycle.nodes.join(", ")}). Add \`max_traversals\` to an edge or route in the cycle, or \`max_iterations\` to a node in it.`,
        sourcePath,
      );
    }
  }

  const cycleWarnings: FactoryLoadWarning[] = findUnbudgetedCycles(factory).map((c) => ({
    code: "uncovered_cycle",
    sourcePath,
    nodes: c.nodes,
    edge: c.edge,
    message:
      c.edge.when === ROUTE_WHEN
        ? `Cycle ${[...c.nodes, c.nodes[0]].join(" → ")} is not covered by a budget: add \`max_traversals\` to node "${c.edge.from}"'s route to "${c.edge.to}" (\`{ to: ${c.edge.to}, max_traversals: <n> }\`), or \`max_iterations\` to a node in the cycle.`
        : `Cycle ${[...c.nodes, c.nodes[0]].join(" → ")} is not covered by a budget: add \`max_traversals\` to the ${c.edge.when} edge ${c.edge.from} → ${c.edge.to}, or \`max_iterations\` to a node in the cycle.`,
  }));
  const terminalRouteWarnings: FactoryLoadWarning[] = terminalRoutingNodes(factory).map((node) => ({
    code: "terminal_routes",
    sourcePath,
    node,
    message: `Node "${node}" is terminal and declares \`routes:\`: its success ends the run, so its routes are taken only on a judged failure.`,
  }));
  return [...cycleWarnings, ...terminalRouteWarnings];
}
