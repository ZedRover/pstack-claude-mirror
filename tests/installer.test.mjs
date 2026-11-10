import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../", import.meta.url));
const template = new URL("../template/bin/pstack-claude.mjs", import.meta.url);
const fixture = new URL("./fixtures/installer-cli.mjs", import.meta.url);
const marketplace = "pstack-claude";
const plugin = `pstack@${marketplace}`;
const packageInfo = {
  name: "installer-fixture-mirror",
  version: "2.0.0",
  pstackMirror: { upstream: "https://example.invalid/upstream.git", marketplace, plugin: "pstack", ref: "v2.0.0", commit: "b".repeat(40) },
};

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-installer-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "package");
  const bin = join(root, "node_modules", ".bin");
  const cwd = join(root, "project");
  const home = join(root, "home");
  const dir = join(root, "managed marketplace");
  const statePath = join(root, "cli-state.json");
  const logPath = join(root, "cli-calls.jsonl");
  for (const path of [bin, cwd, home, join(source, "bin"), join(source, ".claude-plugin"), join(source, "plugins", "pstack", ".claude-plugin"), join(source, "legal")]) mkdirSync(path, { recursive: true });
  cpSync(template, join(source, "bin", "pstack-claude.mjs"));
  cpSync(fixture, join(root, "driver.mjs"));
  writeFileSync(join(source, "package.json"), JSON.stringify(packageInfo));
  writeFileSync(join(source, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: marketplace, plugins: [{ name: "pstack", source: "./plugins/pstack", version: "2.0.0" }] }));
  writeFileSync(join(source, "plugins", "pstack", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "pstack", version: "2.0.0" }));
  writeFileSync(join(source, "plugins", "pstack", "payload.txt"), "the current plugin payload\n");
  writeFileSync(join(source, "COPYING"), "root license bytes\n");
  writeFileSync(join(source, "legal", "component.txt"), "referenced component license bytes\n");
  writeFileSync(join(source, "NOTICE.md"), "notice bytes\n");
  writeFileSync(logPath, "");
  for (const target of ["omp", "claude"]) {
    const launcher = `#!/usr/bin/env node\nprocess.argv.splice(2, 0, ${JSON.stringify(target)});\nimport(${JSON.stringify(pathToFileURL(join(root, "driver.mjs")).href)});\n`;
    writeFileSync(join(bin, `${target}.mjs`), launcher);
    if (process.platform === "win32") writeFileSync(join(bin, `${target}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${target}.mjs" %*\r\n`);
    else {
      writeFileSync(join(bin, target), launcher);
      chmodSync(join(bin, target), 0o755);
    }
  }
  const state = {
    marketplace,
    plugin,
    responses: {},
    omp: { marketplaces: [], plugins: { npm: [], marketplace: [] } },
    claude: { marketplaces: [], plugins: [] },
  };
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
  Object.assign(env, {
    PATH: `${bin}${delimiter}${process.env.PATH || process.env.Path || ""}`,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    NODE_PATH: join(repository, "node_modules"),
    PSTACK_CLAUDE_HOME: "",
    INSTALLER_FIXTURE_STATE: statePath,
    INSTALLER_FIXTURE_LOG: logPath,
  });
  const f = {
    root, source, cwd, home, dir, state, statePath, logPath,
    save() { writeFileSync(statePath, JSON.stringify(state)); },
    current() { return JSON.parse(readFileSync(statePath, "utf8")); },
    calls() { return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
    mutations() { return f.calls().filter((call) => !call.query); },
    run(args, { dir: destination = dir, env: overrides = {}, nodeArgs = [] } = {}) {
      return spawnSync(process.execPath, [...nodeArgs, join(source, "bin", "pstack-claude.mjs"), ...args, ...(destination === null ? [] : ["--dir", destination])], { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
    },
  };
  f.save();
  return f;
}

function owned(f, dir = f.dir, marker = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".pstack-mirror.json"), JSON.stringify({ package: packageInfo.name, version: "1.0.0", ...packageInfo.pstackMirror, ref: "v1.0.0", commit: "a".repeat(40), ...marker }));
  writeFileSync(join(dir, "previous.txt"), "preserve until the full preflight succeeds\n");
}

function ompPlugin(scope = "user", id = plugin) {
  return { id, scope, entries: [{ scope, version: "1.0.0", installPath: "/fixture/cache" }] };
}

function claudePlugin(f, scope = "user", projectPath = f.cwd, id = plugin) {
  return { id, scope, version: "1.0.0", enabled: true, installPath: join(f.root, "cache"), ...(["project", "local"].includes(scope) ? { projectPath } : {}) };
}

function registered(f, target, { path = f.dir, scope = "user" } = {}) {
  if (target === "omp") {
    f.state.omp.marketplaces = [{ name: marketplace, source: path }];
    f.state.omp.plugins.marketplace = [ompPlugin(scope)];
  } else {
    f.state.claude.marketplaces = [{ name: marketplace, source: "directory", path, installLocation: path, declarationScopes: [scope] }];
    f.state.claude.plugins = [claudePlugin(f, scope)];
  }
  f.save();
}

function snapshot(root, ignored = new Set()) {
  if (!existsSync(root)) return null;
  const result = {};
  function visit(path, name) {
    if (ignored.has(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) result[name] = { link: readlinkSync(path) };
    else if (stat.isDirectory()) {
      result[name] = "directory";
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), `${name}/${entry}`);
    } else result[name] = readFileSync(path).toString("base64");
  }
  visit(root, ".");
  return result;
}

function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function failure(result) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function link(t, target, path, type = "dir") {
  try {
    symlinkSync(target, path, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("creating this symlink requires Windows privileges");
      return false;
    }
    throw error;
  }
}

for (const kind of ["new", "empty"]) {
  test(`${kind} directory installs both plugins and stages complete payload`, (t) => {
    const f = setup(t);
    if (kind === "empty") mkdirSync(f.dir);
    success(f.run(["install", "all"]));
    assert.equal(readFileSync(join(f.dir, "plugins", "pstack", "payload.txt"), "utf8"), "the current plugin payload\n");
    assert.equal(readFileSync(join(f.dir, "COPYING"), "utf8"), "root license bytes\n");
    assert.equal(readFileSync(join(f.dir, "legal", "component.txt"), "utf8"), "referenced component license bytes\n");
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, ".pstack-mirror.json"), "utf8")), { package: packageInfo.name, version: "2.0.0", ...packageInfo.pstackMirror });
    assert.deepEqual(f.calls().filter((call) => call.query).map(({ target, args }) => [target, ...args]), [
      ["omp", "plugin", "marketplace", "list"], ["omp", "plugin", "list", "--json"],
      ["claude", "plugin", "marketplace", "list", "--json"], ["claude", "plugin", "list", "--json"],
    ]);
    assert.deepEqual(f.mutations().map(({ target, args }) => [target, ...args]), [
      ["omp", "plugin", "marketplace", "add", f.dir], ["omp", "plugin", "install", "--scope=user", plugin],
      ["claude", "plugin", "marketplace", "add", f.dir, "--scope", "user"], ["claude", "plugin", "install", plugin, "--scope", "user"],
    ]);
    assert.equal(f.current().omp.plugins.marketplace[0].entries[0].version, "2.0.0");
    assert.equal(f.current().claude.plugins[0].version, "2.0.0");
    assert.deepEqual(readdirSync(dirname(f.dir)).filter((name) => name.includes(".pstack-")), []);
  });
}

test("legacy marker authorizes an owned upgrade across version and ref changes", (t) => {
  const f = setup(t);
  owned(f);
  registered(f, "omp");
  registered(f, "claude");
  success(f.run(["update", "all"]));
  assert.equal(existsSync(join(f.dir, "previous.txt")), false);
  assert.equal(JSON.parse(readFileSync(join(f.dir, ".pstack-mirror.json"), "utf8")).version, "2.0.0");
  assert.deepEqual(f.mutations().map(({ target, args }) => [target, ...args]), [
    ["omp", "plugin", "marketplace", "update", marketplace], ["omp", "plugin", "upgrade", "--scope=user", plugin],
    ["claude", "plugin", "marketplace", "update", marketplace], ["claude", "plugin", "install", plugin, "--scope", "user"],
  ]);
});

for (const command of ["install", "update", "uninstall"]) {
  test(`${command} checks Claude conflicts before any OMP or directory mutation`, (t) => {
    const f = setup(t);
    owned(f);
    registered(f, "omp");
    f.state.claude.marketplaces = [{ name: marketplace, source: "git", url: "https://example.invalid/foreign.git", installLocation: f.dir }];
    f.save();
    const before = snapshot(f.root, new Set([f.logPath]));
    failure(f.run([command, "all"]));
    assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
    assert.deepEqual(f.mutations(), []);
  });
}

for (const [name, marker] of [
  ["foreign package", { package: "another-mirror" }],
  ["foreign upstream", { upstream: "https://example.invalid/other.git" }],
  ["foreign marketplace", { marketplace: "another-marketplace" }],
  ["foreign plugin", { plugin: "another-plugin" }],
]) {
  test(`refuses a marker with ${name}`, (t) => {
    const f = setup(t);
    owned(f, f.dir, marker);
    const before = snapshot(f.dir);
    failure(f.run(["install", "all"]));
    assert.deepEqual(snapshot(f.dir), before);
    assert.deepEqual(f.calls(), []);
  });
}

for (const marker of ["{", "null", "[]"]) {
  test(`refuses malformed ownership marker ${marker}`, (t) => {
    const f = setup(t);
    owned(f);
    writeFileSync(join(f.dir, ".pstack-mirror.json"), marker);
    const before = snapshot(f.dir);
    failure(f.run(["update", "all"]));
    assert.deepEqual(snapshot(f.dir), before);
    assert.deepEqual(f.mutations(), []);
  });
}

test("refuses a regular file as the target", (t) => {
  const f = setup(t);
  writeFileSync(f.dir, "user file\n");
  failure(f.run(["install", "omp"]));
  assert.equal(readFileSync(f.dir, "utf8"), "user file\n");
  assert.deepEqual(f.calls(), []);
});

for (const dangling of [false, true]) {
  test(`refuses a ${dangling ? "dangling" : "final"} directory symlink`, (t) => {
    const f = setup(t);
    const referent = join(f.root, "referent");
    if (!dangling) owned(f, referent);
    if (!link(t, referent, f.dir)) return;
    const before = snapshot(f.root, new Set([f.logPath]));
    failure(f.run(["install", "omp"]));
    assert.equal(lstatSync(f.dir).isSymbolicLink(), true);
    assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
    assert.deepEqual(f.calls(), []);
  });
}

test("refuses a symlink ownership marker without changing its referent", (t) => {
  const f = setup(t);
  owned(f);
  const marker = join(f.dir, ".pstack-mirror.json");
  const external = join(f.root, "external-marker.json");
  cpSync(marker, external);
  rmSync(marker);
  if (!link(t, external, marker, "file")) return;
  const before = snapshot(f.root, new Set([f.logPath]));
  failure(f.run(["update", "omp"]));
  assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
  assert.deepEqual(f.calls(), []);
});

test("canonicalizes existing ancestor aliases and missing nested directories", (t) => {
  const f = setup(t);
  const realParent = join(f.root, "real parent");
  const alias = join(f.root, "parent alias");
  mkdirSync(realParent);
  if (!link(t, realParent, alias)) return;
  const destination = join(alias, "new parent", "marketplace");
  const canonical = join(realParent, "new parent", "marketplace");
  success(f.run(["install", "all"], { dir: destination }));
  assert.equal(f.current().omp.marketplaces[0].source, canonical);
  assert.equal(f.current().claude.marketplaces[0].path, canonical);
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  const state = f.current();
  state.omp.marketplaces[0].source = destination;
  state.claude.marketplaces[0].path = destination;
  writeFileSync(f.statePath, JSON.stringify(state));
  success(f.run(["update", "all"], { dir: canonical }));
  assert.equal(JSON.parse(readFileSync(join(canonical, ".pstack-mirror.json"), "utf8")).version, "2.0.0");
});

for (const relation of ["self", "descendant", "ancestor", "alias descendant"]) {
  test(`refuses package ${relation} as destination`, (t) => {
    const f = setup(t);
    let dir = relation === "self" ? f.source : relation === "ancestor" ? f.root : join(f.source, "new marketplace");
    if (relation === "alias descendant") {
      const alias = join(f.root, "package alias");
      if (!link(t, f.source, alias)) return;
      dir = join(alias, "new marketplace");
    }
    const before = snapshot(f.root, new Set([f.logPath]));
    failure(f.run(["install", "all"], { dir }));
    assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
    assert.deepEqual(f.calls(), []);
  });
}

test("package pathname prefix is not an ancestor relation", (t) => {
  const f = setup(t);
  const dir = `${f.source}-marketplace`;
  success(f.run(["install", "omp"], { dir }));
  assert.equal(f.current().omp.marketplaces[0].source, dir);
  assert.equal(existsSync(join(f.source, "bin", "pstack-claude.mjs")), true);
});

test("OMP source prefix lookalike cannot authorize an upgrade", (t) => {
  const f = setup(t);
  owned(f);
  registered(f, "omp", { path: `${f.dir}-foreign` });
  const before = snapshot(f.dir);
  failure(f.run(["update", "omp"]));
  assert.deepEqual(snapshot(f.dir), before);
  assert.deepEqual(f.mutations(), []);
});

test("a final symlink in a registered source is not an owned source", (t) => {
  const f = setup(t);
  owned(f);
  const alias = join(f.root, "registered alias");
  if (!link(t, f.dir, alias)) return;
  registered(f, "omp", { path: alias });
  const before = snapshot(f.dir);
  failure(f.run(["update", "omp"]));
  assert.deepEqual(snapshot(f.dir), before);
  assert.deepEqual(f.mutations(), []);
});

const badResponses = [
  ["OMP marketplace failure", "omp plugin marketplace list", () => ({ stdout: "No marketplaces configured\n", stderr: "read denied\n", status: 7 })],
  ["OMP unknown text", "omp plugin marketplace list", () => ({ stdout: "Loading marketplaces...\n" })],
  ["OMP truncated header", "omp plugin marketplace list", () => ({ stdout: "Configured Marketplaces:\n" })],
  ["OMP malformed row", "omp plugin marketplace list", () => ({ stdout: `Configured Marketplaces:\n  ${marketplace}\n` })],
  ["OMP duplicate name", "omp plugin marketplace list", (f) => ({ stdout: `Configured Marketplaces:\n  ${marketplace}  ${f.dir}\n  ${marketplace}  ${f.dir}\n` })],
  ["OMP unexpected empty hint", "omp plugin marketplace list", () => ({ stdout: "No marketplaces configured\nwarning: state unreadable\n" })],
  ["OMP plugin failure", "omp plugin list --json", () => ({ stdout: '{"npm":[],"marketplace":[]}', status: 7 })],
  ["OMP plugin invalid JSON", "omp plugin list --json", () => ({ stdout: "{" })],
  ["OMP plugin wrong collection", "omp plugin list --json", () => ({ stdout: '{"npm":[],"marketplace":{}}' })],
  ["OMP plugin invalid entry", "omp plugin list --json", () => ({ stdout: JSON.stringify({ npm: [], marketplace: [{ id: plugin, scope: "user", entries: [{}] }] }) })],
  ["OMP plugin invalid scope", "omp plugin list --json", () => ({ stdout: JSON.stringify({ npm: [], marketplace: [ompPlugin("local")] }) })],
  ["OMP plugin duplicate scope", "omp plugin list --json", () => ({ stdout: JSON.stringify({ npm: [], marketplace: [ompPlugin(), ompPlugin()] }) })],
  ["Claude marketplace failure", "claude plugin marketplace list --json", () => ({ stdout: "[]", status: 7 })],
  ["Claude marketplace prefixed JSON", "claude plugin marketplace list --json", () => ({ stdout: "warning\n[]" })],
  ["Claude marketplace wrong collection", "claude plugin marketplace list --json", () => ({ stdout: "{}" })],
  ["Claude marketplace invalid source", "claude plugin marketplace list --json", () => ({ stdout: JSON.stringify([{ name: marketplace, source: "directory" }]) })],
  ["Claude marketplace nonstring source", "claude plugin marketplace list --json", (f) => ({ stdout: JSON.stringify([{ name: marketplace, source: ["directory"], path: f.dir }]) })],
  ["Claude marketplace cache-only path", "claude plugin marketplace list --json", (f) => ({ stdout: JSON.stringify([{ name: marketplace, source: "directory", installLocation: f.dir }]) })],
  ["Claude marketplace relative path", "claude plugin marketplace list --json", () => ({ stdout: JSON.stringify([{ name: marketplace, source: "directory", path: "relative/path" }]) })],
  ["Claude marketplace duplicate name", "claude plugin marketplace list --json", (f) => ({ stdout: JSON.stringify(Array(2).fill({ name: marketplace, source: "directory", path: f.dir })) })],
  ["Claude plugin failure", "claude plugin list --json", () => ({ stdout: "[]", status: 7 })],
  ["Claude plugin invalid JSON", "claude plugin list --json", () => ({ stdout: "[" })],
  ["Claude plugin wrong collection", "claude plugin list --json", () => ({ stdout: '{"installed":[]}' })],
  ["Claude plugin missing project", "claude plugin list --json", () => ({ stdout: JSON.stringify([{ id: plugin, scope: "project" }]) })],
  ["Claude plugin invalid scope", "claude plugin list --json", () => ({ stdout: JSON.stringify([{ id: plugin, scope: "unknown" }]) })],
  ["Claude plugin duplicate installation", "claude plugin list --json", (f) => ({ stdout: JSON.stringify([claudePlugin(f), claudePlugin(f)]) })],
];
for (const [name, key, response] of badResponses) {
  test(`${name} fails before all-target mutation`, (t) => {
    const f = setup(t);
    owned(f);
    f.state.responses[key] = response(f);
    f.save();
    const before = snapshot(f.root, new Set([f.logPath]));
    failure(f.run(["install", "all"]));
    assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
    assert.deepEqual(f.mutations(), []);
  });
}

test("query diagnostics stay on stderr without corrupting stdout parsing", (t) => {
  const f = setup(t);
  for (const [key, stdout] of [
    ["omp plugin marketplace list", "\u001b[2mNo marketplaces configured\u001b[0m\n\nAdd one with: omp plugin marketplace add <source>\n"],
    ["omp plugin list --json", '{"npm":[],"marketplace":[]}'],
    ["claude plugin marketplace list --json", "[]"],
    ["claude plugin list --json", "[]"],
  ]) f.state.responses[key] = { stdout, stderr: "fixture query diagnostic\n" };
  f.save();
  const result = f.run(["install", "all"]);
  success(result);
  assert.equal(result.stdout.includes("fixture query diagnostic"), false);
  assert.equal(result.stderr.split("fixture query diagnostic").length - 1, 4);
  assert.equal(f.mutations().length, 4);
});

test("OMP complete colored marketplace rows preserve spaces in the source", (t) => {
  const f = setup(t);
  owned(f);
  registered(f, "omp");
  f.state.responses["omp plugin marketplace list"] = { stdout: `\u001b[1mConfigured Marketplaces:\n\u001b[0m\n  \u001b[36m${marketplace}\u001b[0m  \u001b[2m${f.dir}\u001b[0m\n` };
  f.save();
  success(f.run(["update", "omp"]));
  assert.equal(f.current().omp.plugins.marketplace[0].entries[0].version, "2.0.0");
});

for (const command of ["install", "update", "uninstall"]) {
  test(`${command} dry-run queries both targets but makes no writes`, (t) => {
    const f = setup(t);
    if (command !== "install") {
      owned(f);
      registered(f, "omp");
      registered(f, "claude");
    }
    const before = snapshot(f.root, new Set([f.logPath]));
    success(f.run([command, "all", "--dry-run"]));
    assert.equal(f.calls().length, 4);
    assert.equal(f.calls().every((call) => call.query), true);
    assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
  });
}

for (const problem of ["conflict", "query failure"]) {
  test(`dry-run refuses a ${problem} without mutation`, (t) => {
    const f = setup(t);
    if (problem === "conflict") f.state.claude.marketplaces = [{ name: marketplace, source: "directory", path: `${f.dir}-foreign` }];
    else f.state.responses["claude plugin list --json"] = { stdout: "[]", status: 7 };
    f.save();
    const before = snapshot(f.root, new Set([f.logPath]));
    failure(f.run(["install", "all", "--dry-run"]));
    assert.equal(f.calls().some((call) => call.target === "claude"), true);
    assert.deepEqual(f.mutations(), []);
    assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
  });
}

test("relative PSTACK_CLAUDE_HOME has one absolute path for reporting and install", (t) => {
  const f = setup(t);
  const options = { dir: null, env: { PSTACK_CLAUDE_HOME: "relative mirror home" } };
  const expected = resolve(f.cwd, "relative mirror home", "marketplace");
  const path = f.run(["path"], options);
  success(path);
  assert.equal(path.stdout.trim(), expected);
  const info = f.run(["info"], options);
  success(info);
  assert.equal(JSON.parse(info.stdout).marketplaceDir, expected);
  success(f.run(["install", "all"], options));
  assert.equal(f.current().omp.marketplaces[0].source, expected);
  assert.equal(f.current().claude.marketplaces[0].path, expected);
  assert.equal(existsSync(join(expected, ".pstack-mirror.json")), true);
});

for (const args of [
  ["install", "omp", "--dir"], ["install", "omp", "--scope"], ["uninstall", "omp", "--scope"],
  ["install", "omp", "--dir", "--dry-run"], ["uninstall", "omp", "--scope", "--dry-run"],
  ["install", "omp", "--scope", "local"], ["update", "omp", "--scope", "invalid"], ["uninstall", "omp", "--scope", "local"],
  ["install", "all", "unknown"], ["install", "omp", "--unknown"],
]) {
  test(`rejects invalid arguments ${args.join(" ")} before queries`, (t) => {
    const f = setup(t);
    const before = snapshot(f.root, new Set([f.logPath]));
    failure(f.run(args, { dir: null }));
    assert.deepEqual(f.calls(), []);
    assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
  });
}

for (const target of ["omp", "claude"]) {
  test(`${target} plugin uninstall failure cannot remove the marketplace`, (t) => {
    const f = setup(t);
    owned(f);
    registered(f, target);
    const args = target === "omp" ? ["plugin", "uninstall", "--scope=user", plugin] : ["plugin", "uninstall", plugin, "--scope", "user"];
    f.state.responses[[target, ...args].join(" ")] = { status: 9, stderr: "fixture uninstall denied\n" };
    f.save();
    const before = snapshot(f.dir);
    const result = f.run(["uninstall", target]);
    failure(result);
    assert.equal(result.stderr.includes("fixture uninstall denied"), true);
    assert.deepEqual(f.mutations().map((call) => call.args), [args]);
    assert.deepEqual(snapshot(f.dir), before);
    assert.equal(f.current()[target].marketplaces.length, 1);
  });

  test(`${target} marketplace removal failure is nonzero and preserves source`, (t) => {
    const f = setup(t);
    owned(f);
    registered(f, target);
    if (target === "claude") f.state.claude.marketplaces[0].scope = "user";
    const args = ["plugin", "marketplace", "remove", marketplace, ...(target === "claude" ? ["--scope", "user"] : [])];
    f.state.responses[[target, ...args].join(" ")] = { status: 9, stderr: "fixture marketplace removal denied\n" };
    f.save();
    const before = snapshot(f.dir);
    failure(f.run(["uninstall", target]));
    assert.equal(f.mutations().length, 2);
    assert.deepEqual(f.mutations()[1].args, args);
    assert.equal(f.current()[target].marketplaces.length, 1);
    assert.deepEqual(snapshot(f.dir), before);
  });

  test(`${target} uninstall is idempotent after proven absence and retains source`, (t) => {
    const f = setup(t);
    owned(f);
    registered(f, target);
    if (target === "claude") {
      f.state.claude.marketplaces[0].scope = "user";
      f.save();
    }
    const before = snapshot(f.dir);
    success(f.run(["uninstall", target]));
    const callsAfterRemoval = f.calls().length;
    const mutationsAfterRemoval = f.mutations().length;
    assert.equal(mutationsAfterRemoval, 2);
    assert.equal(f.current()[target].marketplaces.length, 0);
    success(f.run(["uninstall", target]));
    assert.equal(f.mutations().length, mutationsAfterRemoval);
    assert.equal(f.calls().slice(callsAfterRemoval).every((call) => call.query), true);
    assert.equal(f.calls().every((call) => call.target === target), true);
    assert.deepEqual(snapshot(f.dir), before);
  });

  for (const scope of ["user", "project"]) {
    test(`${target} removing ${scope} scope preserves the other scope and marketplace`, (t) => {
      const f = setup(t);
      owned(f);
      registered(f, target, { scope });
      const other = scope === "user" ? "project" : "user";
      if (target === "omp") f.state.omp.plugins.marketplace.push(ompPlugin(other));
      else f.state.claude.plugins.push(claudePlugin(f, other));
      f.save();
      const before = snapshot(f.dir);
      success(f.run(["uninstall", target, "--scope", scope]));
      assert.equal(f.mutations().length, 1);
      assert.equal(f.mutations()[0].args[1], "uninstall");
      const installed = target === "omp" ? f.current().omp.plugins.marketplace : f.current().claude.plugins;
      assert.deepEqual(installed.map((p) => p.scope), [other]);
      assert.equal(f.current()[target].marketplaces.length, 1);
      assert.deepEqual(snapshot(f.dir), before);
    });
  }

  test(`${target} uninstall retains a marketplace used by a different plugin`, (t) => {
    const f = setup(t);
    owned(f);
    registered(f, target);
    const other = `other@${marketplace}`;
    if (target === "omp") f.state.omp.plugins.marketplace.push(ompPlugin("user", other));
    else f.state.claude.plugins.push(claudePlugin(f, "user", f.cwd, other));
    f.save();
    success(f.run(["uninstall", target]));
    assert.equal(f.mutations().length, 1);
    assert.equal(f.current()[target].marketplaces.length, 1);
    const installed = target === "omp" ? f.current().omp.plugins.marketplace : f.current().claude.plugins;
    assert.deepEqual(installed.map((p) => p.id), [other]);
  });
}

test("Claude project uninstall does not target a different project", (t) => {
  const f = setup(t);
  owned(f);
  registered(f, "claude", { scope: "project" });
  f.state.claude.plugins[0].projectPath = join(f.root, "another project");
  f.save();
  const before = snapshot(f.root, new Set([f.logPath]));
  success(f.run(["uninstall", "claude", "--scope", "project"]));
  assert.deepEqual(f.mutations(), []);
  assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
});

test("Claude project uninstall keeps a marketplace whose declaration scope is unknown", (t) => {
  const f = setup(t);
  owned(f);
  registered(f, "claude", { scope: "project" });
  success(f.run(["uninstall", "claude", "--scope", "project"]));
  assert.deepEqual(f.mutations().map((call) => call.args), [["plugin", "uninstall", plugin, "--scope", "project"]]);
  assert.deepEqual(f.current().claude.plugins, []);
  assert.equal(f.current().claude.marketplaces.length, 1);
  const count = f.mutations().length;
  success(f.run(["uninstall", "claude", "--scope", "project"]));
  assert.equal(f.mutations().length, count);
});

test("Claude user uninstall after project-only uninstall preserves unknown registration", (t) => {
  const f = setup(t);
  success(f.run(["install", "claude", "--scope", "project"]));
  success(f.run(["uninstall", "claude", "--scope", "project"]));
  const before = snapshot(f.root, new Set([f.logPath]));
  const mutations = f.mutations().length;
  success(f.run(["uninstall", "claude"]));
  assert.equal(f.mutations().length, mutations);
  assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
});

test("Claude user uninstall retains a marketplace with unknown declaration scope", (t) => {
  const f = setup(t);
  owned(f);
  registered(f, "claude");
  success(f.run(["uninstall", "claude"]));
  assert.deepEqual(f.current().claude.plugins, []);
  assert.equal(f.current().claude.marketplaces.length, 1);
  assert.deepEqual(f.mutations().map((call) => call.args), [["plugin", "uninstall", plugin, "--scope", "user"]]);
  const mutations = f.mutations().length;
  success(f.run(["uninstall", "claude"]));
  assert.equal(f.mutations().length, mutations);
});

test("Claude known project marketplace removal stays scoped", (t) => {
  const f = setup(t);
  owned(f);
  registered(f, "claude", { scope: "project" });
  f.state.claude.marketplaces[0].scope = "project";
  f.save();
  success(f.run(["uninstall", "claude", "--scope", "project"]));
  assert.deepEqual(f.mutations()[1].args, ["plugin", "marketplace", "remove", marketplace, "--scope", "project"]);
  assert.equal(f.current().claude.marketplaces.length, 0);
});

test("copy failure leaves the previous owned directory and CLI state untouched", (t) => {
  const f = setup(t);
  owned(f);
  registered(f, "omp");
  rmSync(join(f.source, "plugins"), { recursive: true });
  const before = snapshot(f.root, new Set([f.logPath]));
  failure(f.run(["update", "omp"]));
  assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
  assert.deepEqual(f.mutations(), []);
});

test("marketplace path shell metacharacters remain a single CLI argument", (t) => {
  const f = setup(t);
  const dir = join(f.root, "marketplace & echo NOT_A_COMMAND (data)");
  success(f.run(["install", "all"], { dir }));
  const adds = f.mutations().filter((call) => call.args[1] === "marketplace" && call.args[2] === "add");
  assert.equal(adds.length, 2);
  assert.equal(adds.every((call) => call.args[3] === dir), true);
  assert.equal(readFileSync(join(dir, "plugins", "pstack", "payload.txt"), "utf8"), "the current plugin payload\n");
});

test("project install and update use only project-scoped plugin commands", (t) => {
  const f = setup(t);
  success(f.run(["install", "all", "--scope", "project"]));
  success(f.run(["update", "all", "--scope", "project"]));
  const commands = f.mutations().filter((call) => ["install", "upgrade"].includes(call.args[1]));
  assert.deepEqual(commands.map(({ target, args }) => [target, ...args]), [
    ["omp", "plugin", "install", "--scope=project", plugin],
    ["claude", "plugin", "install", plugin, "--scope", "project"],
    ["omp", "plugin", "upgrade", "--scope=project", plugin],
    ["claude", "plugin", "install", plugin, "--scope", "project"],
  ]);
  assert.deepEqual(f.current().omp.plugins.marketplace.map((p) => p.scope), ["project"]);
  assert.deepEqual(f.current().claude.plugins.map((p) => [p.scope, p.projectPath]), [["project", f.cwd]]);
});

test("uninstall succeeds without writes when both tools and source are already absent", (t) => {
  const f = setup(t);
  const before = snapshot(f.root, new Set([f.logPath]));
  success(f.run(["uninstall", "all"]));
  success(f.run(["uninstall", "all"]));
  assert.equal(f.calls().length, 8);
  assert.deepEqual(f.mutations(), []);
  assert.deepEqual(snapshot(f.root, new Set([f.logPath])), before);
});

test("duplicate selected targets do not repeat their mutations", (t) => {
  const f = setup(t);
  success(f.run(["install", "omp", "omp"]));
  assert.equal(f.calls().length, 4);
  assert.equal(f.mutations().length, 2);
  assert.equal(f.calls().every((call) => call.target === "omp"), true);
});

test("OMP empty listing without the optional hint permits install", (t) => {
  const f = setup(t);
  f.state.responses["omp plugin marketplace list"] = { stdout: "No marketplaces configured\n" };
  f.save();
  success(f.run(["install", "omp"]));
  assert.equal(f.current().omp.marketplaces[0].source, f.dir);
  assert.equal(f.current().omp.plugins.marketplace[0].entries[0].version, "2.0.0");
});

for (const failRestore of [false, true]) {
  test(`failed staged rename ${failRestore ? "preserves and reports the backup when restore fails" : "restores the previous directory"}`, (t) => {
    const f = setup(t);
    owned(f);
    registered(f, "omp");
    const before = snapshot(f.dir);
    const result = f.run(["update", "omp"], {
      nodeArgs: ["--require", fileURLToPath(new URL("./fixtures/installer-rename-errors.cjs", import.meta.url))],
      env: { INSTALLER_RENAME_TARGET: f.dir, INSTALLER_RESTORE_FAILURE: failRestore ? "1" : "0" },
    });
    failure(result);
    assert.deepEqual(f.mutations(), []);
    const workspaces = readdirSync(f.root).filter((name) => name.startsWith(`.${f.dir.split(/[\\/]/).pop()}.pstack-`));
    if (failRestore) {
      assert.equal(existsSync(f.dir), false);
      assert.equal(workspaces.length, 1);
      const backup = join(f.root, workspaces[0], "previous");
      assert.deepEqual(snapshot(backup), before);
      assert.equal(result.stderr.includes(backup), true);
    } else {
      assert.deepEqual(snapshot(f.dir), before);
      assert.deepEqual(workspaces, []);
    }
  });
}
