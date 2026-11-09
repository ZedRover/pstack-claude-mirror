# pstack-mirror

Builds and publishes [`pstack-claude-mirror`](https://www.npmjs.com/package/pstack-claude-mirror), an unofficial npm mirror of the GitHub repository [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude). With it, machines that can reach an npm registry mirror but not GitHub can install pstack into OMP and Claude Code.

The mirror is not affiliated with the upstream author. Report bugs in pstack itself upstream.

## How it works

- Upstream is a plugin marketplace (`.claude-plugin/marketplace.json` plus `plugins/pstack/`). OMP and Claude Code can both add a marketplace from a local directory, so the package ships those two parts unchanged.
- The package includes an installer, `pstack-claude-mirror`. It copies the marketplace to a stable directory, `~/.pstack-claude-mirror/marketplace`, then runs `marketplace add` and `plugin install`, or `marketplace update` and `plugin upgrade` on later runs. The directory must be stable because Claude Code reads the plugin in place from it, and a path inside the npm or npx cache could vanish.
- The npm version equals upstream's `VERSION`, which matches upstream's `vX.Y.Z` tags. By default the build syncs the newest release tag and skips versions that are already published.

## Building and publishing (machine with GitHub access)

```shell
npm run sync              # fetch the newest upstream tag and build dist/
npm run sync:main         # sync the main branch instead (version still comes from upstream VERSION)
npm run pack              # build and write pstack-claude-mirror-<version>.tgz
npm login                 # once, before the first publish
npm run release           # npm publish, only when this version is not on the registry yet
```

The package name defaults to `pstack-claude-mirror`. Set `PKG_NAME` to override it. Four places mark the package as an unofficial GitHub mirror that is not affiliated with the upstream author: the npm description, the top of the package README, the `pstackMirror.notice` field in `package.json`, and the absence of upstream's `author` field.

If the npm account uses two-factor authentication, `npm publish` asks for a one-time password. Pass `--otp=<code>` to `node scripts/publish.mjs`, or approve the browser prompt.

### Automatic sync (GitHub Actions)

Push this directory to your own GitHub repository. `.github/workflows/sync-publish.yml` checks upstream every 6 hours, publishes new versions to npmjs, and can also be triggered by hand with an optional `ref`. Your intranet registry mirror then picks up each new version on its next sync.

CI authentication:

1. On npmjs.com, create a **granular access token** with read and write access to packages, and with **Bypass two-factor authentication** enabled. Without bypass, CI fails with `EOTP`. Before the first publish the package does not exist yet, so the token has to cover all packages. Narrow it afterwards.
2. In this GitHub repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add it as `NPM_TOKEN`.
3. Run the workflow once by hand (**Actions → sync-and-publish → Run workflow**), or wait for the schedule.

Once the package exists, you can switch to [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) and delete the token. On npmjs.com, add a trusted publisher in the package settings: GitHub Actions, this repository, workflow file `sync-publish.yml`. Then upgrade npm to 11.5 or later in the workflow. Trusted Publishing needs no secret, because the workflow already grants `id-token: write`.

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

## Licensing

Every upstream component is MIT-licensed: pstack is © Lauren Tan, the port is © Michael Denyer, and the cursor-team-kit and thermos skills are © Cursor. MIT permits redistribution as long as the copyright and permission notices travel with the copy.

- `LICENSE`, `LICENSE-cursor-team-kit`, `LICENSE-thermos`, `NOTICE.md`, and `NOTICE-skills.md` ship unchanged at the package root, byte-identical to upstream. A second copy inside the plugin travels into the OMP and Claude Code plugin caches.
- `NOTICE.md` links to provenance files: `CHANGES.md`, `tools/{substitutions,forks,upstream}.json`, and `docs/reference.md`. These ship too, so the links resolve inside the package.
- The mirror's own files (`bin/`, the package README, `package.json`) are covered by `LICENSE-mirror` (MIT). That file states it covers only those files.
- **License gate:** on every build, `scripts/sync.mjs` checks upstream's `package.json` license field, every LICENSE/COPYING file, the License column of each `NOTICE.md` row, and each skill's `license:` field. If any of them is not MIT, the build exits with code 2 and CI publishes nothing until someone reviews the change.

## Verified

Tested with OMP 18.14.0 and Claude Code 2.1.319, each in an isolated `HOME`:

- `install` from a global tarball install: OMP and Claude Code both install the plugin.
- Running `update` again changes nothing.
- After a simulated upstream bump to 0.9.134, `update` upgrades OMP to the new cache directory, and Claude Code loads the updated directory.
- `uninstall` removes the plugin and the marketplace from both.
- The license gate rejects an upstream that adds an Apache-licensed `LICENSE` file.
