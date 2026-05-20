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

export const FactorySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    brief: z.enum(["required", "optional", "none"]).default("required"),
    nodes: z.record(NodeSchema),
    edges: z.array(EdgeSchema),
  })
  .strict();

export type Factory = z.infer<typeof FactorySchema>;
export type FactoryNode = z.infer<typeof NodeSchema>;
export type FactoryEdge = z.infer<typeof EdgeSchema>;
