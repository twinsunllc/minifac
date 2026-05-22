import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { _resetInstallRootCache, installRoot } from "./install-root.js";

describe("installRoot", () => {
  it("returns a path whose package.json identifies minifac", async () => {
    _resetInstallRootCache();
    const root = installRoot();
    const pkgPath = path.join(root, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    expect(pkg.name).toBe("@twinsunllc/minifac");
  });

  it("returns the cached value on subsequent calls without recomputing", () => {
    _resetInstallRootCache();
    const first = installRoot();
    const second = installRoot();
    // Reference equality — the cached string is returned directly.
    expect(second).toBe(first);
  });
});
