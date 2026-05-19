import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { FactoryLoadError, type LoadedFactory, loadFactory } from "../factory/loader.js";

export interface FactoryEntryOk {
  kind: "ok";
  id: string;
  path: string;
  name: string;
  loaded: LoadedFactory;
}

export interface FactoryEntryErr {
  kind: "err";
  id: string;
  path: string;
  error: string;
}

export type FactoryEntry = FactoryEntryOk | FactoryEntryErr;

const YAML_RE = /\.(ya?ml)$/i;

export interface FactoryWatcherOptions {
  /** Receives stderr-style warnings (e.g. basename collisions). */
  warn?: (msg: string) => void;
}

export class FactoryWatcher {
  private readonly entries = new Map<string, FactoryEntry>();
  /** Tracks which absolute path "owns" a given id, so we can warn on collisions
   * but stay deterministic. */
  private readonly idOwner = new Map<string, string>();
  private watcher: FSWatcher | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private readonly warn: (msg: string) => void;

  constructor(
    readonly dir: string,
    options: FactoryWatcherOptions = {},
  ) {
    this.warn = options.warn ?? ((m) => process.stderr.write(`${m}\n`));
  }

  async start(): Promise<void> {
    await this.rescan();
    try {
      this.watcher = watch(this.dir, { persistent: true }, () => {
        this.scheduleRescan();
      });
    } catch (err) {
      this.warn(
        `factory watcher: could not watch ${this.dir} (${(err as Error).message}); factories listed will be a one-shot snapshot.`,
      );
    }
  }

  close(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }

  list(): FactoryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): FactoryEntry | undefined {
    return this.entries.get(id);
  }

  /** Trigger an immediate rescan (used by tests; in normal use scheduleRescan
   * coalesces fs.watch firings). */
  async rescan(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      this.warn(`factory watcher: could not read ${this.dir}: ${(err as Error).message}`);
      return;
    }

    const seen = new Set<string>();
    const candidates: Array<{ id: string; path: string }> = [];
    for (const name of names) {
      if (!YAML_RE.test(name)) continue;
      const id = name.replace(YAML_RE, "");
      const full = path.resolve(this.dir, name);
      candidates.push({ id, path: full });
    }

    // Deterministic order: sort by absolute path so the first-seen wins
    // collisions consistently across rescans.
    candidates.sort((a, b) => a.path.localeCompare(b.path));

    for (const { id, path: p } of candidates) {
      const owner = this.idOwner.get(id);
      if (owner && owner !== p) {
        this.warn(
          `factory watcher: id "${id}" collision between ${owner} and ${p}; keeping ${owner}`,
        );
        continue;
      }
      this.idOwner.set(id, p);
      seen.add(id);
      try {
        const loaded = await loadFactory(p);
        this.entries.set(id, {
          kind: "ok",
          id,
          path: p,
          name: loaded.factory.name,
          loaded,
        });
      } catch (err) {
        const msg =
          err instanceof FactoryLoadError
            ? err.message + (err.location ? ` (line ${err.location.line})` : "")
            : (err as Error).message;
        this.entries.set(id, { kind: "err", id, path: p, error: msg });
      }
    }

    // Drop entries whose source file vanished.
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) {
        this.entries.delete(id);
        this.idOwner.delete(id);
      }
    }
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      this.rescan().catch((err) => {
        this.warn(`factory watcher: rescan error: ${(err as Error).message}`);
      });
    }, 50);
  }
}
