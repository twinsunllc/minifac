import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * Resolve the installed minifac package's root directory — the directory
 * containing `package.json` and the bundled `examples/`.
 *
 * The compiled file lives at `<pkg-root>/dist/packaging/install-root.js`,
 * so walking up two directories lands at the package root. Cached for the
 * process to avoid repeated `fileURLToPath` cost.
 */
export function installRoot(): string {
  if (cached !== null) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  cached = resolve(here, "..", "..");
  return cached;
}

/**
 * Reset the cached install root. For tests only.
 */
export function _resetInstallRootCache(): void {
  cached = null;
}
