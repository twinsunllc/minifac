import { z } from "zod";

const PositiveInt = z.number().int().positive();

export const NodeSchema = z
  .object({
    executor: z.string().min(1),
    terminal: z.boolean().default(false),
    max_iterations: PositiveInt.optional(),
    cwd: z.string().optional(),
    with: z.record(z.unknown()).optional(),
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
