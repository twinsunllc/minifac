import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  FactoryNode,
  NodeOutputEntry,
  NodeOutputIndex,
  OutputDef,
  OutputDirectoryDef,
  OutputFileDef,
  OutputValueDef,
} from "../factory/schema.js";

export interface ValidateOutputsResult {
  /** Index of outputs that were present (and satisfied — value parses, file
   * found unambiguously, directory non-empty). */
  index: NodeOutputIndex;
  /** Output keys that were declared `required: true` but unsatisfied. */
  missing: string[];
  /** Per-key detail string explaining why an output is unsatisfied. Keys
   * are the same as `missing`. */
  detail: Record<string, string>;
}

interface OutputCheck {
  /** When set, the output was present and the entry is included in the
   * resulting index. */
  entry?: NodeOutputEntry;
  /** When set, the output is considered unsatisfied; for required outputs
   * this turns into a failure. */
  unsatisfied?: string;
}

export interface ValidateDeclaredOutputsOptions {
  /** True when the dispatching executor's `supportsMcp` was true and the
   * runner's per-run MCP server was in scope. Used to enrich the
   * `missing_outputs_detail` strings for absent `value` outputs. */
  mcpAvailable?: boolean;
  /** Optional map of outputs reported via MCP during the dispatch. Keys
   * present here landed via tool call; absent keys never reported via MCP
   * (they may still have landed via the filesystem fallback). */
  mcpReported?: ReadonlyMap<string, "mcp" | "fs"> | null;
}

export async function validateDeclaredOutputs(
  node: FactoryNode,
  outputsDir: string,
  options: ValidateDeclaredOutputsOptions = {},
): Promise<ValidateOutputsResult> {
  const index: NodeOutputIndex = {};
  const missing: string[] = [];
  const detail: Record<string, string> = {};
  const mcpAvailable = options.mcpAvailable === true;
  const mcpReported = options.mcpReported ?? null;

  const outputs = node.outputs;
  if (!outputs) return { index, missing, detail };

  for (const [key, defRaw] of Object.entries(outputs)) {
    const def = defRaw as OutputDef;
    const check = await checkOne(key, def, outputsDir);
    if (check.entry) {
      index[key] = check.entry;
    }
    if (check.unsatisfied !== undefined && def.required) {
      missing.push(key);
      // For absent `value` outputs with MCP in scope, enrich the detail
      // string so the operator sees both the un-called tool and the
      // absent fallback file. Per the `graph-runner` capability's
      // "missing_outputs_detail" requirement.
      const baseDetail = check.unsatisfied;
      if (
        def.type === "value" &&
        mcpAvailable &&
        (mcpReported === null || !mcpReported.has(key))
      ) {
        detail[key] =
          `${baseDetail} (MCP tool mcp__minifac__report_${key} was available but not called; no fallback file at ${key}.json either)`;
      } else {
        detail[key] = baseDetail;
      }
    }
  }

  return { index, missing, detail };
}

async function checkOne(key: string, def: OutputDef, outputsDir: string): Promise<OutputCheck> {
  if (def.type === "value") {
    return checkValue(key, def, outputsDir);
  }
  if (def.type === "file") {
    return checkFile(key, def, outputsDir);
  }
  return checkDirectory(key, def, outputsDir);
}

async function checkValue(
  key: string,
  _def: OutputValueDef,
  outputsDir: string,
): Promise<OutputCheck> {
  const filePath = path.join(outputsDir, `${key}.json`);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(filePath);
  } catch {
    return { unsatisfied: `value output "${key}" not found at ${filePath}` };
  }
  if (!s.isFile()) {
    return { unsatisfied: `value output "${key}" expected a file at ${filePath}` };
  }
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      unsatisfied: `value output "${key}" failed to read at ${filePath}: ${(err as Error).message}`,
    };
  }
  try {
    JSON.parse(contents);
  } catch (err) {
    return {
      unsatisfied: `value output "${key}" failed to parse as JSON at ${filePath}: ${(err as Error).message}`,
    };
  }
  return {
    entry: {
      type: "value",
      path: filePath,
      size: s.size,
      mtime: s.mtimeMs,
    },
  };
}

async function checkFile(
  key: string,
  def: OutputFileDef,
  outputsDir: string,
): Promise<OutputCheck> {
  if (def.filename !== undefined) {
    const filePath = path.join(outputsDir, def.filename);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(filePath);
    } catch {
      return { unsatisfied: `file output "${key}" not found at ${filePath}` };
    }
    if (!s.isFile()) {
      return { unsatisfied: `file output "${key}" expected a file at ${filePath}` };
    }
    return {
      entry: {
        type: "file",
        path: filePath,
        size: s.size,
        mtime: s.mtimeMs,
      },
    };
  }
  // No filename → glob `<key>.*`
  let entries: string[];
  try {
    entries = await readdir(outputsDir);
  } catch {
    return { unsatisfied: `file output "${key}" not found (no files in ${outputsDir})` };
  }
  const prefix = `${key}.`;
  const matches = entries.filter((e) => e.startsWith(prefix) && e.length > prefix.length);
  if (matches.length === 0) {
    return {
      unsatisfied: `file output "${key}" not found (no match for ${prefix}* in ${outputsDir})`,
    };
  }
  if (matches.length > 1) {
    return {
      unsatisfied: `file output "${key}" ambiguous: matched ${matches.length} files: ${matches.join(", ")}`,
    };
  }
  const filename = matches[0] as string;
  const filePath = path.join(outputsDir, filename);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(filePath);
  } catch (err) {
    return {
      unsatisfied: `file output "${key}" stat failed at ${filePath}: ${(err as Error).message}`,
    };
  }
  if (!s.isFile()) {
    return {
      unsatisfied: `file output "${key}" matched non-file entry at ${filePath}`,
    };
  }
  return {
    entry: {
      type: "file",
      path: filePath,
      size: s.size,
      mtime: s.mtimeMs,
    },
  };
}

async function checkDirectory(
  key: string,
  _def: OutputDirectoryDef,
  outputsDir: string,
): Promise<OutputCheck> {
  const dirPath = path.join(outputsDir, key);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(dirPath);
  } catch {
    return { unsatisfied: `directory output "${key}" not found at ${dirPath}` };
  }
  if (!s.isDirectory()) {
    return {
      unsatisfied: `directory output "${key}" expected a directory at ${dirPath}`,
    };
  }
  const walk = await walkDirectory(dirPath);
  if (walk.fileCount === 0) {
    return { unsatisfied: `directory output "${key}" exists but is empty at ${dirPath}` };
  }
  return {
    entry: {
      type: "directory",
      path: dirPath,
      size: walk.totalSize,
      mtime: walk.latestMtime,
    },
  };
}

interface DirWalk {
  fileCount: number;
  totalSize: number;
  latestMtime: number;
}

async function walkDirectory(dir: string): Promise<DirWalk> {
  let fileCount = 0;
  let totalSize = 0;
  let latestMtime = 0;
  async function recurse(current: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(current, name);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await recurse(full);
      } else if (s.isFile()) {
        fileCount += 1;
        totalSize += s.size;
        if (s.mtimeMs > latestMtime) latestMtime = s.mtimeMs;
      }
    }
  }
  await recurse(dir);
  return { fileCount, totalSize, latestMtime };
}

export async function listDirectoryFiles(
  dir: string,
): Promise<Array<{ relativePath: string; size: number }>> {
  const out: Array<{ relativePath: string; size: number }> = [];
  async function recurse(current: string, rel: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    entries.sort();
    for (const name of entries) {
      const full = path.join(current, name);
      const relPath = rel ? path.join(rel, name) : name;
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await recurse(full, relPath);
      } else if (s.isFile()) {
        out.push({ relativePath: relPath, size: s.size });
      }
    }
  }
  await recurse(dir, "");
  return out;
}
