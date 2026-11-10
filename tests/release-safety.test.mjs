import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;

test("release skips an already published version without publishing residual dist", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-release-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  const upstream = join(dir, "upstream");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  for (const path of [project, upstream, bin, home]) mkdirSync(path);
  cpSync(join(root, "scripts"), join(project, "scripts"), { recursive: true });
  cpSync(join(root, "template"), join(project, "template"), { recursive: true });
  cpSync(join(root, "package.json"), join(project, "package.json"));
  const upstreamFiles = {
    "VERSION": "1.0.0\n",
    "package.json": JSON.stringify({ name: "upstream", version: "1.0.0", license: "MIT", homepage: "https://example.invalid/upstream" }),
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "upstream", plugins: [{ name: "pstack", version: "1.0.0", source: "./plugins/pstack" }] }),
    "plugins/pstack/.claude-plugin/plugin.json": JSON.stringify({ name: "pstack", version: "1.0.0" }),
    "NOTICE.md": "# NOTICE\n\n| Component | Upstream | Copyright | License | License file |\n| --- | --- | --- | --- | --- |\n| pstack | example | maintainers | MIT | [LICENSE](LICENSE) |\n",
    "README.md": "Fixture upstream\n",
    "LICENSE": readFileSync(join(root, "template/LICENSE-mirror"), "utf8"),
  };
  for (const [name, content] of Object.entries(upstreamFiles)) {
    mkdirSync(dirname(join(upstream, name)), { recursive: true });
    writeFileSync(join(upstream, name), content);
  }
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, NODE_PATH: join(root, "node_modules"), PSTACK_UPSTREAM: upstream, PKG_NAME: "pstack-claude-mirror", npm_config_cache: join(dir, "npm-cache"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Mirror tests", "-c", "user.email=tests@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], ["tag", "v1.0.0"]]) {
    execFileSync("git", args, { cwd: upstream, env, stdio: "pipe" });
  }
  mkdirSync(join(project, "dist"));
  writeFileSync(join(project, "dist/package.json"), JSON.stringify({ name: "unrelated-residual-package", version: "0.1.0" }));
  const published = join(dir, "published.jsonl");
  const fakeNpm = join(bin, "npm");
  writeFileSync(join(bin, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(fakeNpm, `#!${process.execPath}\nimport { appendFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (args[0] === "view") {\n  if (args.includes("pstack-claude-mirror@1.0.0")) console.log(args.includes("--json") ? JSON.stringify("1.0.0") : "1.0.0");\n  else { console.log(JSON.stringify({error: {code: "E404"}})); process.exitCode = 1; }\n} else if (args[0] === "publish") {\n  appendFileSync(${JSON.stringify(published)}, readFileSync("package.json", "utf8") + "\\n");\n} else if (args[0] === "pack") { console.log("[]"); }\nelse { process.exitCode = 2; }\n`);
  chmodSync(fakeNpm, 0o755);
  if (process.platform === "win32") writeFileSync(`${fakeNpm}.cmd`, `@echo off\r\n"${process.execPath}" "${fakeNpm}" %*\r\n`);
  const command = npm ? [process.execPath, [npm, "run", "release"]] : [process.execPath, [join(project, "scripts/publish.mjs")]];
  const result = spawnSync(command[0], command[1], { cwd: project, env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(published), false, "a skipped release must not publish the residual package");
});
