import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { minifacHome } from "../worktree/config.js";

/**
 * Library resolution — resolver layers 3 (cached remote) and 4 (fetch
 * fresh) from docs/concepts/Reference.md, scoped to one library per project.
 * See docs/decisions/0039-Library-Namespace.md.
 *
 * A project declares `library: { repo, ref }` in `.minifac/config.yaml` or in
 * a factory-repo `factory.yaml` manifest. `ref` must be an immutable pin — a
 * tag or a full 40-hex commit sha. The repo is mirrored under
 * `$MINIFAC_HOME/cache/library/<repo-key>/mirror.git`, and each resolved sha
 * is materialized once, content-addressed, at `<repo-key>/<sha>/`.
 */

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly sourcePath: string,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

export interface LibraryDeclaration {
  repo: string;
  ref: string;
  /** Absolute path of the file that declared the library. */
  declaredIn: string;
}

/** What a run records: enough to answer "which workflow ran". */
export interface LibraryPin {
  repo: string;
  ref: string;
  sha: string;
}

export interface ResolvedLibrary extends LibraryPin {
  url: string;
  declaredIn: string;
  /** Absolute path of the materialized tree at `sha`. */
  root: string;
}

/** Everything the step / extends resolvers need to know about a project. */
export interface ProjectLayout {
  /** The pinned library, when the project declares one. */
  library?: ResolvedLibrary;
  /**
   * True when the project root carries a `factory.yaml` manifest, which
   * opts it into the factory-repo layout: root `steps/` and `workflows/`
   * join `.minifac/` as the local layer.
   */
  factoryRepo: boolean;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SHORT_SHA_RE = /^[0-9a-f]{4,39}$/;
// A bare ref name: what a tag can be called. Rejects revision expressions
// (`main~1`, `v1^{}`, `a..b`), `refs/...` spellings, and a leading `-` that
// git would read as an option.
const REF_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const GITHUB_SHORTHAND_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const GIT_TIMEOUT_MS = 120_000;

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readYamlMapping(file: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LibraryError(`Could not read ${file}: ${(err as Error).message}`, file);
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new LibraryError(`YAML parse error in ${file}: ${doc.errors[0]?.message}`, file);
  }
  const data = doc.toJS() as unknown;
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

function parseDeclaration(value: unknown, file: string): LibraryDeclaration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LibraryError(
      `\`library:\` in ${file} must be a mapping with \`repo\` and \`ref\``,
      file,
    );
  }
  const { repo, ref, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new LibraryError(
      `\`library:\` in ${file} has unknown key(s): ${extra.join(", ")} (expected \`repo\` and \`ref\`)`,
      file,
    );
  }
  if (typeof repo !== "string" || repo.length === 0) {
    throw new LibraryError(`\`library.repo\` in ${file} must be a non-empty string`, file);
  }
  if (typeof ref !== "string" || ref.length === 0) {
    throw new LibraryError(
      `\`library.ref\` in ${file} must be a tag or a full 40-character commit sha`,
      file,
    );
  }
  if (!REF_NAME_RE.test(ref) || ref.includes("..") || ref === "HEAD" || ref.startsWith("refs/")) {
    throw new LibraryError(
      `\`library.ref: ${ref}\` in ${file} is not an immutable pin; use a tag name or a full 40-character commit sha`,
      file,
    );
  }
  repoUrl(repo, file); // validates
  return { repo, ref, declaredIn: file };
}

/**
 * Read the project's library declaration. Two places are honoured:
 * `<root>/.minifac/config.yaml` (minifac-native) and `<root>/factory.yaml`
 * (the factory-repo manifest). Declaring it in both is an error — two
 * sources of truth for one pin is how pins drift.
 */
export async function readLibraryDeclaration(
  projectRoot: string,
): Promise<LibraryDeclaration | undefined> {
  const files = [
    path.join(projectRoot, ".minifac", "config.yaml"),
    path.join(projectRoot, "factory.yaml"),
  ];
  const found: LibraryDeclaration[] = [];
  for (const file of files) {
    const data = await readYamlMapping(file);
    if (data === undefined || data.library === undefined) continue;
    found.push(parseDeclaration(data.library, file));
  }
  if (found.length > 1) {
    throw new LibraryError(
      `A library is declared in both ${found[0]?.declaredIn} and ${found[1]?.declaredIn}; declare it in one place`,
      found[1]?.declaredIn ?? projectRoot,
    );
  }
  return found[0];
}

/**
 * Map a `library.repo` value to a git URL. `owner/name` is GitHub shorthand;
 * `https://`, `ssh://`, `file://`, `git@host:path`, and absolute local paths
 * pass through. Anything else (including `ext::` transports) is refused.
 */
export function repoUrl(repo: string, declaredIn: string): string {
  if (GITHUB_SHORTHAND_RE.test(repo)) return `https://github.com/${repo}.git`;
  if (/^(https|ssh|file):\/\/\S+$/.test(repo)) return repo;
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/.test(repo)) return repo;
  if (path.isAbsolute(repo)) return repo;
  throw new LibraryError(
    `\`library.repo: ${repo}\` in ${declaredIn} is not \`owner/name\`, a git URL (https://, ssh://, file://, git@host:path), or an absolute path`,
    declaredIn,
  );
}

type GitResult = { ok: true; stdout: string } | { ok: false; stderr: string };

function git(args: string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        // Never block a load on an interactive credential prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr).trim() || err.message;
          resolve({ ok: false, stderr: detail.split("\n").slice(-3).join(" ") });
        } else {
          resolve({ ok: true, stdout: String(stdout) });
        }
      },
    );
  });
}

function cacheDir(url: string, repo: string): string {
  const slug = repo.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return path.join(minifacHome(), "cache", "library", `${slug.slice(-60)}-${hash}`);
}

async function renameIntoPlace(tmp: string, dest: string): Promise<void> {
  try {
    await rename(tmp, dest);
  } catch (err) {
    // A concurrent load won the race; theirs is identical by construction.
    await rm(tmp, { recursive: true, force: true });
    if (!(await dirExists(dest))) throw err;
  }
}

async function readTagPins(file: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    /* absent or unreadable → empty */
  }
  return {};
}

async function revParse(mirror: string, rev: string): Promise<string | undefined> {
  const r = await git(["--git-dir", mirror, "rev-parse", "--verify", "--quiet", rev]);
  return r.ok ? r.stdout.trim() : undefined;
}

/** The remote's default-branch head, for the stale-pin message. */
async function describeRemoteHead(mirror: string, url: string): Promise<string> {
  const r = await git(["--git-dir", mirror, "ls-remote", "--symref", "--", url, "HEAD"]);
  let head = "unknown";
  if (r.ok) {
    const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(r.stdout)?.[1];
    const sha = /^([0-9a-f]{40})\s+HEAD$/m.exec(r.stdout)?.[1];
    if (sha) head = `${branch ?? "HEAD"} at ${sha}`;
  }
  const tags = await git(["--git-dir", mirror, "tag", "--sort=-v:refname"]);
  const latest = tags.ok ? tags.stdout.split("\n")[0]?.trim() : "";
  return latest ? `${head}; latest tag ${latest}` : head;
}

/** Tag → sha, as first resolved, per repo. A moved tag is refused. */
async function resolvePinnedSha(
  decl: LibraryDeclaration,
  url: string,
  mirror: string,
  pinsFile: string,
  offline: string | undefined,
): Promise<string> {
  const { ref, repo, declaredIn } = decl;
  const where = `\`library.ref: ${ref}\` (${declaredIn})`;

  if (FULL_SHA_RE.test(ref)) {
    const commit = await revParse(mirror, `${ref}^{commit}`);
    const reachable =
      commit !== undefined &&
      (await git(["--git-dir", mirror, "for-each-ref", "--count=1", "--contains", ref]).then(
        (r) => r.ok && r.stdout.trim().length > 0,
      ));
    if (reachable) return ref;
    if (offline !== undefined) {
      throw new LibraryError(
        `${where}: commit ${ref} is not cached and ${repo} could not be reached (${offline})`,
        declaredIn,
      );
    }
    throw new LibraryError(
      `${where} is stale: commit ${ref} no longer resolves in ${repo} (not reachable from any branch or tag). The library's current head: ${await describeRemoteHead(mirror, url)}`,
      declaredIn,
    );
  }

  const pins = await readTagPins(pinsFile);
  const tagSha = await revParse(mirror, `refs/tags/${ref}^{commit}`);
  if (tagSha !== undefined) {
    const first = pins[ref];
    if (first !== undefined && first !== tagSha) {
      throw new LibraryError(
        `${where}: tag ${ref} in ${repo} now points at ${tagSha}, but it resolved to ${first} when first fetched. A moved tag is not an immutable pin; pin the full sha you intend.`,
        declaredIn,
      );
    }
    if (first === undefined) {
      pins[ref] = tagSha;
      await writeFile(pinsFile, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
    }
    return tagSha;
  }
  if ((await revParse(mirror, `refs/heads/${ref}`)) !== undefined) {
    throw new LibraryError(
      `${where} names a branch in ${repo}; a branch is not an immutable pin. Use a tag or a full 40-character commit sha.`,
      declaredIn,
    );
  }
  if (SHORT_SHA_RE.test(ref)) {
    throw new LibraryError(
      `${where} looks like an abbreviated commit sha; an abbreviated sha is not an immutable pin. Use the full 40-character sha.`,
      declaredIn,
    );
  }
  if (offline !== undefined) {
    const cached = pins[ref];
    if (cached !== undefined) return cached;
    throw new LibraryError(
      `${where}: tag ${ref} is not cached and ${repo} could not be reached (${offline})`,
      declaredIn,
    );
  }
  throw new LibraryError(
    `${where} is stale: no tag or commit ${ref} in ${repo}. The library's current head: ${await describeRemoteHead(mirror, url)}`,
    declaredIn,
  );
}

async function materialize(mirror: string, sha: string, dest: string): Promise<void> {
  if (await dirExists(dest)) return;
  const tmp = `${dest}.tmp-${randomUUID()}`;
  await mkdir(tmp, { recursive: true });
  // A throwaway index (outside the snapshot) keeps the mirror untouched and
  // the snapshot free of `.git`: the tree at `sha`, nothing else.
  const index = `${tmp}.index`;
  const env = { GIT_INDEX_FILE: index };
  const base = ["--git-dir", mirror, "--work-tree", tmp];
  for (const args of [
    [...base, "read-tree", sha],
    [...base, "checkout-index", "--all"],
  ]) {
    const r = await git(args, env);
    if (!r.ok) {
      await rm(tmp, { recursive: true, force: true });
      await rm(index, { force: true });
      throw new LibraryError(`Could not materialize library commit ${sha}: ${r.stderr}`, mirror);
    }
  }
  await rm(index, { force: true });
  await renameIntoPlace(tmp, dest);
}

/**
 * Fetch (or reuse) the declared library and return its tree at the pinned
 * sha. Layer 4 when the repo has never been mirrored: clone, and a failure
 * is fatal. Layer 3 otherwise: refresh the mirror so a stale pin is caught,
 * and when the remote is unreachable fall back to the cache with a warning.
 */
async function fetchLibrary(decl: LibraryDeclaration): Promise<ResolvedLibrary> {
  const url = repoUrl(decl.repo, decl.declaredIn);
  const dir = cacheDir(url, decl.repo);
  const mirror = path.join(dir, "mirror.git");
  await mkdir(dir, { recursive: true });

  let offline: string | undefined;
  if (!(await dirExists(mirror))) {
    const tmp = `${mirror}.tmp-${randomUUID()}`;
    const r = await git(["clone", "--bare", "--quiet", "--", url, tmp]);
    if (!r.ok) {
      await rm(tmp, { recursive: true, force: true });
      throw new LibraryError(
        `\`library.ref: ${decl.ref}\` (${decl.declaredIn}): ${decl.repo} could not be fetched and nothing is cached (${r.stderr})`,
        decl.declaredIn,
      );
    }
    await renameIntoPlace(tmp, mirror);
  } else {
    const r = await git([
      "--git-dir",
      mirror,
      "fetch",
      "--quiet",
      "--prune",
      "--no-write-fetch-head",
      "--",
      url,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ]);
    if (!r.ok) offline = r.stderr;
  }

  const sha = await resolvePinnedSha(decl, url, mirror, path.join(dir, "tags.json"), offline);
  const root = path.join(dir, sha);
  await materialize(mirror, sha, root);
  if (offline !== undefined) {
    process.emitWarning(
      `library ${decl.repo} could not be reached (${offline}); using cached ${decl.ref} (${sha})`,
      { code: "MINIFAC_LIBRARY_OFFLINE" },
    );
  }
  return { repo: decl.repo, ref: decl.ref, sha, url, declaredIn: decl.declaredIn, root };
}

// One resolution per library pin per process: a CLI invocation resolves the
// factory name and then loads it, and both need the library.
const memo = new Map<string, Promise<ResolvedLibrary>>();

export function resolveLibrary(decl: LibraryDeclaration): Promise<ResolvedLibrary> {
  const key = `${minifacHome()}\0${decl.repo}\0${decl.ref}`;
  let pending = memo.get(key);
  if (pending === undefined) {
    pending = fetchLibrary(decl);
    memo.set(key, pending);
    pending.catch(() => memo.delete(key));
  }
  return pending;
}

/** Forget memoized resolutions. For tests only. */
export function _clearLibraryMemo(): void {
  memo.clear();
}

/**
 * Read the project's layout: its pinned library (fetched and verified) and
 * whether it is a factory repo. Called once per factory load.
 */
export async function loadProjectLayout(projectRoot: string): Promise<ProjectLayout> {
  const decl = await readLibraryDeclaration(projectRoot);
  const factoryRepo = await fileExists(path.join(projectRoot, "factory.yaml"));
  if (decl === undefined) return { factoryRepo };
  return { library: await resolveLibrary(decl), factoryRepo };
}

/** Human-readable `repo@ref (sha)` for error messages. */
export function describeLibrary(lib: LibraryPin): string {
  return `${lib.repo}@${lib.ref} (${lib.sha.slice(0, 12)})`;
}
