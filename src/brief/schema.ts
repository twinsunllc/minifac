import { z } from "zod";

export const BriefFrontmatterSchema = z
  .object({
    change: z.string().min(1),
    factory: z.string().min(1),
    base_branch: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.literal("in-place").optional(),
    depends_on: z.array(z.string().min(1)).optional().default([]),
  })
  .passthrough();

export type BriefFrontmatter = z.infer<typeof BriefFrontmatterSchema>;
