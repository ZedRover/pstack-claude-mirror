import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { componentRow, releaseFixture, tableHeader, version } from "./release-fixture.mjs";

function succeeds(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function refusesPublication(fixture, result) {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fixture.publication(), undefined);
  assert.equal(fixture.calls().some(({ args }) => args[0] === "publish"), false);
}

test("sync can be imported without fetching, building, or querying npm", (t) => {
  const fixture = releaseFixture(t);
  const before = readdirSync(fixture.project).sort();
  succeeds(fixture.runModule("await import('./scripts/sync.mjs');", { PSTACK_UPSTREAM: join(fixture.directory, "missing") }));
  assert.deepEqual(readdirSync(fixture.project).sort(), before);
  assert.deepEqual(fixture.calls(), []);
});

test("sync returns built identity and a skipped result without an artifact", (t) => {
  const fixture = releaseFixture(t);
  const builtPath = join(fixture.project, "built-result.json");
  succeeds(fixture.runModule(`import { sync } from './scripts/sync.mjs'; import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(builtPath)}, JSON.stringify(await sync({ ref: 'v${version}', name: 'api-mirror', destination: 'api-dist' })));`));
  const built = JSON.parse(readFileSync(builtPath, "utf8"));
  assert.deepEqual(built, { kind: "built", artifact: { directory: join(fixture.project, "api-dist"), name: "api-mirror", version, ref: `v${version}`, commit: fixture.commit } });
  assert.equal(JSON.parse(readFileSync(join(built.artifact.directory, "package.json"), "utf8")).name, "api-mirror");
  const skippedPath = join(fixture.project, "skipped-result.json");
  succeeds(fixture.runModule(`import { sync } from './scripts/sync.mjs'; import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(skippedPath)}, JSON.stringify(await sync({ ref: 'v${version}', checkRegistry: true, destination: 'must-not-build' })));`, { RELEASE_VIEW: "present" }));
  assert.deepEqual(JSON.parse(readFileSync(skippedPath, "utf8")), { kind: "skipped", name: "fixture-mirror", version, ref: `v${version}`, commit: fixture.commit });
  assert.equal(existsSync(join(fixture.project, "must-not-build")), false);
});

for (const equals of [false, true]) {
  test(`release publishes only its current artifact with ${equals ? "equals" : "split"} options`, (t) => {
    const fixture = releaseFixture(t);
    const stale = join(fixture.project, "dist");
    mkdirSync(stale);
    const stalePackage = JSON.stringify({ name: "residual-package", version: "0.0.1" });
    writeFileSync(join(stale, "package.json"), stalePackage);
    const customConfig = join(fixture.directory, "custom.npmrc");
    writeFileSync(customConfig, "registry=https://user-registry.invalid/\n");
    const args = equals
      ? [`--ref=v${version}`, "--name=@fixture/current", "--otp=123456", "--registry=https://cli-registry.invalid/", `--userconfig=${customConfig}`]
      : ["--ref", `v${version}`, "--name", "@fixture/current", "--otp", "123456", "--registry", "https://cli-registry.invalid/", "--userconfig", customConfig];
    const result = fixture.run("publish.mjs", [...args, "--dry-run", "--provenance", "--tag", "next"]);
    succeeds(result);
    assert.equal((result.stdout + result.stderr).includes("123456"), false);
    const publication = fixture.publication();
    assert.equal(publication.package.name, "@fixture/current");
    assert.equal(publication.package.version, version);
    assert.equal(publication.package.pstackMirror.ref, `v${version}`);
    assert.equal(publication.package.pstackMirror.commit, fixture.commit);
    for (const path of ["LICENSE", "NOTICE.md", "NOTICE-skills.md", "legal/component.txt"]) {
      assert.deepEqual(Buffer.from(publication.files[path], "base64"), readFileSync(join(fixture.upstream, path)), path);
    }
    assert.notEqual(publication.target, stale);
    assert.equal(existsSync(publication.target), false, "the invocation's private artifact is removed after npm finishes");
    assert.equal(readFileSync(join(stale, "package.json"), "utf8"), stalePackage);
    assert.equal(publication.args.includes("--dry-run"), true);
    assert.equal(publication.args.includes("--provenance"), true);
    assert.equal(publication.args.includes("--otp=123456"), true);
    assert.equal(publication.args.includes("--tag=next"), true);
    assert.equal(publication.args.some((arg) => arg === "--name" || arg.startsWith("--name=") || arg === "--ref" || arg.startsWith("--ref=")), false);
    const calls = fixture.calls();
    assert.equal(calls.length, 2);
    const [view, publish] = calls;
    assert.equal(view.args[0], "view");
    assert.equal(view.args.includes(`@fixture/current@${version}`), true);
    assert.equal(view.args.includes("--json"), true);
    assert.equal(view.args.some((arg) => arg.includes("123456")), false);
    for (const call of [view, publish]) {
      assert.equal(call.cwd, fixture.project);
      assert.equal(call.config, "registry=https://project-registry.invalid/\n");
      assert.equal(call.args.includes("--registry=https://cli-registry.invalid/"), true);
      assert.equal(call.args.includes(`--userconfig=${customConfig}`), true);
    }
  });
}

test("release inherits the same registry environment for query and publish", (t) => {
  const fixture = releaseFixture(t);
  succeeds(fixture.run("publish.mjs", ["--dry-run"], { npm_config_registry: "https://env-registry.invalid/" }));
  assert.deepEqual(fixture.calls().map(({ registry }) => registry), ["https://env-registry.invalid/", "https://env-registry.invalid/"]);
});

test("an E404 JSON error on stderr permits the current release", (t) => {
  const fixture = releaseFixture(t);
  succeeds(fixture.run("publish.mjs", ["--dry-run"], { RELEASE_VIEW: "absent-stderr" }));
  assert.equal(fixture.publication().package.version, version);
});

test("additional npm equals options stay options and are forwarded to both calls", (t) => {
  const fixture = releaseFixture(t);
  succeeds(fixture.run("publish.mjs", ["--dry-run", "--fetch-timeout=15000", "--heading=release-check"]));
  for (const call of fixture.calls()) {
    assert.equal(call.args.includes("--fetch-timeout=15000"), true);
    assert.equal(call.args.includes("--heading=release-check"), true);
  }
});

for (const mode of ["auth", "forbidden", "network", "malformed", "empty", "wrong-version", "wrong-shape", "malformed-error", "e404-success"]) {
  test(`release fails closed on registry ${mode}`, (t) => {
    const fixture = releaseFixture(t);
    refusesPublication(fixture, fixture.run("publish.mjs", ["--dry-run"], { RELEASE_VIEW: mode }));
    assert.equal(fixture.calls().length, 1);
    assert.equal(existsSync(join(fixture.project, "dist")), false);
  });
}

test("npm publish failure is propagated without exposing the OTP", (t) => {
  const fixture = releaseFixture(t);
  const result = fixture.run("publish.mjs", ["--otp", "987654", "--dry-run"], { RELEASE_PUBLISH_STATUS: "17" });
  assert.equal(result.status, 17, result.stdout + result.stderr);
  assert.equal((result.stdout + result.stderr).includes("987654"), false);
  assert.equal(existsSync(fixture.publication().target), false);
});

for (const args of [["other-package.tgz"], ["--", "../other"], ["--dry-run", "../other"], ["--provenance", "../other"], ["--otp", "123456", "../other"], ["--workspace", "../other"], ["--workspaces"], ["--ws"], ["--prefix=../other"], ["--heading", "../other"], ["--ref"], ["--ref="], ["--ref", "--upload-pack=bad"], ["--name="], ["--name", "--registry=bad"]]) {
  test(`release rejects unsafe or incomplete arguments ${JSON.stringify(args)}`, (t) => {
    const fixture = releaseFixture(t);
    refusesPublication(fixture, fixture.run("publish.mjs", args));
    assert.deepEqual(fixture.calls(), []);
  });
}

const invalidNotices = [
  ["missing notice", { "NOTICE.md": null }],
  ["missing root license", { "LICENSE": null }],
  ["non-MIT package declaration", { "package.json": JSON.stringify({ version, license: "Apache-2.0" }) }],
  ["missing component table", { "NOTICE.md": "# NOTICE\n\nNo table.\n" }],
  ["unknown underscore notice", { "NOTICE_third_party.md": "# Extra notice\n\nUnsupported new license format.\n" }],
  ["empty component table", { "NOTICE.md": `# NOTICE\n\n${tableHeader}` }],
  ["unknown columns", { "NOTICE.md": tableHeader.replace("License file", "Terms") + componentRow }],
  ["invalid separator", { "NOTICE.md": tableHeader.replace("| --- |", "| bad |") + componentRow }],
  ["truncated plain row", { "NOTICE.md": tableHeader + "| Plain component | MIT |\n" }],
  ["non-MIT plain row", { "NOTICE.md": tableHeader + componentRow + "| Plain GPL component | example | Author | GPL-3.0 | [LICENSE](LICENSE) |\n" }],
  ["missing linked license", { "legal/component.txt": null }],
  ["escaping linked license", { "NOTICE.md": tableHeader + componentRow.replace("](LICENSE)", "](../outside.txt)") }],
  ["remote linked license", { "NOTICE.md": tableHeader + componentRow.replace("](LICENSE)", "](https://example.invalid/LICENSE)") }],
  ["unlinked license file", { "NOTICE.md": tableHeader + componentRow.replace("[LICENSE](LICENSE)", "LICENSE") }],
  ["directory license reference", { "NOTICE.md": tableHeader + componentRow.replace("](LICENSE)", "](legal)") }],
  ["legal npm configuration reference", { "NOTICE.md": tableHeader + componentRow.replace("](LICENSE)", "](.npmrc)") }],
  ["npm-omitted legal lockfile reference", { "NOTICE.md": tableHeader + componentRow.replace("](LICENSE)", "](package-lock.json)") }],
  ["legal file behind npm ignore rules", { "NOTICE.md": tableHeader + componentRow.replace("](LICENSE)", "](plugins/pstack/terms.txt)"), "plugins/pstack/terms.txt": "MIT License\nPermission is hereby granted, free of charge\n", "plugins/pstack/.npmignore": "terms.txt\n" }],
  ["non-MIT linked text", { "legal/component.txt": "Apache License\nVersion 2.0\n" }],
  ["non-MIT skill", { "plugins/pstack/skills/example/SKILL.md": "---\nname: example\nlicense: GPL-3.0\n---\n" }],
  ["non-MIT skills notice plain row", { "NOTICE-skills.md": "| Included work | Upstream | Copyright | License |\n| --- | --- | --- | --- |\n| Plain skill | example | Author | [Apache-2.0](LICENSE) |\n" }],
];
for (const [label, files] of invalidNotices) {
  test(`release rejects ${label}`, (t) => {
    const fixture = releaseFixture(t, { files });
    const result = fixture.run("publish.mjs", ["--dry-run"]);
    refusesPublication(fixture, result);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(fixture.calls(), []);
  });
}

for (const [label, files, tag] of [
  ["package", { "package.json": JSON.stringify({ version: "9.9.9", license: "MIT" }) }],
  ["plugin", { "plugins/pstack/.claude-plugin/plugin.json": JSON.stringify({ name: "pstack", version: "9.9.9" }) }],
  ["codex plugin", { "plugins/pstack/.codex-plugin/plugin.json": JSON.stringify({ name: "pstack", version: "9.9.9" }) }],
  ["copilot plugin", { "plugins/pstack/.github/plugin/plugin.json": JSON.stringify({ name: "pstack", version: "9.9.9" }) }],
  ["kimi plugin", { "kimi.plugin.json": JSON.stringify({ name: "pstack", version: "9.9.9" }) }],
  ["codex marketplace", { ".agents/plugins/marketplace.json": JSON.stringify({ name: "fixture", plugins: [{ name: "pstack", version: "9.9.9" }] }) }],
  ["nested package", { "plugins/pstack/package.json": JSON.stringify({ name: "pstack", version: "9.9.9" }) }],
  ["marketplace entry", { ".claude-plugin/marketplace.json": JSON.stringify({ name: "fixture", plugins: [{ name: "pstack", version: "9.9.9" }] }) }],
  ["marketplace metadata", { ".claude-plugin/marketplace.json": JSON.stringify({ name: "fixture", metadata: { version: "9.9.9" }, plugins: [{ name: "pstack", version }] }) }],
  ["tag", {}, "v9.9.9"],
]) {
  test(`release rejects a ${label} version mismatch`, (t) => {
    const fixture = releaseFixture(t, { files, tag });
    refusesPublication(fixture, fixture.run("publish.mjs", ["--dry-run"]));
    assert.deepEqual(fixture.calls(), []);
  });
}

test("absent optional versions and plugin metadata do not prevent a build", (t) => {
  const fixture = releaseFixture(t, { files: {
    "package.json": JSON.stringify({ name: "upstream-fixture", license: "MIT" }),
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "fixture", plugins: [{ name: "pstack" }] }),
    "plugins/pstack/.claude-plugin/plugin.json": null,
  } });
  succeeds(fixture.run("sync.mjs", ["--ref", "main"]));
  assert.equal(JSON.parse(readFileSync(join(fixture.project, "dist/package.json"), "utf8")).version, version);
});

test("sync preserves legal and upstream author bytes and includes linked legal paths", (t) => {
  const fixture = releaseFixture(t);
  succeeds(fixture.run("sync.mjs", [`--ref=v${version}`, "--name=direct-mirror"]));
  const dist = join(fixture.project, "dist");
  const pkg = JSON.parse(readFileSync(join(dist, "package.json"), "utf8"));
  for (const path of ["NOTICE.md", "NOTICE-skills.md", "LICENSE", "legal/component.txt", "plugins/pstack/.claude-plugin/plugin.json", "plugins/pstack/skills/example/SKILL.md"]) {
    assert.deepEqual(readFileSync(join(dist, path)), readFileSync(join(fixture.upstream, path)), path);
  }
  for (const path of ["NOTICE.md", "NOTICE-skills.md", "LICENSE", "legal/component.txt"]) assert.equal(pkg.files.includes(path), true, path);
  assert.equal(pkg.name, "direct-mirror");
  assert.equal(pkg.bugs.url, "https://github.com/fixture-owner/mirror/issues");
  assert.equal(pkg.repository.url, "git+https://github.com/fixture-owner/mirror.git");
  assert.equal(pkg.homepage, "https://example.invalid/upstream");
  assert.deepEqual(pkg.pstackMirror.upstreamAuthor, { name: "Fixture Author" });
  assert.equal(pkg.author, undefined);
  assert.deepEqual(pkg.dependencies, { "cross-spawn": "7.0.6" });
  assert.deepEqual(fixture.calls(), []);
});

test("npm pack includes all validated notices and nonstandard linked license files", (t) => {
  const fixture = releaseFixture(t);
  succeeds(fixture.run("sync.mjs"));
  const result = fixture.pack();
  succeeds(result);
  const [packed] = JSON.parse(result.stdout);
  assert.equal(packed.name, "fixture-mirror");
  assert.equal(packed.version, version);
  const files = new Set(packed.files.map(({ path }) => path));
  for (const path of ["LICENSE", "NOTICE.md", "NOTICE-skills.md", "legal/component.txt", "LICENSE-mirror"]) assert.equal(files.has(path), true, path);
  assert.equal(files.has(".npmrc"), false);
});

test("valid underscore notices remain byte-identical in the packed files", (t) => {
  const notice = tableHeader + componentRow;
  const fixture = releaseFixture(t, { files: { "NOTICE_third_party.md": notice } });
  succeeds(fixture.run("sync.mjs"));
  assert.equal(readFileSync(join(fixture.project, "dist/NOTICE_third_party.md"), "utf8"), notice);
  const result = fixture.pack();
  succeeds(result);
  assert.ok(JSON.parse(result.stdout)[0].files.some(({ path }) => path === "NOTICE_third_party.md"));
});

function revisions(fixture, mapping) {
  const path = join(fixture.project, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...pkg, mirrorRevisions: mapping }));
}

test("mirror revision publishes a new package without changing upstream plugin bytes", (t) => {
  const fixture = releaseFixture(t);
  revisions(fixture, { [version]: 2 });
  succeeds(fixture.run("publish.mjs", ["--dry-run"]));
  const publication = fixture.publication();
  assert.equal(publication.package.version, `${version}-mirror.2`);
  assert.equal(publication.package.pstackMirror.upstreamVersion, version);
  assert.ok(fixture.calls()[0].args.includes(`fixture-mirror@${version}-mirror.2`));
  assert.ok(publication.args.includes("--tag=latest"));
  for (const path of [".claude-plugin/marketplace.json", "plugins/pstack/.claude-plugin/plugin.json"]) {
    assert.deepEqual(Buffer.from(publication.files[path], "base64"), readFileSync(join(fixture.upstream, path)));
  }
});

test("published mirror revision skips publication rather than querying the upstream version", (t) => {
  const fixture = releaseFixture(t);
  revisions(fixture, { [version]: 2 });
  succeeds(fixture.run("publish.mjs", [], { RELEASE_VIEW: "present", RELEASE_VIEW_VERSION: `${version}-mirror.2` }));
  assert.equal(fixture.publication(), undefined);
  assert.equal(fixture.calls().length, 1);
  assert.ok(fixture.calls()[0].args.includes(`fixture-mirror@${version}-mirror.2`));
});

test("a revision for another upstream version does not rename a new release", (t) => {
  const fixture = releaseFixture(t);
  revisions(fixture, { "0.9.133": 1 });
  succeeds(fixture.run("sync.mjs"));
  assert.equal(JSON.parse(readFileSync(join(fixture.project, "dist/package.json"), "utf8")).version, version);
});

for (const revision of [0, -1, 1.5, "1", null]) {
  test(`invalid mirror revision ${JSON.stringify(revision)} cannot publish`, (t) => {
    const fixture = releaseFixture(t);
    revisions(fixture, { [version]: revision });
    refusesPublication(fixture, fixture.run("publish.mjs", ["--dry-run"]));
    assert.deepEqual(fixture.calls(), []);
  });
}

test("sync invoked through a symlinked checkout still builds its package", (t) => {
  const fixture = releaseFixture(t);
  const alias = join(fixture.directory, "project-alias");
  symlinkSync(fixture.project, alias, process.platform === "win32" ? "junction" : "dir");
  const result = fixture.run("../../project-alias/scripts/sync.mjs");
  succeeds(result);
  assert.equal(JSON.parse(readFileSync(join(fixture.project, "dist/package.json"), "utf8")).version, version);
});
