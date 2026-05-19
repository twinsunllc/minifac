#!/usr/bin/env node
// Copies src/serve/web/** into dist/serve/web/ after `tsc` runs. Plain
// stdlib only.
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const from = path.join(repoRoot, "src", "serve", "web");
const to = path.join(repoRoot, "dist", "serve", "web");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
