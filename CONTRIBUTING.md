# Contribute to pstack-mirror

This repository owns the npm mirror builder, installer, and publishing workflow. Report problems in those components here. Report problems in the mirrored plugin to [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude/issues).

## Run the checks

Use Node.js 18 or later, npm, and Git. Install the locked dependency before running checks.

```shell
npm ci --ignore-scripts
npm test
```

Tests use temporary directories, local upstream fixtures, and isolated external-command fixtures. They must not use your real plugin configuration, npm credentials, or the public registry.

To inspect a real package without publishing it, run:

```shell
npm run sync -- --ref v0.9.133
npm pack ./dist --dry-run
```

Use a temporary `HOME` and working directory for installer checks. Also isolate `CLAUDE_CONFIG_DIR` and the XDG configuration, data, and state directories. Do not point `--dir` at a directory containing your own files.

## Submit a change

1. Keep the change focused on mirror-owned code. Do not edit downloaded upstream files in `.upstream/` or generated files in `dist/`.
2. Add a regression test for changed behavior. Check filesystem effects, exit status, and package identity rather than implementation details or exact log wording.
3. Run `npm test`. For installer changes, also exercise the packed CLI with an isolated configuration and record the CLI versions.
4. Update the relevant README when a command or safety guarantee changes.
5. Explain the user-visible problem, the change, and verification in the pull request.

Do not commit registry tokens, generated tarballs, local plugin state, or audit logs. See [SECURITY.md](SECURITY.md) for security reports.

## Licensing

The root [LICENSE](LICENSE) covers this repository's own source, tests, documentation, and workflows under MIT. By contributing, you agree to license your contribution under MIT.

Downloaded upstream content retains its own copyright and license notices. The published package uses `LICENSE-mirror` for mirror additions and keeps upstream license files unchanged.
