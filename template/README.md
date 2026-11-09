# {{NAME}}: GitHub mirror of pstack-claude

> **This is an unofficial mirror, not the official package.**
> It is an unmodified copy of the GitHub repository [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude), republished on npm for networks that can reach an npm registry mirror but not GitHub.
> It is **not** published by or affiliated with the upstream author (Michael Denyer), or with the original pstack author (Lauren Tan / Cursor).
> Report bugs and feature requests [upstream](https://github.com/michael-denyer/pstack-claude/issues), not to this mirror.

**What the mirror changes:** nothing in the upstream files. It only adds `bin/` (the installer), this `README.md` (upstream's README is kept as `UPSTREAM-README.md`), `LICENSE-mirror`, and its own `package.json`.

| | |
|---|---|
| Package version | `{{VERSION}}` (same as upstream `VERSION`) |
| Upstream ref | `{{REF}}` |
| Upstream commit | `{{COMMIT}}` ({{DATE}}) |
| Marketplace / plugin | `{{PLUGIN}}@{{MARKETPLACE}}` |

The package contains the upstream marketplace exactly as published (`.claude-plugin/marketplace.json` + `plugins/pstack/`) plus a small installer. No install scripts run on `npm install`.

## Install (OMP and/or Claude Code)

```shell
npm install -g {{NAME}}          # registry = your intranet npm mirror
{{BIN}} install                 # every CLI found on PATH
{{BIN}} install omp             # only OMP
{{BIN}} install claude          # only Claude Code
```

Or without a global install: `npx -y {{NAME}}@latest install omp`.

`install` copies the marketplace to `~/.pstack-claude-mirror/marketplace` (override with `--dir` or `$PSTACK_CLAUDE_HOME`), then runs the equivalent of:

```shell
omp plugin marketplace add ~/.pstack-claude-mirror/marketplace
omp plugin install --scope=user {{PLUGIN}}@{{MARKETPLACE}}

claude plugin marketplace add ~/.pstack-claude-mirror/marketplace
claude plugin install {{PLUGIN}}@{{MARKETPLACE}} --scope user
```

Restart OMP / start a new Claude Code session afterwards. Use `--dry-run` to see the commands, `--scope project` for a project-scoped install.

## Update

```shell
npm install -g {{NAME}}@latest
{{BIN}} update
```

`update` replaces `~/.pstack-claude-mirror/marketplace`, runs `omp plugin marketplace update` + `omp plugin upgrade`, and `claude plugin marketplace update` (Claude Code reads the plugin in place from that directory).

## Uninstall

```shell
{{BIN}} uninstall
rm -rf ~/.pstack-claude-mirror
npm uninstall -g {{NAME}}
```

## Other harnesses

- **Pi** (untested): `pi install npm:{{NAME}}` (the package keeps upstream's `pi` manifest).
- **Skills-only** (Gemini CLI, Codex skills, …): link `$(npm root -g)/{{NAME}}/plugins/pstack/skills/*` into `~/.agents/skills/`, see `UPSTREAM-README.md`.

## Notes

- If OMP or Claude Code already has a `{{MARKETPLACE}}` marketplace pointing at GitHub, the installer stops; remove it first with `omp plugin marketplace remove {{MARKETPLACE}}` / `claude plugin marketplace remove {{MARKETPLACE}}`.
- Some pstack skills call `gh`, `bun`, or GitHub at run time (PR babysitting, etc.); those still need the corresponding access.

## License

Everything except the mirror's own files is redistributed unchanged under the upstream MIT licenses, with every upstream copyright and permission notice kept as it is:

| Component | Copyright | License file |
|---|---|---|
| pstack (skills, principles, scripts, `poteto-agent`, `comment-sicko`) | © 2026 Lauren Tan | `LICENSE` |
| The Claude Code / multi-runtime port (all modifications and additions) | © 2026 Michael Denyer | `LICENSE` |
| `deslop`, `make-pr-easy-to-review`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `what-did-i-get-done` (cursor-team-kit) | © 2026 Cursor | `LICENSE-cursor-team-kit` |
| `thermos`, `thermo-nuclear-*` skills and agents | © 2026 Cursor | `LICENSE-thermos` |
| Mirror additions only: `bin/`, this `README.md`, `package.json` | © 2026 The pstack-claude-mirror maintainers | `LICENSE-mirror` |

The full per-directory provenance is in `NOTICE.md` (it links to `CHANGES.md`, `tools/substitutions.json`, `tools/forks.json`, `tools/upstream.json` and `docs/reference.md`, all included). A copy of the license files also ships inside the plugin at `plugins/pstack/skills/poteto-mode/references/licenses/`, so it reaches the OMP / Claude Code plugin cache.

Each mirror build stops if any upstream license file, `NOTICE.md` row, or skill `license:` field is no longer MIT, so a component under another license is never republished without review.

The software is provided "as is", without warranty of any kind (see the license files). The mirror does not imply any endorsement by the upstream authors.
