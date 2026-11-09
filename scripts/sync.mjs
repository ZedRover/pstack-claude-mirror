#!/usr/bin/env node
// Sync michael-denyer/pstack-claude into dist/ as an npm package.
//
//   node scripts/sync.mjs [--ref <tag|branch|sha>] [--name <npm name>] [--check-registry]
//
// --ref             default: the newest vX.Y.Z tag upstream (a release)
// --name            default: $PKG_NAME or "pstack-claude-mirror"
// --check-registry  exit 0 with "skip=true" in $GITHUB_OUTPUT (or stdout) when
//                   <name>@<version> is already on the registry
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = process.env.PSTACK_UPSTREAM || "https://github.com/michael-denyer/pstack-claude.git";
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const upstreamDir = join(here, ".upstream");
const dist = join(here, "dist");
const template = join(here, "template");

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = opt("--name") || process.env.PKG_NAME || "pstack-claude-mirror";
const checkRegistry = args.includes("--check-registry");

const git = (...a) => execFileSync("git", a, { cwd: upstreamDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

function latestTag() {
  const out = execFileSync("git", ["ls-remote", "--tags", "--refs", UPSTREAM], { encoding: "utf8" });
  const tags = out.split("\n").map((l) => l.split("refs/tags/")[1]).filter((t) => /^v\d+\.\d+\.\d+$/.test(t || ""));
  if (!tags.length) throw new Error("no vX.Y.Z tags upstream; pass --ref main");
  const key = (t) => t.slice(1).split(".").map(Number);
  tags.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return tags.at(-1);
}

const ref = opt("--ref") || latestTag();
console.log(`upstream ${UPSTREAM} @ ${ref}`);

// Shallow fetch of exactly one ref; works for tags, branches and commit SHAs.
if (!existsSync(join(upstreamDir, ".git"))) {
  mkdirSync(upstreamDir, { recursive: true });
  git("init", "-q");
  git("remote", "add", "origin", UPSTREAM);
}
git("remote", "set-url", "origin", UPSTREAM);
git("fetch", "-q", "--depth", "1", "--force", "origin", ref);
git("checkout", "-q", "--force", "FETCH_HEAD");
git("clean", "-q", "-fdx");

const commit = git("rev-parse", "HEAD");
const commitDate = git("log", "-1", "--format=%cI");
const version = readFileSync(join(upstreamDir, "VERSION"), "utf8").trim();
const upstreamPkg = JSON.parse(readFileSync(join(upstreamDir, "package.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(join(upstreamDir, ".claude-plugin/marketplace.json"), "utf8"));
console.log(`version ${version}, commit ${commit.slice(0, 12)} (${commitDate})`);

// License gate. Every component of upstream is MIT today (LICENSE, LICENSE-cursor-team-kit,
// LICENSE-thermos, NOTICE.md). MIT lets us redistribute as long as the copyright and permission
// notices travel with the copy. If upstream ever adds a component under another license, stop
// here so a human reviews it instead of CI republishing it automatically.
function licenseGate() {
  const problems = [];
  if (upstreamPkg.license !== "MIT") problems.push(`package.json license is "${upstreamPkg.license}", expected "MIT"`);
  const walk = (dir, rel = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".git" || e.name === "node_modules") return [];
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(join(dir, e.name), r) : [r];
  });
  const files = walk(upstreamDir);
  const licenseFiles = files.filter((f) => /^(LICEN[CS]E|COPYING|UNLICENSE)/i.test(f.split("/").pop()));
  for (const f of licenseFiles) {
    const text = readFileSync(join(upstreamDir, f), "utf8");
    if (!/^MIT License/m.test(text) || !text.includes("Permission is hereby granted, free of charge")) problems.push(`${f} is not the MIT license text`);
  }
  for (const f of ["LICENSE", "NOTICE.md"]) if (!files.includes(f)) problems.push(`${f} is missing`);
  const notice = readFileSync(join(upstreamDir, "NOTICE.md"), "utf8");
  for (const row of notice.split("\n").filter((l) => /^\|\s*`/.test(l))) {
    const license = row.split("|")[4]?.trim();
    if (license !== "MIT") problems.push(`NOTICE.md lists a component under "${license}": ${row.slice(0, 120)}`);
  }
  for (const f of files.filter((f) => f.endsWith("SKILL.md"))) {
    const m = readFileSync(join(upstreamDir, f), "utf8").match(/^---[\s\S]*?^license:\s*(.+)$[\s\S]*?^---/m);
    if (m && !/^["']?MIT["']?$/.test(m[1].trim())) problems.push(`${f} declares license: ${m[1].trim()}`);
  }
  if (problems.length) {
    console.error(`license gate failed for ${ref} (${commit.slice(0, 12)}); review before mirroring:\n- ${problems.join("\n- ")}`);
    process.exit(2);
  }
  console.log(`license gate ok: ${licenseFiles.length} MIT license files, NOTICE.md components all MIT`);
}
licenseGate();

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
}
output("version", version);
output("commit", commit);

if (checkRegistry) {
  let published = false;
  try {
    published = execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === version;
  } catch {}
  output("skip", String(published));
  if (published) {
    console.log(`${name}@${version} is already published; nothing to do`);
    process.exit(0);
  }
}

// Build dist/: the marketplace root (what `plugin marketplace add <dir>` reads) plus the installer.
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const skip = (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) && !src.endsWith(".DS_Store");
cpSync(join(upstreamDir, ".claude-plugin"), join(dist, ".claude-plugin"), { recursive: true, filter: skip });
cpSync(join(upstreamDir, "plugins/pstack"), join(dist, "plugins/pstack"), { recursive: true, filter: skip });
for (const f of readdirSync(upstreamDir)) {
  if (/^(LICENSE|NOTICE)/.test(f) || f === "CHANGES.md") cpSync(join(upstreamDir, f), join(dist, f));
}
// Provenance files NOTICE.md links to (substitution rules, forks, upstream pins, runtime reference).
for (const f of ["docs/reference.md", "tools/substitutions.json", "tools/forks.json", "tools/upstream.json"]) {
  if (existsSync(join(upstreamDir, f))) cpSync(join(upstreamDir, f), join(dist, f));
}
cpSync(join(upstreamDir, "README.md"), join(dist, "UPSTREAM-README.md"));
cpSync(join(template, "LICENSE-mirror"), join(dist, "LICENSE-mirror"));
cpSync(join(template, "bin"), join(dist, "bin"), { recursive: true });
chmodSync(join(dist, "bin/pstack-claude.mjs"), 0o755);

const fill = (s) => s
  .replaceAll("{{NAME}}", name)
  .replaceAll("{{BIN}}", name.split("/").pop())
  .replaceAll("{{VERSION}}", version)
  .replaceAll("{{COMMIT}}", commit)
  .replaceAll("{{DATE}}", commitDate)
  .replaceAll("{{REF}}", ref)
  .replaceAll("{{MARKETPLACE}}", marketplace.name)
  .replaceAll("{{PLUGIN}}", marketplace.plugins[0].name);
writeFileSync(join(dist, "README.md"), fill(readFileSync(join(template, "README.md"), "utf8")));

const pkg = {
  name,
  version,
  description: `[Unofficial GitHub mirror] Unmodified copy of ${upstreamPkg.homepage} @ ${ref} (pstack skills/plugin for OMP, Claude Code, Pi), republished on npm for networks without GitHub access. Not published by or affiliated with the upstream author; report issues upstream.`,
  license: upstreamPkg.license,
  homepage: upstreamPkg.homepage,
  // The mirror repo that builds and publishes this package. npm provenance requires it to match
  // the GitHub repository running the publish workflow. Upstream stays in homepage and pstackMirror.
  repository: { type: "git", url: `git+https://github.com/${process.env.MIRROR_REPOSITORY || process.env.GITHUB_REPOSITORY || "ZedRover/pstack-claude-mirror"}.git` },
  keywords: [...new Set([...(upstreamPkg.keywords || []), "omp", "oh-my-pi", "claude-code-plugin", "mirror", "github-mirror", "unofficial"])],
  bin: { [name.split("/").pop()]: "bin/pstack-claude.mjs" },
  engines: { node: ">=18" },
  files: [".claude-plugin/", "plugins/", "bin/", "LICENSE*", "NOTICE*", "CHANGES.md", "UPSTREAM-README.md", "docs/reference.md", "tools/*.json"],
  // Kept from upstream so `pi install npm:<name>` and OpenCode's ./server export keep working.
  pi: upstreamPkg.pi,
  exports: { ...upstreamPkg.exports, "./package.json": "./package.json" },
  peerDependencies: upstreamPkg.peerDependencies,
  peerDependenciesMeta: Object.fromEntries(Object.keys(upstreamPkg.peerDependencies || {}).map((k) => [k, { optional: true }])),
  pstackMirror: { notice: "Unofficial mirror. Content is copied unchanged from the upstream GitHub repository; only bin/, README.md, LICENSE-mirror and package.json are added by the mirror (MIT, see LICENSE-mirror). Upstream copyright and license notices are preserved unchanged.", upstream: UPSTREAM, upstreamAuthor: upstreamPkg.author, ref, commit, commitDate, marketplace: marketplace.name, plugin: marketplace.plugins[0].name },
};
writeFileSync(join(dist, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`built ${dist} as ${name}@${version}`);
