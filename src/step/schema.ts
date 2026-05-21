import { z } from "zod";

const INPUT_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const STEP_NAME_RE = /^[a-z][a-z0-9-]*$/;

export const InputTypeSchema = z.enum(["string", "number", "boolean", "array", "object"]);
export type InputType = z.infer<typeof InputTypeSchema>;

const InputDefBase = z
  .object({
    type: InputTypeSchema,
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
  })
  .strict();

export const InputDefSchema = InputDefBase.superRefine((val, ctx) => {
  // required + default conflict
  if (val.required === true && Object.hasOwn(val, "default")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["default"],
      message: "A required input MUST NOT declare a `default`.",
    });
  }

  if (Object.hasOwn(val, "default")) {
    const d = val.default;
    if (!matchesDeclaredType(val.type, d)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: `Default value's type does not match declared \`type: ${val.type}\`.`,
      });
    }
  }
});

export type StepInputDef = z.infer<typeof InputDefSchema>;

export const StepInputsRecord = z.record(InputDefSchema).superRefine((rec, ctx) => {
  for (const key of Object.keys(rec)) {
    if (!INPUT_NAME_RE.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Invalid input name \`${key}\`: must match [a-zA-Z_][a-zA-Z0-9_]*`,
      });
    }
  }
});

export const StepSchema = z
  .object({
    name: z.string().min(1).regex(STEP_NAME_RE, "Step name must match [a-z][a-z0-9-]*"),
    version: z.string().min(1),
    description: z.string().optional(),
    inputs: StepInputsRecord.optional(),
    executor: z.string().min(1),
    with: z.record(z.unknown()),
  })
  .strict();

export type Step = z.infer<typeof StepSchema>;

export function matchesDeclaredType(type: InputType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}
