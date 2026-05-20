import { loadWorktreeConfig } from "../worktree/config.js";
import type { RunStore } from "./run-store.js";
import { SqliteRunStore } from "./sqlite.js";

/**
 * Open the default `RunStore` for the calling repo. Reads merged
 * `~/.minifac/config.yaml` + per-repo `<repo>/.minifac/config.yaml`
 * via `loadWorktreeConfig` and opens the SQLite adapter at the
 * resolved `runs_db` path.
 */
export async function openDefaultRunStore(callerRepoCwd: string): Promise<RunStore> {
  const config = await loadWorktreeConfig(callerRepoCwd);
  return SqliteRunStore.open(config.runsDb);
}
