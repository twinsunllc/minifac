export type AuthoringQuestionId =
  | "change"
  | "factory"
  | "background"
  | "what_to_do"
  | "out_of_scope"
  | "acceptance_criteria"
  | "base_branch"
  | "model";

export type FrontmatterKey = "change" | "factory" | "base_branch" | "model" | "mode";

interface FrontmatterQuestion {
  id: AuthoringQuestionId;
  prompt: string;
  required: boolean;
  default?: string;
  applies: "frontmatter";
  frontmatterKey: FrontmatterKey;
}

interface BodySectionQuestion {
  id: AuthoringQuestionId;
  prompt: string;
  required: boolean;
  default?: string;
  applies: "body-section";
  bodyHeading: string;
}

export type AuthoringQuestion = FrontmatterQuestion | BodySectionQuestion;

export type AuthoringAnswers = Partial<Record<AuthoringQuestionId, string>>;

export const AUTHORING_QUESTIONS: readonly AuthoringQuestion[] = [
  {
    id: "change",
    prompt: "Change name (kebab-case)?",
    required: true,
    applies: "frontmatter",
    frontmatterKey: "change",
  },
  {
    id: "factory",
    prompt: "Factory name?",
    required: true,
    default: "sdd",
    applies: "frontmatter",
    frontmatterKey: "factory",
  },
  {
    id: "background",
    prompt: "Background — what problem does this change address, and why now?",
    required: true,
    applies: "body-section",
    bodyHeading: "Background",
  },
  {
    id: "what_to_do",
    prompt: "What to do — the work the factory should accomplish?",
    required: true,
    applies: "body-section",
    bodyHeading: "What to do",
  },
  {
    id: "out_of_scope",
    prompt: "Out of scope — anything the factory should NOT pull forward? (blank to skip)",
    required: false,
    applies: "body-section",
    bodyHeading: "Out of scope",
  },
  {
    id: "acceptance_criteria",
    prompt: "Acceptance criteria — how is 'done' judged?",
    required: true,
    applies: "body-section",
    bodyHeading: "Acceptance criteria",
  },
  {
    id: "base_branch",
    prompt: "Base branch override? (blank to skip; default = caller's HEAD)",
    required: false,
    applies: "frontmatter",
    frontmatterKey: "base_branch",
  },
  {
    id: "model",
    prompt: "Model override? (blank to skip; default = factory config)",
    required: false,
    applies: "frontmatter",
    frontmatterKey: "model",
  },
];

const FRONTMATTER_ORDER: readonly AuthoringQuestionId[] = [
  "change",
  "factory",
  "base_branch",
  "model",
];

const BODY_ORDER: readonly AuthoringQuestionId[] = [
  "background",
  "what_to_do",
  "out_of_scope",
  "acceptance_criteria",
];

const SAFE_YAML_VALUE = /^[A-Za-z0-9._/-]+$/;

function encodeYamlValue(raw: string): string {
  if (raw.length > 0 && SAFE_YAML_VALUE.test(raw)) return raw;
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function frontmatterKeyFor(id: AuthoringQuestionId): FrontmatterKey | undefined {
  const q = AUTHORING_QUESTIONS.find((x) => x.id === id);
  return q && q.applies === "frontmatter" ? q.frontmatterKey : undefined;
}

function bodyHeadingFor(id: AuthoringQuestionId): string | undefined {
  const q = AUTHORING_QUESTIONS.find((x) => x.id === id);
  return q && q.applies === "body-section" ? q.bodyHeading : undefined;
}

export function partialBriefPrefix(nextId: AuthoringQuestionId): string {
  return `> **Note:** Brief is incomplete; the authoring helper exited\n> before the \`${nextId}\` question.\n`;
}

export interface RenderBriefOptions {
  incompleteAt?: AuthoringQuestionId;
}

export function renderBrief(answers: AuthoringAnswers, opts: RenderBriefOptions = {}): string {
  const frontmatterLines: string[] = [];
  for (const id of FRONTMATTER_ORDER) {
    const value = answers[id];
    if (value === undefined || value === "") continue;
    const key = frontmatterKeyFor(id);
    if (!key) continue;
    frontmatterLines.push(`${key}: ${encodeYamlValue(value)}`);
  }

  const bodyParts: string[] = [];
  if (opts.incompleteAt !== undefined) {
    bodyParts.push(partialBriefPrefix(opts.incompleteAt));
  }
  for (const id of BODY_ORDER) {
    const value = answers[id];
    if (value === undefined || value === "") continue;
    const heading = bodyHeadingFor(id);
    if (!heading) continue;
    bodyParts.push(`## ${heading}\n\n${value}\n`);
  }

  const frontmatter = `---\n${frontmatterLines.join("\n")}\n---\n`;
  if (bodyParts.length === 0) return frontmatter;
  return `${frontmatter}\n${bodyParts.join("\n")}`;
}
