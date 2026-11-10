import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t, marketplace = "No marketplaces configured\n", failure = 0) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-installer-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, "package");
  const bin = join(dir, "executables");
  const home = join(dir, "home");
  for (const path of [pkg, bin, home]) mkdirSync(path);
  cpSync(join(root, "template/bin"), join(pkg, "bin"), { recursive: true });
  const identity = { upstream: "https://example.invalid/upstream.git", marketplace: "pstack-claude", plugin: "pstack", ref: "v1.0.0", commit: "a".repeat(40) };
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "mirror-test", version: "1.0.0", pstackMirror: identity }));
  mkdirSync(join(pkg, ".claude-plugin"));
  mkdirSync(join(pkg, "plugins/pstack"), { recursive: true });
  writeFileSync(join(pkg, ".claude-plugin/marketplace.json"), JSON.stringify({ name: identity.marketplace, plugins: [{ name: identity.plugin, source: "./plugins/pstack" }] }));
  writeFileSync(join(pkg, "plugins/pstack/payload.txt"), "expected plugin content\n");
  const calls = join(dir, "mutations.jsonl");
  const executable = join(bin, "omp");
  writeFileSync(executable, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (args.includes("list")) {\n  if (${failure}) process.exit(${failure});\n  console.log(args.includes("marketplace") ? ${JSON.stringify(marketplace)} : JSON.stringify({npm: [], marketplace: []}));\n} else {\n  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");\n}\n`);
  writeFileSync(join(bin, "package.json"), JSON.stringify({ type: "module" }));
  chmodSync(executable, 0o755);
  if (process.platform === "win32") writeFileSync(`${executable}.cmd`, `@echo off\r\n"${process.execPath}" "${executable}" %*\r\n`);
  const target = join(dir, "target");
  mkdirSync(target);
  const sentinel = join(target, "keep.txt");
  writeFileSync(sentinel, "user-owned data\n");
  return {
    target,
    sentinel,
    calls,
    own() {
      writeFileSync(join(target, ".pstack-mirror.json"), JSON.stringify({ package: "mirror-test", version: "0.9.0", ...identity }));
    },
    install() {
      return spawnSync(process.execPath, [join(pkg, "bin/pstack-claude.mjs"), "install", "omp", "--dir", target], {
        cwd: dir,
        env: { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, NODE_PATH: join(root, "node_modules"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") },
        encoding: "utf8",
      });
    },
  };
}

function assertUntouched(f, result) {
  assert.ok(existsSync(f.sentinel), "preflight rejection must preserve unrelated files");
  assert.equal(readFileSync(f.sentinel, "utf8"), "user-owned data\n");
  assert.notEqual(result.status, 0, "unsafe installation must fail");
  assert.equal(existsSync(f.calls), false, "rejected installation must not mutate CLI state");
}

test("installation refuses an unowned nonempty directory without deleting its files", (t) => {
  const f = fixture(t);
  assertUntouched(f, f.install());
});

test("marketplace source conflict preserves an already managed directory", (t) => {
  const f = fixture(t, "Configured Marketplaces:\n  pstack-claude  https://example.invalid/other.git\n");
  f.own();
  assertUntouched(f, f.install());
});

test("failed marketplace discovery preserves the managed directory", (t) => {
  const f = fixture(t, "", 42);
  f.own();
  assertUntouched(f, f.install());
});

test("the safety fixture can stage an owned directory when preflight succeeds", (t) => {
  const f = fixture(t);
  f.own();
  const result = f.install();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.target, "plugins/pstack/payload.txt"), "utf8"), "expected plugin content\n");
  assert.equal(existsSync(f.sentinel), false);
  assert.equal(JSON.parse(readFileSync(join(f.target, ".pstack-mirror.json"), "utf8")).version, "1.0.0");
  assert.ok(existsSync(f.calls), "successful installation must reach the external CLI");
});
