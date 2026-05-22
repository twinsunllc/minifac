import { z } from "zod";

const PositiveInt = z.number().int().positive();

const OUTPUT_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const OutputValueSchema = z
  .object({
    type: z.literal("value"),
    required: z.boolean().default(false),
    description: z.string().optional(),
    // Reserved for future structural typing; accept and pass through any value.
    shape: z.unknown().optional(),
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

export const OutputDefSchema = z.discriminatedUnion("type", [
  OutputValueSchema,
  OutputFileSchema,
  OutputDirectorySchema,
]);

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
  })
  .strict();

export const EdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    max_traversals: PositiveInt.optional(),
    when: z.enum(["on_success", "on_failure"]).default("on_success"),
  })
  .strict();

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
  })
  .strict();

export type FactoryLayer = z.infer<typeof FactoryLayerSchema>;
export type Factory = z.infer<typeof FactorySchema>;
export type FactoryNode = z.infer<typeof NodeSchema>;
export type FactoryEdge = z.infer<typeof EdgeSchema>;
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
