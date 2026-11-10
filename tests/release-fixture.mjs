import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spawn = process.platform === "win32" ? createRequire(import.meta.url)("cross-spawn").sync : spawnSync;
export const version = "1.2.3";
export const tableHeader = "| Component | Upstream | Copyright | License | License file |\n| --- | --- | --- | --- | --- |\n";
export const componentRow = "| Plain component | example | Fixture Author | MIT | [LICENSE](LICENSE) |\n";

export function releaseFixture(t, { files = {}, tag = `v${version}` } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pstack-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  const upstream = join(directory, "upstream");
  const bin = join(directory, "bin");
  const home = join(directory, "home");
  for (const path of [project, upstream, bin, home]) mkdirSync(path);
  cpSync(join(root, "scripts"), join(project, "scripts"), { recursive: true });
  cpSync(join(root, "template"), join(project, "template"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "release-fixture", private: true, type: "module" }));
  writeFileSync(join(project, ".npmrc"), "registry=https://project-registry.invalid/\n");
  const license = readFileSync(join(root, "template/LICENSE-mirror"), "utf8").replace(/\r?\n/g, "\r\n");
  const upstreamFiles = {
    ".gitattributes": "* -text\n",
    VERSION: `${version}\n`,
    "package.json": JSON.stringify({ name: "upstream-fixture", version, license: "MIT", homepage: "https://example.invalid/upstream", author: { name: "Fixture Author" } }),
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "fixture-marketplace", plugins: [{ name: "pstack", source: "./plugins/pstack", version }] }),
    "plugins/pstack/.claude-plugin/plugin.json": JSON.stringify({ name: "pstack", version, author: { name: "Fixture Author" } }),
    "plugins/pstack/skills/example/SKILL.md": "---\nname: example\nlicense: MIT\n---\nFixture skill.\n",
    "NOTICE.md": `# NOTICE\n\n${tableHeader}${componentRow}| Another plain component | example | Another Author | MIT | [Terms](legal/component.txt) |\n`,
    "NOTICE-skills.md": "# Skills notice\n\n| Included work | Upstream | Copyright | License |\n| --- | --- | --- | --- |\n| Plain skill | example | Fixture Author | [MIT](LICENSE) |\n",
    "LICENSE": license,
    "legal/component.txt": license + "\r\nCopyright preserved verbatim, including café.\r\n",
    "README.md": "# Upstream fixture\n\nCopyright Fixture Author.\n",
    ...files,
  };
  for (const [path, content] of Object.entries(upstreamFiles)) {
    if (content === null) continue;
    mkdirSync(dirname(join(upstream, path)), { recursive: true });
    writeFileSync(join(upstream, path), content);
  }
  const callsPath = join(directory, "npm-calls.jsonl");
  const publicationPath = join(directory, "publication.json");
  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    NODE_PATH: join(root, "node_modules"),
    PSTACK_UPSTREAM: upstream,
    PKG_NAME: "fixture-mirror",
    MIRROR_REPOSITORY: "fixture-owner/mirror",
    npm_config_cache: join(directory, "npm-cache"),
    npm_config_userconfig: join(home, "user.npmrc"),
    npm_config_globalconfig: join(home, "global.npmrc"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    RELEASE_CALLS: callsPath,
    RELEASE_PUBLICATION: publicationPath,
    RELEASE_VIEW: "absent",
  };
  for (const args of [["init", "-q", "-b", "main"], ["config", "core.autocrlf", "false"], ["add", "."], ["-c", "user.name=Release tests", "-c", "user.email=tests@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], ["tag", tag]]) {
    execFileSync("git", args, { cwd: upstream, env, stdio: "pipe" });
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, env, encoding: "utf8" }).trim();
  const fakeNpm = join(bin, "npm");
  writeFileSync(join(bin, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(fakeNpm, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const config = existsSync(".npmrc") ? readFileSync(".npmrc", "utf8") : null;
appendFileSync(process.env.RELEASE_CALLS, JSON.stringify({ args, cwd: process.cwd(), config, registry: process.env.npm_config_registry }) + "\\n");
if (args[0] === "view") {
  const mode = process.env.RELEASE_VIEW;
  if (mode === "present") console.log(JSON.stringify(process.env.RELEASE_VIEW_VERSION || ${JSON.stringify(version)}));
  else if (mode === "malformed") console.log("not JSON");
  else if (mode === "wrong-version") console.log(JSON.stringify("9.9.9"));
  else if (mode === "empty") process.stdout.write("");
  else if (mode === "wrong-shape") console.log(JSON.stringify([${JSON.stringify(version)}]));
  else if (mode === "malformed-error") { console.log("E404: not JSON"); process.exitCode = 1; }
  else if (mode === "e404-success") console.log(JSON.stringify({ error: { code: "E404" } }));
  else if (mode === "absent-stderr") { console.error(JSON.stringify({ error: { code: "E404" } })); process.exitCode = 1; }
  else {
    const code = { absent: "E404", auth: "E401", forbidden: "E403", network: "ECONNRESET" }[mode];
    console.log(JSON.stringify({ error: { code } }));
    process.exitCode = 1;
  }
} else if (args[0] === "publish") {
  const target = args[1] && !args[1].startsWith("-") ? args[1] : process.cwd();
  const files = {};
  const collect = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) collect(join(directory, entry.name), relative + "/");
      else files[relative] = readFileSync(join(directory, entry.name)).toString("base64");
    }
  };
  collect(target);
  writeFileSync(process.env.RELEASE_PUBLICATION, JSON.stringify({ target, args, files, package: JSON.parse(readFileSync(join(target, "package.json"), "utf8")) }));
  process.exitCode = Number(process.env.RELEASE_PUBLISH_STATUS || 0);
} else {
  process.exitCode = 99;
}
`);
  chmodSync(fakeNpm, 0o755);
  if (process.platform === "win32") writeFileSync(`${fakeNpm}.cmd`, `@echo off\r\n"${process.execPath}" "${fakeNpm}" %*\r\n`);
  return {
    directory, project, upstream, env, commit, upstreamFiles,
    run(script, args = [], overrides = {}) {
      return spawnSync(process.execPath, [join(project, "scripts", script), ...args], { cwd: project, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000 });
    },
    runModule(source, overrides = {}) {
      return spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: project, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000 });
    },
    pack() {
      const args = ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"];
      const command = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath, ...args]] : ["npm", args];
      return spawn(command[0], command[1], { cwd: join(project, "dist"), env: { ...env, PATH: process.env.PATH }, encoding: "utf8", timeout: 30000 });
    },
    calls() { return existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []; },
    publication() { return existsSync(publicationPath) ? JSON.parse(readFileSync(publicationPath, "utf8")) : undefined; },
  };
}
