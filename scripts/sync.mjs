#!/usr/bin/env node
// node scripts/sync.mjs [--ref <tag|branch|sha>] [--name <npm name>] [--check-registry]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, chmodSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseArgs, spawnCommand } from "./release-options.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const template = join(here, "template");

function latestTag(upstream) {
  const out = execFileSync("git", ["ls-remote", "--tags", "--refs", upstream], { encoding: "utf8" });
  const tags = out.split(/\r?\n/).map((line) => line.split("refs/tags/")[1]).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag || ""));
  if (!tags.length) throw new Error("no vX.Y.Z tags upstream; pass --ref main");
  const key = (tag) => tag.slice(1).split(".").map(Number);
  tags.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return tags.at(-1);
}

function upstreamFiles(directory, relative = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") return [];
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? upstreamFiles(join(directory, entry.name), path) : [path];
  });
}

function licenseGate(upstreamDir, upstreamPkg, files) {
  const fail = (message) => { throw Object.assign(new Error(`license gate failed: ${message}; review before mirroring`), { exitCode: 2 }); };
  if (upstreamPkg.license !== "MIT") fail("package.json license must be MIT");
  for (const path of ["LICENSE", "NOTICE.md"]) if (!files.includes(path)) fail(`${path} is missing`);
  const licenses = new Set(files.filter((path) => /^(LICEN[CS]E|COPYING|UNLICENSE)/i.test(posix.basename(path))));
  const notices = files.filter((path) => /^NOTICE/i.test(posix.basename(path)));
  const regularLegalFile = (path) => {
    const parts = path.split("/");
    if (parts.some((part) => !/^[\w.-]+$/.test(part) || [".", "..", ".git", "node_modules", ".npmrc", ".npmignore", ".gitignore", ".DS_Store"].includes(part))) fail(`unsupported legal file path ${path}`);
    if (["package.json", "README.md", "UPSTREAM-README.md", "LICENSE-mirror"].includes(path) || parts[0] === "bin") fail(`legal file ${path} conflicts with mirror-owned files`);
    if (["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", ".npm-extension.mjs", ".npm-extension.cjs"].includes(path)) fail(`npm excludes legal file ${path}`);
    let current = upstreamDir;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let stat;
      try { stat = lstatSync(current); } catch { fail(`legal file ${path} is missing`); }
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail(`legal file ${path} must be a contained regular file`);
      const copiedDirectory = parts[0] === "plugins" || parts[0] === ".claude-plugin";
      if (copiedDirectory && stat.isDirectory() && [".npmignore", ".gitignore"].some((file) => existsSync(join(current, file)))) fail(`npm ignore rules may exclude legal file ${path}`);
    }
  };
  for (const noticePath of notices) {
    regularLegalFile(noticePath);
    const lines = readFileSync(join(upstreamDir, noticePath), "utf8").split(/\r?\n/).map((line) => line.trim());
    const header = lines.findIndex((line) => line.includes("|"));
    const cells = (line) => {
      if (!line?.startsWith("|") || !line.endsWith("|")) fail(`${noticePath} has an unsupported component table`);
      return line.slice(1, -1).split("|").map((cell) => cell.trim());
    };
    if (header < 0) fail(`${noticePath} is missing its component table`);
    const columns = cells(lines[header]);
    const componentTable = columns.join("|") === "Component|Upstream|Copyright|License|License file";
    const skillsTable = columns.join("|") === "Included work|Upstream|Copyright|License";
    if ((!componentTable && !skillsTable) || (noticePath === "NOTICE.md" && !componentTable)) fail(`${noticePath} has unknown component table columns`);
    const separator = cells(lines[header + 1]);
    if (separator.length !== columns.length || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) fail(`${noticePath} has an invalid component table separator`);
    let rowIndex = header + 2;
    for (; rowIndex < lines.length && lines[rowIndex]; rowIndex++) {
      const row = cells(lines[rowIndex]);
      if (row.length !== columns.length || row.some((cell) => !cell)) fail(`${noticePath} has an invalid component row`);
      const reference = (componentTable ? row[4] : row[3]).match(/^\[([^\]]+)\]\(([^\s()]+)\)$/);
      if (!reference) fail(`${noticePath} must link each component's license file`);
      if ((componentTable ? row[3] : reference[1]) !== "MIT") fail(`${noticePath} lists a non-MIT component`);
      if (reference[2].split("/").some((part) => part === "..") || reference[2].startsWith("/")) fail(`${noticePath} has an escaping license reference`);
      const path = posix.join(posix.dirname(noticePath), reference[2]);
      regularLegalFile(path);
      licenses.add(path);
    }
    if (rowIndex === header + 2) fail(`${noticePath} has an empty component table`);
    if (lines.slice(rowIndex).some((line) => line.includes("|"))) fail(`${noticePath} has an unsupported additional component table`);
  }
  for (const path of licenses) {
    regularLegalFile(path);
    const text = readFileSync(join(upstreamDir, path), "utf8");
    if (!/^MIT License\r?$/m.test(text) || !text.includes("Permission is hereby granted, free of charge")) fail(`${path} is not the MIT license text`);
  }
  for (const path of files.filter((path) => path.endsWith("SKILL.md"))) {
    const declaration = readFileSync(join(upstreamDir, path), "utf8").match(/^---[\s\S]*?^license:\s*(.+)$[\s\S]*?^---/m);
    if (declaration && !/^["']?MIT["']?$/.test(declaration[1].trim())) fail(`${path} declares a non-MIT license`);
  }
  console.log(`license gate ok: ${licenses.size} MIT license files, NOTICE components all MIT`);
  return [...new Set([...licenses, ...notices])];
}

function validateVersions(upstreamDir, version, ref, upstreamPkg, marketplace, files) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) throw new Error("VERSION must contain a package version");
  const check = (metadata, label) => {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(`${label} must be an object`);
    if (Object.hasOwn(metadata, "version") && metadata.version !== version) throw new Error(`${label} version does not match VERSION ${version}`);
  };
  const tag = ref.replace(/^refs\/tags\//, "");
  if (/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag) && tag.replace(/^v/, "") !== version) throw new Error(`tag ${tag} does not match VERSION ${version}`);
  check(upstreamPkg, "package.json");
  const checkMarketplace = (metadata, path) => {
    check(metadata, path);
    if (Object.hasOwn(metadata, "metadata")) check(metadata.metadata, `${path} metadata`);
    if (!Array.isArray(metadata.plugins) || !metadata.plugins.length) throw new Error(`${path} must list its plugins`);
    for (const plugin of metadata.plugins) check(plugin, `${path} plugin`);
  };
  checkMarketplace(marketplace, ".claude-plugin/marketplace.json");
  if (typeof marketplace.name !== "string" || !marketplace.name || typeof marketplace.plugins[0].name !== "string" || !marketplace.plugins[0].name) throw new Error("marketplace and plugin names are required");
  for (const path of files.filter((path) => /^plugins\/pstack\/\.[^/]+\/(?:plugin\/)?plugin\.json$/.test(path) || ["plugins/pstack/package.json", "kimi.plugin.json", ".agents/plugins/marketplace.json"].includes(path))) {
    const metadata = JSON.parse(readFileSync(join(upstreamDir, path), "utf8"));
    if (path.endsWith("marketplace.json")) checkMarketplace(metadata, path);
    else check(metadata, path);
  }
}

function isPublished(name, version, registryArgs, npmCwd) {
  const result = spawnCommand("npm", ["view", `${name}@${version}`, "version", ...registryArgs, "--json", "--workspaces=false"], { cwd: npmCwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal) throw new Error("npm registry query could not complete");
  let data;
  try { data = JSON.parse(result.stdout || result.stderr); } catch { throw new Error("npm registry query returned malformed JSON"); }
  if (result.status !== 0) {
    if (data?.error?.code === "E404") return false;
    const code = data?.error?.code;
    throw new Error(`npm registry query failed${typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? ` (${code})` : ""}`);
  }
  if (data !== version) throw new Error("npm registry query returned an unexpected version");
  return true;
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
}

export function sync({ ref, name = process.env.PKG_NAME || "pstack-claude-mirror", checkRegistry = false, destination = join(here, "dist"), upstream = process.env.PSTACK_UPSTREAM || "https://github.com/michael-denyer/pstack-claude.git", registryArgs = [], npmCwd = here } = {}) {
  if (typeof name !== "string" || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error("--name must be an npm package name");
  if (ref !== undefined && (typeof ref !== "string" || !ref || ref.startsWith("-") || /[\0\r\n]/.test(ref))) throw new Error("--ref requires a nonempty ref that does not begin with '-'");
  ref ??= latestTag(upstream);
  const workspace = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  const upstreamDir = join(workspace, "upstream");
  const dist = resolve(destination);
  try {
    mkdirSync(upstreamDir);
    const git = (...args) => execFileSync("git", args, { cwd: upstreamDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
    console.log(`upstream ${upstream} @ ${ref}`);
    git("init", "-q");
    git("remote", "add", "origin", upstream);
    git("fetch", "-q", "--depth", "1", "origin", ref);
    git("-c", "core.autocrlf=false", "checkout", "-q", "--detach", "FETCH_HEAD");
    const commit = git("rev-parse", "HEAD");
    const commitDate = git("log", "-1", "--format=%cI");
    const upstreamVersion = readFileSync(join(upstreamDir, "VERSION"), "utf8").trim();
    const upstreamPkg = JSON.parse(readFileSync(join(upstreamDir, "package.json"), "utf8"));
    const marketplace = JSON.parse(readFileSync(join(upstreamDir, ".claude-plugin/marketplace.json"), "utf8"));
    const files = upstreamFiles(upstreamDir);
    validateVersions(upstreamDir, upstreamVersion, ref, upstreamPkg, marketplace, files);
    const legalFiles = licenseGate(upstreamDir, upstreamPkg, files);
    const revision = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).mirrorRevisions?.[upstreamVersion];
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1 || !/^\d+\.\d+\.\d+$/.test(upstreamVersion))) throw new Error("mirror revisions require a positive integer and a stable upstream version");
    const version = revision === undefined ? upstreamVersion : `${upstreamVersion}-mirror.${revision}`;
    console.log(`version ${version}, commit ${commit.slice(0, 12)} (${commitDate})`);
    output("version", version);
    output("commit", commit);
    if (checkRegistry) {
      const published = isPublished(name, version, registryArgs, npmCwd);
      output("skip", String(published));
      if (published) {
        console.log(`${name}@${version} is already published; nothing to do`);
        return { kind: "skipped", name, version, ref, commit };
      }
    }
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    const skip = (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) && !src.endsWith(".DS_Store");
    cpSync(join(upstreamDir, ".claude-plugin"), join(dist, ".claude-plugin"), { recursive: true, filter: skip });
    cpSync(join(upstreamDir, "plugins/pstack"), join(dist, "plugins/pstack"), { recursive: true, filter: skip });
    const provenanceFiles = ["CHANGES.md", "docs/reference.md", "tools/substitutions.json", "tools/forks.json", "tools/upstream.json"].filter((path) => existsSync(join(upstreamDir, path)));
    for (const path of [...legalFiles, ...provenanceFiles]) {
      mkdirSync(dirname(join(dist, path)), { recursive: true });
      cpSync(join(upstreamDir, path), join(dist, path));
    }
    cpSync(join(upstreamDir, "README.md"), join(dist, "UPSTREAM-README.md"));
    cpSync(join(template, "LICENSE-mirror"), join(dist, "LICENSE-mirror"));
    cpSync(join(template, "bin"), join(dist, "bin"), { recursive: true });
    chmodSync(join(dist, "bin/pstack-claude.mjs"), 0o755);
    const fill = (text) => text
      .replaceAll("{{NAME}}", name)
      .replaceAll("{{BIN}}", name.split("/").pop())
      .replaceAll("{{VERSION}}", version)
      .replaceAll("{{UPSTREAM_VERSION}}", upstreamVersion)
      .replaceAll("{{COMMIT}}", commit)
      .replaceAll("{{DATE}}", commitDate)
      .replaceAll("{{REF}}", ref)
      .replaceAll("{{MARKETPLACE}}", marketplace.name)
      .replaceAll("{{PLUGIN}}", marketplace.plugins[0].name);
    writeFileSync(join(dist, "README.md"), fill(readFileSync(join(template, "README.md"), "utf8")));
    const repository = process.env.MIRROR_REPOSITORY || process.env.GITHUB_REPOSITORY || "ZedRover/pstack-claude-mirror";
    const pkg = {
      name,
      version,
      description: `[Unofficial GitHub mirror] Unmodified copy of ${upstreamPkg.homepage || upstream} @ ${ref} (pstack skills/plugin for OMP, Claude Code, Pi), republished on npm for networks without GitHub access. Not published by or affiliated with the upstream author. Report mirror packaging and installer bugs to the mirror repository; report plugin-content bugs upstream.`,
      license: upstreamPkg.license,
      homepage: upstreamPkg.homepage,
      repository: { type: "git", url: `git+https://github.com/${repository}.git` },
      bugs: { url: `https://github.com/${repository}/issues` },
      keywords: [...new Set([...(upstreamPkg.keywords || []), "omp", "oh-my-pi", "claude-code-plugin", "mirror", "github-mirror", "unofficial"])],
      bin: { [name.split("/").pop()]: "bin/pstack-claude.mjs" },
      engines: { node: ">=18" },
      files: [".claude-plugin/", "plugins/", "bin/", "LICENSE-mirror", "UPSTREAM-README.md", ...legalFiles, ...provenanceFiles],
      dependencies: { "cross-spawn": "7.0.6" },
      pi: upstreamPkg.pi,
      exports: { ...upstreamPkg.exports, "./package.json": "./package.json" },
      peerDependencies: upstreamPkg.peerDependencies,
      peerDependenciesMeta: Object.fromEntries(Object.keys(upstreamPkg.peerDependencies || {}).map((key) => [key, { optional: true }])),
      pstackMirror: { notice: "Unofficial mirror. Content is copied unchanged from the upstream GitHub repository; only bin/, README.md, LICENSE-mirror and package.json are added by the mirror (MIT, see LICENSE-mirror). Upstream copyright and license notices are preserved unchanged.", upstream, upstreamVersion, upstreamAuthor: upstreamPkg.author, ref, commit, commitDate, marketplace: marketplace.name, plugin: marketplace.plugins[0].name },
    };
    writeFileSync(join(dist, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    console.log(`built ${dist} as ${name}@${version}`);
    return { kind: "built", artifact: { directory: dist, name, version, ref, commit } };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { sync(parseReleaseArgs(process.argv.slice(2))); }
  catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
