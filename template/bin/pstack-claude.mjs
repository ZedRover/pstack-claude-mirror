#!/usr/bin/env node
// Installs the pstack marketplace shipped in this npm package into OMP and/or Claude Code,
// without any GitHub access. See README.md.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const { marketplace: MKT, plugin: PLUGIN } = pkg.pstackMirror;
const ID = `${PLUGIN}@${MKT}`;
const isWin = process.platform === "win32";

const HELP = `${pkg.name} ${pkg.version}: unofficial GitHub mirror of ${pkg.pstackMirror.upstream}\n(upstream ${pkg.pstackMirror.ref} ${pkg.pstackMirror.commit.slice(0, 12)}; not affiliated with the upstream author)

Usage: ${pkg.name.split("/").pop()} <command> [targets...] [options]

Commands:
  install [omp|claude|all]    copy the marketplace to a stable directory, add it, install the plugin
  update  [omp|claude|all]    same as install; upgrades an existing installation to this package's version
  uninstall [omp|claude|all]  uninstall the plugin and remove the marketplace
  path                        print the stable marketplace directory
  info                        print package / upstream info

Targets default to every CLI found on PATH (omp, claude).

Options:
  --dir <path>        marketplace directory (default: $PSTACK_CLAUDE_HOME or ~/.pstack-claude-mirror/marketplace)
  --scope <scope>     plugin scope: user (default) or project
  --dry-run           print the commands without running them
`;

const argv = process.argv.slice(2);
const opts = { scope: "user", dryRun: false, dir: process.env.PSTACK_CLAUDE_HOME ? join(process.env.PSTACK_CLAUDE_HOME, "marketplace") : join(homedir(), ".pstack-claude-mirror", "marketplace") };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dir") opts.dir = resolve(argv[++i]);
  else if (a === "--scope") opts.scope = argv[++i];
  else if (a === "--dry-run") opts.dryRun = true;
  else if (a === "-h" || a === "--help") pos.unshift("help");
  else if (a === "-v" || a === "--version") pos.unshift("version");
  else pos.push(a);
}
const [cmd = "help", ...targetArgs] = pos;

function has(bin) {
  const r = spawnSync(isWin ? "where" : "sh", isWin ? [bin] : ["-c", `command -v ${bin}`], { stdio: "ignore" });
  return r.status === 0;
}

function targets() {
  const t = targetArgs.length && !targetArgs.includes("all") ? targetArgs : ["omp", "claude"];
  for (const x of t) if (!["omp", "claude"].includes(x)) die(`unknown target "${x}" (expected omp, claude or all)`);
  const found = t.filter(has);
  const missing = t.filter((x) => !found.includes(x));
  if (targetArgs.length && !targetArgs.includes("all") && missing.length) die(`not found on PATH: ${missing.join(", ")}`);
  if (!found.length) die("neither omp nor claude was found on PATH");
  for (const m of missing) console.log(`- ${m} not found on PATH, skipping`);
  return found;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function run(bin, args, { allowFail = false, capture = false } = {}) {
  console.log(`$ ${bin} ${args.join(" ")}`);
  if (opts.dryRun) return { status: 0, out: "" };
  const r = spawnSync(bin, args, { encoding: "utf8", shell: isWin, stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (!capture && out.trim()) process.stdout.write(out.replace(/^/gm, "  ").replace(/\s*$/, "\n"));
  if (r.status !== 0 && !allowFail) die(`${bin} ${args[0]} ${args[1] || ""} failed (exit ${r.status})`);
  return { status: r.status, out };
}

// Copy the marketplace out of node_modules / the npx cache into a directory that survives
// `npm uninstall` and cache cleaning: Claude Code reads the plugin in place from it.
function stage() {
  const dir = opts.dir;
  console.log(`staging ${pkg.name}@${pkg.version} -> ${dir}`);
  if (opts.dryRun) return dir;
  mkdirSync(dirname(dir), { recursive: true });
  const tmp = `${dir}.new-${process.pid}`;
  const old = `${dir}.old-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const f of [".claude-plugin", "plugins", "LICENSE", "NOTICE.md", "NOTICE-skills.md", "LICENSE-cursor-team-kit", "LICENSE-thermos", "CHANGES.md"]) {
    if (existsSync(join(pkgRoot, f))) cpSync(join(pkgRoot, f), join(tmp, f), { recursive: true });
  }
  writeFileSync(join(tmp, ".pstack-mirror.json"), JSON.stringify({ package: pkg.name, version: pkg.version, ...pkg.pstackMirror }, null, 2) + "\n");
  if (existsSync(dir)) renameSync(dir, old);
  renameSync(tmp, dir);
  rmSync(old, { recursive: true, force: true });
  return dir;
}

function installOmp(dir) {
  console.log("\n== OMP");
  const list = run("omp", ["plugin", "marketplace", "list"], { capture: true, allowFail: true }).out;
  const line = list.split("\n").find((l) => l.trim().split(/\s+/)[0] === MKT);
  if (!line) {
    run("omp", ["plugin", "marketplace", "add", dir]);
  } else {
    if (!opts.dryRun && !line.includes(dir)) {
      die(`OMP already has a marketplace "${MKT}" from another source:\n  ${line.trim()}\nRemove it first: omp plugin marketplace remove ${MKT}`);
    }
    run("omp", ["plugin", "marketplace", "update", MKT]);
  }
  const installed = run("omp", ["plugin", "list", "--json"], { capture: true, allowFail: true }).out;
  let present = false;
  try {
    present = JSON.parse(installed).marketplace.some((p) => p.id === ID && p.entries.some((e) => e.scope === opts.scope));
  } catch {}
  if (present) run("omp", ["plugin", "upgrade", `--scope=${opts.scope}`, ID]);
  else run("omp", ["plugin", "install", `--scope=${opts.scope}`, ID]);
  console.log("Restart OMP to load pstack.");
}

function installClaude(dir) {
  console.log("\n== Claude Code");
  const list = run("claude", ["plugin", "marketplace", "list", "--json"], { capture: true, allowFail: true }).out;
  let existing;
  try {
    existing = JSON.parse(list.slice(list.indexOf("["))).find((m) => m.name === MKT);
  } catch {}
  if (existing && !opts.dryRun && resolve(existing.path || existing.installLocation || "") !== dir) {
    die(`Claude Code already has a marketplace "${MKT}" from another source (${existing.source} ${existing.path || existing.repo || existing.url || ""}).\nRemove it first: claude plugin marketplace remove ${MKT}`);
  }
  if (!existing) run("claude", ["plugin", "marketplace", "add", dir, "--scope", opts.scope === "project" ? "project" : "user"]);
  else run("claude", ["plugin", "marketplace", "update", MKT]);
  run("claude", ["plugin", "install", ID, "--scope", opts.scope]);
  console.log("Start a new Claude Code session (or run /reload-plugins) to load pstack.");
}

function uninstallOmp() {
  console.log("\n== OMP");
  run("omp", ["plugin", "uninstall", `--scope=${opts.scope}`, ID], { allowFail: true });
  run("omp", ["plugin", "marketplace", "remove", MKT], { allowFail: true });
}

function uninstallClaude() {
  console.log("\n== Claude Code");
  run("claude", ["plugin", "uninstall", ID, "--scope", opts.scope], { allowFail: true });
  run("claude", ["plugin", "marketplace", "remove", MKT], { allowFail: true });
}

switch (cmd) {
  case "help":
    console.log(HELP);
    break;
  case "version":
    console.log(pkg.version);
    break;
  case "path":
    console.log(opts.dir);
    break;
  case "info":
    console.log(JSON.stringify({ package: pkg.name, version: pkg.version, root: pkgRoot, marketplaceDir: opts.dir, ...pkg.pstackMirror }, null, 2));
    break;
  case "install":
  case "update": {
    if (!["user", "project"].includes(opts.scope)) die(`--scope must be user or project`);
    const t = targets();
    const dir = stage();
    if (t.includes("omp")) installOmp(dir);
    if (t.includes("claude")) installClaude(dir);
    console.log(`\nDone: ${ID} ${pkg.version}`);
    break;
  }
  case "uninstall": {
    const t = targets();
    if (t.includes("omp")) uninstallOmp();
    if (t.includes("claude")) uninstallClaude();
    console.log(`\nThe marketplace files remain in ${opts.dir}; delete that directory if no other tool uses it.`);
    break;
  }
  default:
    die(`unknown command "${cmd}"\n\n${HELP}`);
}
