# pstack-mirror

Builds and publishes [`pstack-claude-mirror`](https://www.npmjs.com/package/pstack-claude-mirror), an unofficial npm mirror of the GitHub repository [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude). With it, machines that can reach an npm registry mirror but not GitHub can install pstack into OMP and Claude Code.

The mirror is not affiliated with the upstream author. Report mirror installation, synchronization, and publishing problems in [this repository](https://github.com/ZedRover/pstack-claude-mirror/issues). Report plugin behavior problems [upstream](https://github.com/michael-denyer/pstack-claude/issues).

## How it works

- Upstream is a plugin marketplace (`.claude-plugin/marketplace.json` plus `plugins/pstack/`). OMP and Claude Code can both add a marketplace from a local directory, so the package ships those two parts unchanged.
- The package includes an installer, `pstack-claude-mirror`. It copies the marketplace to a stable directory, `~/.pstack-claude-mirror/marketplace`, then runs `marketplace add` and `plugin install`, or `marketplace update` and `plugin upgrade` on later runs. The directory must be stable because Claude Code reads the plugin in place from it, and a path inside the npm or npx cache could vanish.
- The npm version normally equals upstream's `VERSION`. Mirror-only fixes use a checked-in `mirrorRevisions` entry in this repository's `package.json`, producing `<upstream>-mirror.<revision>` without changing plugin files. Release explicitly updates npm's `latest` tag. A new upstream version without an entry uses its own version.

## Building and publishing (machine with GitHub access)

Use Node.js 18 or later, npm, and Git. `cross-spawn` handles Windows command shims without passing user paths through an unescaped shell command.

```shell
npm ci --ignore-scripts   # install the locked builder dependency
npm run sync              # fetch the newest upstream tag and build dist/
npm run sync:main         # sync the main branch instead (version still comes from upstream VERSION)
npm run pack              # build and write pstack-claude-mirror-<version>.tgz
npm login                 # once, before the first publish
npm run release           # npm publish, only when this version is not on the registry yet
```

The package name defaults to `pstack-claude-mirror`. Set `PKG_NAME` to override it. Four places mark the package as an unofficial GitHub mirror that is not affiliated with the upstream author: the npm description, the top of the package README, the `pstackMirror.notice` field in `package.json`, and the absence of upstream's `author` field.

If the npm account uses two-factor authentication, use `npm run release -- --otp=<code>`, or approve the browser prompt. Use `npm run release -- --ref v0.9.133 --dry-run` to inspect a release without publishing it. Release always syncs the requested upstream source first and never publishes a leftover `dist/` after a skipped sync.

For a mirror-only fix to an already published upstream version, increment that version's positive integer in `mirrorRevisions`. For example, `"0.9.133": 1` publishes `0.9.133-mirror.1` with upstream plugin version `0.9.133`. This is a SemVer prerelease suffix, so use `@latest` or the exact package version rather than a stable-version range to receive it.

Release creates a private `.pstack-release-*` directory in this checkout and removes it when npm finishes. Do not run release from a read-only checkout. With npm 10, avoid `#` and `%` in the checkout path because its package parser mishandles those characters. Use npm 11 on Node.js 22 for those paths.

Use `--option=value` for additional npm configuration options. Positional package targets and workspace redirection are refused, so publication cannot switch away from the current build.

### Automatic sync (GitHub Actions)

Push this directory to your own GitHub repository. `.github/workflows/sync-publish.yml` checks upstream every 6 hours and can be triggered by hand with an optional `ref`. It runs tests before release and serializes publications for the package. Only the repository's default branch can publish. Your intranet registry mirror then picks up each new version on its next sync.

CI authentication:

1. On npmjs.com, create a **granular access token** with read and write access to packages, and with **Bypass two-factor authentication** enabled. Without bypass, CI fails with `EOTP`. Before the first publish the package does not exist yet, so the token has to cover all packages. Narrow it afterwards.
2. In this GitHub repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add it as `NPM_TOKEN`.
3. Run the workflow once by hand (**Actions → sync-and-publish → Run workflow**), or wait for the schedule.

Once the package exists, you can switch to [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) and delete the token. On npmjs.com, add a trusted publisher in the package settings for this repository and `sync-publish.yml`. Use npm 11.5.1 or later with Node.js 22.14.0 or later in the workflow. Trusted Publishing needs no secret, because the workflow already grants `id-token: write`.

The workflow publishes with `--provenance`, so the npm page links each version to the Actions run that built it. Provenance requires `repository` in the published `package.json` to point at this repository. The build sets it from `GITHUB_REPOSITORY`, or from `MIRROR_REPOSITORY` for local builds. Upstream stays in `homepage` and in the `pstackMirror` field.

To change the package name, set the `PKG_NAME` repository variable.

## Installing (intranet machine)

```shell
npm install -g pstack-claude-mirror
pstack-claude-mirror install          # every CLI found on PATH (omp, claude)
pstack-claude-mirror install omp      # OMP only

# upgrade
npm install -g pstack-claude-mirror@latest && pstack-claude-mirror update

# uninstall
pstack-claude-mirror uninstall
```

Other options: `--dry-run`, `--scope project`, `--dir <path>`. Restart OMP or start a new Claude Code session after installing. Pi may work with `pi install npm:pstack-claude-mirror`, since the package keeps upstream's `pi` manifest, but that path is untested.

`--dir` accepts a new or empty directory, or an existing directory with this package's ownership marker. The installer checks all selected CLI registrations before replacing files. It refuses unrelated contents and symbolic-link destinations. Keep personal files outside the managed marketplace directory.

## Contributing and maintenance

Run `npm test` before submitting a change. The tests use temporary directories and local fixtures, without publishing or accessing your real plugin configuration. Pull-request checks are configured for Linux, macOS, and Windows on Node.js 18, 22, and 24.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for vulnerability reporting. In GitHub repository settings, require the `checks` workflow's test jobs before merging to the default branch. The workflow files do not enable branch protection themselves.

## Licensing

The root [LICENSE](LICENSE) covers this repository's own scripts, installer template, tests, documentation, and workflows under MIT. Downloaded upstream content retains its own copyright and licenses. The root license is not substituted for upstream's license in the published package.

Every upstream component is MIT-licensed: pstack is © Lauren Tan, the port is © Michael Denyer, and the cursor-team-kit and thermos skills are © Cursor. MIT permits redistribution as long as the copyright and permission notices travel with the copy.

- `LICENSE`, `LICENSE-cursor-team-kit`, `LICENSE-thermos`, `NOTICE.md`, and `NOTICE-skills.md` ship unchanged at the package root, byte-identical to upstream. A second copy inside the plugin travels into the OMP and Claude Code plugin caches.
- `NOTICE.md` links to provenance files: `CHANGES.md`, `tools/{substitutions,forks,upstream}.json`, and `docs/reference.md`. These ship too, so the links resolve inside the package.
- The mirror's own files (`bin/`, the package README, `package.json`) are covered by `LICENSE-mirror` (MIT). That file states it covers only those files.
- On every build, `scripts/sync.mjs` checks upstream's package license, license files, supported NOTICE tables, referenced license paths, and explicit skill licenses. Missing references, unknown table formats, and non-MIT declarations stop the build with exit code 2. The check is a publication policy, not a full legal or security audit.

## Verified

Tested with OMP 18.14.0 and Claude Code 2.1.319, each in an isolated `HOME`:

- `install` from a global tarball install: OMP and Claude Code both install the plugin.
- Repeated `update` keeps both plugins installed at the package version. Existing ownership markers remain accepted across installer upgrades.
- User and project scopes can coexist. Removing the project installation preserves the user installation.
- `uninstall` removes the requested plugin scope. It keeps shared marketplaces and Claude registrations whose declaration scope is not reported by the CLI.
- The license gate rejects an upstream that adds an Apache-licensed `LICENSE` file.
- Rejected installation preserves unrelated directory contents. Uninstall succeeds again when the selected plugin is already absent.
- Release skips an already-published version without using residual `dist/`. Registry errors other than an explicit missing version stop publication.

The automated suite passes locally on Node.js 18 and 22. The configured macOS, Windows, and Node.js 24 CI jobs require a pushed change to run.
