#!/usr/bin/env node
// Fail if any package in package-lock.json was published less than
// MIN_DEP_AGE_DAYS ago. Defense against publish-then-yank supply-chain
// attacks (nx postinstall worm, several npm typosquats, etc.). See
// docs/decisions/0024-CI-Security-Policy.md for the policy.
//
// Usage:
//   node scripts/check-dep-freshness.mjs            # default 3-day threshold
//   MIN_DEP_AGE_DAYS=7 node scripts/check-dep-freshness.mjs
//   MIN_DEP_AGE_DAYS=0 node scripts/check-dep-freshness.mjs   # disable

import { readFileSync } from "node:fs";

const THRESHOLD_DAYS = Number(process.env.MIN_DEP_AGE_DAYS ?? 3);
const THRESHOLD_MS = THRESHOLD_DAYS * 86_400_000;
const CONCURRENCY = 16;
const REGISTRY = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";

if (THRESHOLD_DAYS === 0) {
  console.log("MIN_DEP_AGE_DAYS=0; freshness check disabled.");
  process.exit(0);
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

function nameFromPath(path) {
  if (!path) return null;
  const segs = path.split("node_modules/");
  const last = segs[segs.length - 1];
  return last || null;
}

const deps = new Map();
for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (!path) continue;
  if (!info?.version) continue;
  if (info.link) continue;
  const name = info.name ?? nameFromPath(path);
  if (!name) continue;
  deps.set(`${name}@${info.version}`, { name, version: info.version });
}

async function fetchPackageTimes(name) {
  const url = `${REGISTRY}/${name}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${name}`);
  }
  const data = await res.json();
  return data.time ?? null;
}

const now = Date.now();
const queue = [...deps.values()];
const total = queue.length;
const violations = [];
const failures = [];
let processed = 0;

async function worker() {
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    const { name, version } = item;
    try {
      const times = await fetchPackageTimes(name);
      if (!times) continue;
      const pub = times[version];
      if (!pub) continue;
      const ageMs = now - new Date(pub).getTime();
      if (ageMs < THRESHOLD_MS) {
        violations.push({ name, version, ageMs, publishedAt: pub });
      }
    } catch (err) {
      failures.push({ name, version, error: err.message });
    }
    processed++;
    if (processed % 25 === 0) {
      process.stderr.write(`  ${processed}/${total} checked\n`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

if (failures.length) {
  console.error(`\n! ${failures.length} package(s) could not be checked:`);
  for (const f of failures.slice(0, 10)) {
    console.error(`  - ${f.name}@${f.version}: ${f.error}`);
  }
  if (failures.length > 10) console.error(`  ... and ${failures.length - 10} more`);
}

if (violations.length) {
  console.error(
    `\n✗ ${violations.length} dependency(ies) published less than ${THRESHOLD_DAYS} days ago:`,
  );
  for (const v of violations.sort((a, b) => a.ageMs - b.ageMs)) {
    const days = (v.ageMs / 86_400_000).toFixed(1);
    console.error(`  - ${v.name}@${v.version}  (${days}d ago, published ${v.publishedAt})`);
  }
  console.error("\nSee docs/decisions/0024-CI-Security-Policy.md for the policy.");
  console.error("Emergency override: set MIN_DEP_AGE_DAYS=0 in the workflow,");
  console.error("with rationale in the PR description.");
  process.exit(1);
}

console.log(`✓ All ${deps.size} resolved dependencies are at least ${THRESHOLD_DAYS} days old.`);
