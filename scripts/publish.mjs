#!/usr/bin/env node
// node scripts/publish.mjs [--ref <ref>] [--name <name>] [npm publish options]
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sync } from "./sync.mjs";
import { parseReleaseArgs, spawnCommand } from "./release-options.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
let workspace;
try {
  const options = parseReleaseArgs(process.argv.slice(2));
  workspace = mkdtempSync(join(here, ".pstack-release-"));
  const result = sync({ ...options, checkRegistry: true, destination: join(workspace, "package"), npmCwd: here });
  if (result.kind === "built") {
    const publication = spawnCommand("npm", ["publish", result.artifact.directory, "--access=public", "--tag=latest", ...options.npmArgs, "--workspaces=false"], { cwd: here, stdio: "inherit" });
    if (publication.error || publication.signal || publication.status !== 0) {
      console.error("npm publish failed");
      process.exitCode = publication.status || 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
} finally {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}
