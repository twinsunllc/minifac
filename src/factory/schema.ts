import { z } from "zod";
import { checkOutputSchema } from "./output-schema.js";
import { RoutesSchema } from "./routes.js";
import { ValueConditionSchema } from "./value-edges.js";

const PositiveInt = z.number().int().positive();

const OUTPUT_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const OutputValueSchema = z
  .object({
    type: z.literal("value"),
    required: z.boolean().default(false),
    description: z.string().optional(),
    // Reserved for future structural typing; accept and pass through any value.
    shape: z.unknown().optional(),
    // A JSON Schema (draft 2020-12) the value is validated against at node
    // completion (ADR 0054). Checked here, so an invalid one is a load error.
    schema: z.unknown().optional(),
  })
  .strict();

export const OutputFileSchema = z
  .object({
    type: z.literal("file"),
    required: z.boolean().default(false),
    description: z.string().optional(),
    filename: z
      .string()
      .min(1, "filename must be a non-empty string")
      .refine((s) => !s.includes("/") && !s.includes("\\"), {
        message: "filename must not contain path separators",
      })
      .optional(),
  })
  .strict();

export const OutputDirectorySchema = z
  .object({
    type: z.literal("directory"),
    required: z.boolean().default(false),
    description: z.string().optional(),
  })
  .strict();

export const OutputDefSchema = z
  .discriminatedUnion("type", [OutputValueSchema, OutputFileSchema, OutputDirectorySchema])
  .superRefine((def, ctx) => {
    // The refinement sits on the union because `discriminatedUnion` only
    // accepts plain object members.
    if (def.type !== "value" || def.schema === undefined) return;
    const problem = checkOutputSchema(def.schema);
    if (problem !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schema"],
        message: `invalid JSON Schema: ${problem}`,
      });
    }
  });

export const OutputsMapSchema = z.record(OutputDefSchema).superRefine((map, ctx) => {
  for (const key of Object.keys(map)) {
    if (!OUTPUT_KEY_REGEX.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `output key "${key}" must match ${OUTPUT_KEY_REGEX} (start with a letter or underscore; alphanumeric + underscore only)`,
      });
    }
  }
});

export const NodeSchema = z
  .object({
    executor: z.string().min(1).optional(),
    terminal: z.boolean().default(false),
    max_iterations: PositiveInt.optional(),
    cwd: z.string().optional(),
    with: z.record(z.unknown()).optional(),
    uses: z.string().min(1).optional(),
    inputs: z.record(z.unknown()).optional(),
    outputs: OutputsMapSchema.optional(),
    // Per-node in-turn nudge budget for missing-required-output recovery.
    // The runner reads this after the outputs validator finds an
    // unsatisfied required output; `0` opts the node out of nudging
    // entirely. See `docs/decisions/0028-Node-Outputs-Nudge.md`.
    output_nudge_budget: z.number().int().nonnegative().optional().default(1),
    // Names another node in this factory whose `claude` conversation this
    // node continues instead of starting a fresh one. Topology, not
    // executor payload: the runner resolves the named node's captured
    // session id and threads it to the executor. Reference validation
    // (declared target, no self-resume, matching `cwd`) runs post-schema
    // against the resolved factory — see `validateResume` in `loader.ts`.
    resume: z.string().min(1).optional(),
    // Declares this node a start node even though it has inbound edges:
    // the runner dispatches it when the run begins. Only needed for an
    // entry node inside a cycle (e.g. `propose` when `verify → propose`
    // is an `on_failure` edge). A node with no inbound edge from another
    // node is a start node without it; `false` is the same as omitted.
    // See `startNodeIds` in `start-nodes.ts` and
    // `docs/decisions/0040-Declared-Start-Nodes.md`.
    start: z.boolean().optional(),
    // The nodes this node's result may name as the next to run, each a node
    // id or `{ to, max_traversals }` (ADR 0055). Workflow-only: a step file
    // cannot declare it. The loader synthesizes the node's `next` output and
    // treats every entry as an edge; see `routes.ts`.
    routes: RoutesSchema.optional(),
  })
  .strict();

const OUTCOME_WHENS = ["on_success", "on_failure", "on_error"] as const;

// An edge's `when`: an outcome literal (ADR 0052) or a value condition on one
// of the `from` node's value outputs (ADR 0055). Only the first issue reaches
// the load error, so a failed union reports the value-condition issue for a
// mapping and the supported literals for anything else.
const EdgeWhenSchema = z.union([z.enum(OUTCOME_WHENS), ValueConditionSchema], {
  errorMap: (issue, ctx) => {
    if (issue.code !== z.ZodIssueCode.invalid_union) return { message: ctx.defaultError };
    if (typeof ctx.data === "object" && ctx.data !== null && !Array.isArray(ctx.data)) {
      const inner = issue.unionErrors[1]?.issues[0];
      if (inner) {
        const at = inner.path.length > 0 ? ` at ${inner.path.join(".")}` : "";
        return { message: `invalid value condition${at}: ${inner.message}` };
      }
    }
    return {
      message: `when must be one of ${OUTCOME_WHENS.map((w) => `"${w}"`).join(", ")}, or a value condition { output, equals | in }`,
    };
  },
});

export const EdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    max_traversals: PositiveInt.optional(),
    when: EdgeWhenSchema.default("on_success"),
  })
  .strict();

// A workflow's `uses_services:` selects, by name, services that the
// factory repo's `factory.yaml` manifest defines under `services:` (scarif-spec
// `ec2-per-job-lane`, ruling 3). A workflow never defines a service, so a map
// is refused. minifac carries the list on the resolved factory and does
// nothing else with it; Scarif acts on it. It is NOT inherited through
// `extends:` — only the loaded file's own key counts (see `mergeLayers`).
export const UsesServicesSchema = z
  .array(z.string().min(1, "service name must be a non-empty string"), {
    invalid_type_error: "uses_services must be a list of service names",
  })
  .superRefine((names, ctx) => {
    const seen = new Set<string>();
    for (const [i, name] of names.entries()) {
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate service "${name}"; entries must be unique`,
          path: [i],
        });
      }
      seen.add(name);
    }
  });

// A workflow's `needs:` names the capability tokens its jobs require of the
// worker session that runs them (SCARIFW-2229, scarif-spec
// `workflow-declared-needs`). Scarif reads it when a job is ordered and merges
// it into the job's routing needs; it owns the token vocabulary, so minifac
// checks the shape only. minifac carries the list on the resolved factory and
// does nothing else with it. Like `uses_services:`, it is NOT inherited
// through `extends:` (see `mergeLayers`).
export const NeedsSchema = z
  .array(
    z
      .string()
      .refine((token) => token.trim().length > 0, "capability token must be a non-empty string"),
    { invalid_type_error: "needs must be a list of capability tokens" },
  )
  .superRefine((tokens, ctx) => {
    const seen = new Set<string>();
    for (const [i, token] of tokens.entries()) {
      if (seen.has(token)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate capability token "${token}"; entries must be unique`,
          path: [i],
        });
      }
      seen.add(token);
    }
  });

// Raw schema accepted on disk: the merged-from-disk shape, which may carry
// `extends:` at the top level. Edges and most nodes/top-level fields may be
// omitted in a derived layer (then inherited from the base). The loader runs
// chain resolution → merge → strict layer-level validation through
// `FactoryLayerSchema`; the resolved factory is then validated through
// `FactorySchema` (which forbids `extends:`).
export const FactoryLayerSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    brief: z.enum(["required", "optional", "none"]).optional(),
    nodes: z.record(NodeSchema).optional(),
    edges: z.array(EdgeSchema).optional(),
    extends: z.string().min(1).optional(),
    uses_services: UsesServicesSchema.optional(),
    needs: NeedsSchema.optional(),
  })
  .strict();

// Resolved (post-merge) factory shape. `extends:` is stripped before this
// validates so downstream code never sees it. `name`, `nodes`, `edges` and
// `brief` are required at this stage (with `brief` defaulting).
export const FactorySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    brief: z.enum(["required", "optional", "none"]).default("required"),
    nodes: z.record(NodeSchema),
    edges: z.array(EdgeSchema),
    uses_services: UsesServicesSchema.optional(),
    needs: NeedsSchema.optional(),
  })
  .strict();

export type FactoryLayer = z.infer<typeof FactoryLayerSchema>;
type _FactoryInferred = z.infer<typeof FactorySchema>;
type _NodeInferred = z.infer<typeof NodeSchema>;
// `output_nudge_budget` is `.default(1)` at the schema layer, so parsed
// nodes always carry the field. Exposing the type as optional here keeps
// hand-built node literals (in tests / fixtures) ergonomic; the runner
// still applies `?? 1` defensively at read sites.
export type FactoryNode = Omit<_NodeInferred, "output_nudge_budget"> & {
  output_nudge_budget?: number;
};
export type Factory = Omit<_FactoryInferred, "nodes"> & {
  nodes: Record<string, FactoryNode>;
};
export type FactoryEdge = z.infer<typeof EdgeSchema>;
export type EdgeWhen = FactoryEdge["when"];
export type OutputDef = z.infer<typeof OutputDefSchema>;
export type OutputValueDef = z.infer<typeof OutputValueSchema>;
export type OutputFileDef = z.infer<typeof OutputFileSchema>;
export type OutputDirectoryDef = z.infer<typeof OutputDirectorySchema>;

export type NodeOutputType = "value" | "file" | "directory";

export interface NodeOutputEntry {
  type: NodeOutputType;
  path: string;
  size: number;
  mtime: number;
}

export type NodeOutputIndex = Record<string, NodeOutputEntry>;
