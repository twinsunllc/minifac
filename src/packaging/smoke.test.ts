import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Smoke test: pack the project as a tarball, install it into a fresh tmp
 * directory, then run `npx minifac init --with-sdd` and verify that the
 * bundled factory + every `minifac:openspec-*` step ref resolves cleanly
 * inside the installed package — without launching Claude.
 *
 * Opt-in via env var (runs are slow because they invoke `npm pack` and a
 * full `npm install` in a temp directory):
 *
 *     MINIFAC_SMOKE_TEST=1 npm test
 *
 * Approximate runtime: 30–60 seconds on a warm cache; up to a few minutes
 * cold. Not run by default.
 */
const SMOKE_ENABLED = process.env.MINIFAC_SMOKE_TEST === "1";
const describeIfSmoke = SMOKE_ENABLED ? describe : describe.skip;

describeIfSmoke("packaged install smoke test", () => {
  it(
    "npm pack + install + init --with-sdd resolves bundled factory and steps",
    async () => {
      const projectRoot = path.resolve(import.meta.dirname, "..", "..");

      // Pack the project into a tarball and let npm tell us where it went.
      const packStdout = execFileSync("npm", ["pack", "--json"], {
        cwd: projectRoot,
        encoding: "utf8",
      });
      const packResult = JSON.parse(packStdout) as Array<{ filename: string }>;
      const filename = packResult[0]?.filename;
      expect(filename).toBeTruthy();
      const tarballPath = path.join(projectRoot, filename ?? "");

      // Install into a fresh tmp dir.
      const tmp = await mkdtemp(path.join(tmpdir(), "minifac-smoke-"));
      execFileSync("npm", ["init", "-y"], { cwd: tmp, stdio: "ignore" });
      execFileSync("npm", ["install", tarballPath], {
        cwd: tmp,
        stdio: "ignore",
      });

      // Run `npx minifac init --with-sdd` to drop the starter sdd.yaml.
      execFileSync("npx", ["minifac", "init", "--with-sdd"], {
        cwd: tmp,
        stdio: "ignore",
      });
      const starter = await readFile(path.join(tmp, ".minifac", "factories", "sdd.yaml"), "utf8");
      expect(starter).toMatch(/extends:\s*["']?minifac:sdd["']?/);

      // Write a minimal brief.
      await mkdir(path.join(tmp, "inputs"), { recursive: true });
      await writeFile(
        path.join(tmp, "inputs", "smoke-test.md"),
        `---
change: smoke-test
factory: sdd
---

Smoke-test body.
`,
        "utf8",
      );

      // Resolve the factory + steps through the installed package. We
      // import the *installed* copy from node_modules so this exercises
      // the real install root, not the source tree under test.
      const installed = path.join(tmp, "node_modules", "minifac", "dist");
      const { loadFactory } = (await import(
        path.join(installed, "factory", "loader.js")
      )) as typeof import("../factory/loader.js");

      const briefFactoryPath = path.join(tmp, ".minifac", "factories", "sdd.yaml");
      const loaded = await loadFactory(briefFactoryPath, tmp);
      expect(loaded.factory.name).toBe("sdd");
      // The bundled SDD factory wires propose / apply / verify / archive
      // through `minifac:openspec-*` steps; if any failed to resolve,
      // loadFactory would have thrown a FactoryLoadError above.
      expect(Object.keys(loaded.factory.nodes)).toEqual(
        expect.arrayContaining(["propose", "apply", "verify", "archive"]),
      );

      // The bundled steps directory under the installed package should
      // contain every openspec-* yaml referenced by the factory.
      const stepsDir = path.join(tmp, "node_modules", "minifac", "examples", "steps");
      const entries = await readdir(stepsDir);
      for (const expected of [
        "openspec-propose.yaml",
        "openspec-apply.yaml",
        "openspec-verify.yaml",
        "openspec-archive.yaml",
      ]) {
        expect(entries).toContain(expected);
      }
    },
    5 * 60 * 1000,
  );
});
