#!/usr/bin/env node
// Publish dist/ unless that exact version is already on the registry.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");
if (!existsSync(join(dist, "package.json"))) {
  console.log("dist/ not built (already published?); nothing to publish");
  process.exit(0);
}
const { name, version } = JSON.parse(readFileSync(join(dist, "package.json"), "utf8"));
let published = false;
try {
  published = execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === version;
} catch {}
if (published) {
  console.log(`${name}@${version} already published; skipping`);
  process.exit(0);
}
const extra = process.argv.slice(2);
execFileSync("npm", ["publish", "--access", "public", ...extra], { cwd: dist, stdio: "inherit" });
