import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface InitOptions {
  cwd: string;
  withSdd?: boolean;
  io: {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
}

async function existsPath(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const FACTORIES_README = `# .minifac/factories

Per-repo factory customizations. Each file here is a YAML factory referenced
by name from a brief's \`factory:\` field. A factory file MAY declare a
top-level \`extends:\` that names a base to inherit from:

- \`extends: minifac:<name>\` — extend a built-in factory (e.g.
  \`minifac:sdd\`).
- \`extends: <name>\` — extend another local factory in this directory.

Override semantics are replace-at-node-level: redeclaring a node id replaces
the base's node in full; omitted nodes are inherited from the base.
\`edges:\` is replaced wholesale when declared, inherited when omitted.
`;

const SDD_STARTER = `extends: "minifac:sdd"
`;

export async function initAction(options: InitOptions): Promise<number> {
  const { cwd, withSdd, io } = options;

  const created: string[] = [];
  const preserved: string[] = [];

  try {
    const inputsDir = path.join(cwd, "inputs");
    if (!(await existsPath(inputsDir))) {
      await mkdir(inputsDir, { recursive: true });
      created.push("inputs/");
    }

    const minifacDir = path.join(cwd, ".minifac");
    if (!(await existsPath(minifacDir))) {
      await mkdir(minifacDir, { recursive: true });
      created.push(".minifac/");
    }

    const factoriesDir = path.join(minifacDir, "factories");
    if (!(await existsPath(factoriesDir))) {
      await mkdir(factoriesDir, { recursive: true });
      created.push(".minifac/factories/");
    }

    const readmePath = path.join(factoriesDir, "README.md");
    if (!(await existsPath(readmePath))) {
      await writeFile(readmePath, FACTORIES_README, "utf8");
      created.push(".minifac/factories/README.md");
    }

    if (withSdd) {
      const sddPath = path.join(factoriesDir, "sdd.yaml");
      if (await existsPath(sddPath)) {
        preserved.push(".minifac/factories/sdd.yaml");
      } else {
        await writeFile(sddPath, SDD_STARTER, "utf8");
        created.push(".minifac/factories/sdd.yaml");
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const detail = e.path ? `${e.path}: ${e.message}` : e.message;
    io.stderr.write(`minifac init failed: ${detail}\n`);
    return 1;
  }

  if (created.length === 0 && preserved.length === 0) {
    io.stdout.write("minifac already initialized in this directory.\n");
  } else if (created.length === 0) {
    io.stdout.write(`minifac already initialized; preserved existing ${preserved.join(", ")}.\n`);
  } else {
    const summary = `Created ${created.join(", ")}`;
    const tail = preserved.length > 0 ? `; preserved existing ${preserved.join(", ")}` : "";
    io.stdout.write(`${summary}${tail}.\n`);
  }
  return 0;
}
