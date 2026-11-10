#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

const pkgRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const { marketplace: MKT, plugin: PLUGIN } = pkg.pstackMirror;
const ID = `${PLUGIN}@${MKT}`;
const isWin = process.platform === "win32";
const spawn = isWin ? createRequire(import.meta.url)("cross-spawn").sync : spawnSync;

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
  --dry-run           check current state and print changes without applying them
`;

const opts = { scope: "user", dryRun: false, dir: join(process.env.PSTACK_CLAUDE_HOME || join(homedir(), ".pstack-claude-mirror"), "marketplace") };

function has(bin) {
  const r = spawn(isWin ? "where" : "sh", isWin ? [bin] : ["-c", `command -v ${bin}`], { stdio: "ignore", shell: false });
  return r.status === 0;
}

function targets(args) {
  for (const x of args) if (!["omp", "claude", "all"].includes(x)) die(`unknown target "${x}" (expected omp, claude or all)`);
  const requested = args.length && !args.includes("all") ? [...new Set(args)] : ["omp", "claude"];
  const found = requested.filter(has);
  const missing = requested.filter((x) => !found.includes(x));
  if (args.length && !args.includes("all") && missing.length) die(`not found on PATH: ${missing.join(", ")}`);
  if (!found.length) die("neither omp nor claude was found on PATH");
  for (const m of missing) console.log(`- ${m} not found on PATH, skipping`);
  return found;
}

function die(message) {
  throw new Error(message);
}

function run(bin, args, { query = false } = {}) {
  console.log(`$ ${bin} ${args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ")}`);
  if (opts.dryRun && !query) return "";
  const r = spawn(bin, args, { encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"] });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.stdout && (!query || r.status !== 0)) process.stdout.write(r.stdout);
  if (r.error) die(`could not run ${bin}: ${r.error.message}`);
  if (r.status !== 0) die(`${bin} ${args.join(" ")} failed (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`})`);
  return r.stdout || "";
}

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function canonicalPath(path, rejectFinalSymlink = true) {
  const absolute = resolve(path);
  const stat = statIfPresent(absolute);
  if (stat) {
    if (rejectFinalSymlink && stat.isSymbolicLink()) die(`refusing symlink: ${absolute}`);
    return realpathSync(absolute);
  }
  const parent = dirname(absolute);
  if (parent === absolute) die(`cannot resolve filesystem root: ${absolute}`);
  return join(canonicalPath(parent, false), basename(absolute));
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function inspectDirectory(path) {
  path = canonicalPath(path);
  if (contains(pkgRoot, path) || contains(path, pkgRoot)) die(`marketplace directory overlaps this package: ${path}`);
  const stat = statIfPresent(path);
  if (!stat) return { kind: "absent", path, stat };
  if (!stat.isDirectory()) die(`marketplace path is not a directory: ${path}`);
  if (!readdirSync(path).length) return { kind: "empty", path, stat };
  const markerPath = join(path, ".pstack-mirror.json");
  const markerStat = statIfPresent(markerPath);
  if (!markerStat || !markerStat.isFile() || markerStat.isSymbolicLink()) die(`refusing nonempty directory without a regular ownership marker: ${path}`);
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    die(`cannot read ownership marker ${markerPath}: ${error.message}`);
  }
  const owner = { package: pkg.name, upstream: pkg.pstackMirror.upstream, marketplace: MKT, plugin: PLUGIN };
  if (!isRecord(marker) || Object.entries(owner).some(([key, value]) => marker[key] !== value)) die(`ownership marker does not match this mirror: ${markerPath}`);
  return { kind: "owned", path, stat };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function jsonQuery(bin, args) {
  const output = run(bin, args, { query: true });
  try {
    return JSON.parse(output);
  } catch {
    die(`invalid JSON from ${bin} ${args.join(" ")}`);
  }
}

function sameSource(target, source) {
  if (!text(source) || !isAbsolute(source) || canonicalPath(source) !== opts.dir) {
    die(`${target} already has marketplace "${MKT}" from another source: ${source}`);
  }
}

function inspectOmp() {
  const output = stripVTControlCharacters(run("omp", ["plugin", "marketplace", "list"], { query: true }));
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  const marketplaces = new Map();
  if (lines[0] === "No marketplaces configured") {
    if (lines.length > 2 || (lines.length === 2 && lines[1] !== "Add one with: omp plugin marketplace add <source>")) die("unrecognized OMP marketplace listing");
  } else {
    if (lines[0] !== "Configured Marketplaces:" || lines.length < 2) die("unrecognized OMP marketplace listing");
    for (const line of lines.slice(1)) {
      const row = /^\s{2}([\w.-]+)[ \t]{2,}(.+)$/.exec(line);
      if (!row || !text(row[2]) || marketplaces.has(row[1])) die("invalid or duplicate OMP marketplace row");
      marketplaces.set(row[1], row[2]);
    }
  }
  if (marketplaces.has(MKT)) sameSource("OMP", marketplaces.get(MKT));
  const plugins = jsonQuery("omp", ["plugin", "list", "--json"]);
  if (!isRecord(plugins) || !Array.isArray(plugins.npm) || !Array.isArray(plugins.marketplace)) die("invalid OMP plugin listing");
  const installed = [];
  const seen = new Set();
  for (const plugin of plugins.marketplace) {
    if (!isRecord(plugin) || !text(plugin.id) || !/^[^@\s]+@[^@\s]+$/.test(plugin.id) || !["user", "project"].includes(plugin.scope) || !Array.isArray(plugin.entries)) die("invalid OMP marketplace plugin");
    const key = `${plugin.id}:${plugin.scope}`;
    if (seen.has(key)) die("duplicate OMP marketplace plugin");
    seen.add(key);
    for (const entry of plugin.entries) {
      if (!isRecord(entry) || entry.scope !== plugin.scope) die("invalid OMP plugin entry");
      installed.push({ id: plugin.id, scope: entry.scope });
    }
  }
  return {
    target: "omp",
    marketplace: marketplaces.has(MKT),
    present: installed.some((p) => p.id === ID && p.scope === opts.scope),
    retain: installed.some((p) => p.id.endsWith(`@${MKT}`) && (p.id !== ID || p.scope !== opts.scope)),
  };
}

function inspectClaude() {
  const marketplaces = jsonQuery("claude", ["plugin", "marketplace", "list", "--json"]);
  if (!Array.isArray(marketplaces)) die("invalid Claude Code marketplace listing");
  const seen = new Set();
  for (const marketplace of marketplaces) {
    if (!isRecord(marketplace) || !text(marketplace.name) || seen.has(marketplace.name)) die("invalid or duplicate Claude Code marketplace");
    seen.add(marketplace.name);
    const sourceField = { directory: "path", file: "path", github: "repo", git: "url", url: "url", claudeai: "marketplaceId" }[marketplace.source];
    if (!text(marketplace.source) || typeof sourceField !== "string" || !text(marketplace[sourceField])) die("invalid Claude Code marketplace source");
    if (["directory", "file"].includes(marketplace.source) && !isAbsolute(marketplace.path)) die("invalid Claude Code local marketplace path");
    if (marketplace.scope !== undefined && !["user", "project", "local", "managed"].includes(marketplace.scope)) die("invalid Claude Code marketplace scope");
  }
  const marketplace = marketplaces.find((m) => m.name === MKT);
  if (marketplace) {
    if (marketplace.source !== "directory") die(`Claude Code already has marketplace "${MKT}" from another source: ${marketplace.source}`);
    sameSource("Claude Code", marketplace.path);
  }
  const plugins = jsonQuery("claude", ["plugin", "list", "--json"]);
  if (!Array.isArray(plugins)) die("invalid Claude Code plugin listing");
  const project = canonicalPath(process.cwd(), false);
  const installed = [];
  seen.clear();
  for (const plugin of plugins) {
    if (!isRecord(plugin) || !text(plugin.id) || !/^[^@\s]+@[^@\s]+$/.test(plugin.id) || !["user", "project", "local", "managed", "session", "synced"].includes(plugin.scope)) die("invalid Claude Code plugin");
    const scopedProject = plugin.scope === "project" || plugin.scope === "local";
    if (scopedProject && (!text(plugin.projectPath) || !isAbsolute(plugin.projectPath))) die("invalid Claude Code plugin project path");
    const projectPath = scopedProject ? canonicalPath(plugin.projectPath, false) : null;
    const key = JSON.stringify([plugin.id, plugin.scope, projectPath]);
    if (seen.has(key)) die("duplicate Claude Code plugin installation");
    seen.add(key);
    installed.push({ id: plugin.id, requested: plugin.scope === opts.scope && (!scopedProject || projectPath === project) });
  }
  return {
    target: "claude",
    marketplace: Boolean(marketplace),
    present: installed.some((p) => p.id === ID && p.requested),
    retain: Boolean(marketplace && marketplace.scope !== opts.scope) || installed.some((p) => p.id.endsWith(`@${MKT}`) && (p.id !== ID || !p.requested)),
  };
}

// Claude reads local marketplace content in place, so keep it outside the npm cache.
function stage(directory) {
  const dir = directory.path;
  console.log(`staging ${pkg.name}@${pkg.version} -> ${dir}`);
  if (opts.dryRun) return;
  mkdirSync(dirname(dir), { recursive: true });
  const workspace = mkdtempSync(join(dirname(dir), `.${basename(dir)}.pstack-`));
  const next = join(workspace, "next");
  const backup = join(workspace, "previous");
  let preserveBackup = false;
  try {
    mkdirSync(next);
    for (const name of [".claude-plugin", "plugins"]) cpSync(join(pkgRoot, name), join(next, name), { recursive: true });
    for (const name of readdirSync(pkgRoot)) {
      if ([".claude-plugin", "plugins", "bin", "package.json", "README.md", "node_modules", ".git", ".pstack-mirror.json"].includes(name)) continue;
      cpSync(join(pkgRoot, name), join(next, name), { recursive: true });
    }
    writeFileSync(join(next, ".pstack-mirror.json"), JSON.stringify({ package: pkg.name, version: pkg.version, ...pkg.pstackMirror }, null, 2) + "\n");
    const current = inspectDirectory(dir);
    if (current.path !== dir || current.kind !== directory.kind || current.stat?.dev !== directory.stat?.dev || current.stat?.ino !== directory.stat?.ino) die(`marketplace directory changed during preflight: ${dir}`);
    if (directory.kind !== "absent") renameSync(dir, backup);
    try {
      renameSync(next, dir);
    } catch (error) {
      if (directory.kind !== "absent") {
        try {
          if (statIfPresent(dir)) die(`destination is occupied: ${dir}`);
          renameSync(backup, dir);
        } catch (restoreError) {
          preserveBackup = true;
          die(`staging failed: ${error.message}; restore failed: ${restoreError.message}; previous installation remains at ${backup}`);
        }
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) rmSync(workspace, { recursive: true, force: true });
  }
}

function install(state) {
  const { target, marketplace, present } = state;
  console.log(`\n== ${target === "omp" ? "OMP" : "Claude Code"}`);
  if (marketplace) run(target, ["plugin", "marketplace", "update", MKT]);
  else run(target, ["plugin", "marketplace", "add", opts.dir, ...(target === "claude" ? ["--scope", opts.scope] : [])]);
  if (target === "omp") {
    run(target, ["plugin", present ? "upgrade" : "install", `--scope=${opts.scope}`, ID]);
    console.log("Restart OMP to load pstack.");
  } else {
    run(target, ["plugin", "install", ID, "--scope", opts.scope]);
    console.log("Start a new Claude Code session (or run /reload-plugins) to load pstack.");
  }
}

function uninstall(state) {
  const { target, present, marketplace, retain } = state;
  console.log(`\n== ${target === "omp" ? "OMP" : "Claude Code"}`);
  if (present) run(target, ["plugin", "uninstall", ...(target === "omp" ? [`--scope=${opts.scope}`, ID] : [ID, "--scope", opts.scope])]);
  if (marketplace && !retain) run(target, ["plugin", "marketplace", "remove", MKT, ...(target === "claude" ? ["--scope", opts.scope] : [])]);
  if (marketplace && retain) console.log(`Keeping marketplace "${MKT}" for other installations or scopes.`);
}

try {
  const argv = process.argv.slice(2);
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir" || arg === "--scope") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) die(`${arg} requires a value`);
      opts[arg === "--dir" ? "dir" : "scope"] = value;
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "-h" || arg === "--help") pos.unshift("help");
    else if (arg === "-v" || arg === "--version") pos.unshift("version");
    else if (arg.startsWith("-")) die(`unknown option "${arg}"`);
    else pos.push(arg);
  }
  if (!["user", "project"].includes(opts.scope)) die("--scope must be user or project");
  opts.dir = canonicalPath(opts.dir);
  const [cmd = "help", ...targetArgs] = pos;
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
    case "update":
    case "uninstall": {
      const selected = targets(targetArgs);
      const directory = inspectDirectory(opts.dir);
      const states = selected.map((target) => target === "omp" ? inspectOmp() : inspectClaude());
      if (cmd === "uninstall") {
        for (const state of states) uninstall(state);
        console.log(`\nThe marketplace files remain in ${opts.dir}; delete that directory if no other tool uses it.`);
      } else {
        stage(directory);
        for (const state of states) install(state);
        console.log(`\nDone: ${ID} ${pkg.version}`);
      }
      break;
    }
    default:
      die(`unknown command "${cmd}"\n\n${HELP}`);
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
