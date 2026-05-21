import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Regression for ADR 0023: invoking `node <symlink-to-dist/cli.js> --help`
// must run `runCli` and produce the normal help banner. Before the fix the
// guard compared a symlink path against the script's realpath and silently
// no-op'd.
//
// Manual verification path (not automated here): after `npm link` has been
// done once, run `npm run build && minifac --help` and confirm the help
// banner appears. `npm link` itself is intentionally not driven from this
// test — it mutates the user's global npm prefix.
describe("cli symlink invocation", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const distCli = path.join(repoRoot, "dist", "cli.js");
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("runs the CLI when invoked through a symlinked entrypoint", () => {
    if (!existsSync(distCli)) {
      console.warn(
        `skipping: ${distCli} not present — run \`npm run build\` before \`npm test\` to exercise the compiled artifact.`,
      );
      return;
    }

    tmpDir = mkdtempSync(path.join(tmpdir(), "minifac-symlink-"));
    const linkPath = path.join(tmpDir, "minifac");
    symlinkSync(distCli, linkPath);

    const res = spawnSync(process.execPath, [linkPath, "--help"], {
      encoding: "utf8",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage: minifac");
  });
});
