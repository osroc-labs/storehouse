# Layout

You should find a thing from what it does, and what's used together sits together.

## Rules

1. **A folder is named for what it serves:** the command line, the manifest, Secret Manager, the terminal, push targets. `utils/` (pure, tested helpers), `testing/` (test-only code) and `scripts/` are the kind-named exceptions.
2. **A test sits beside its module:** `manifest.ts`, `manifest.test.ts`.
3. **A move is a move.** Rename outright and fix every import.

## The repo

```
src/
  cli.ts            the `storehouse` binary
  index.ts          what the package exports (protectedInvocation, the manifest schema)
  run.ts            one command line, start to exit code
  command-line/     parsing argv, the commands table, help
  commands/         one file per command
  manifest/         the Zod schema, its JSON Schema, reading and checking storehouse.json
  secret-manager/   the REST API, secrets in our types, credentials
  push-targets/     one file per platform, and running its CLI
  protect/          protected envs and agent detection
  agents/           the guide for coding agents, and its block in AGENTS.md
  terminal/         stdin, stdout and the hidden prompt
  utils/            format (everything a person reads), mapAll
  testing/          the fake Secret Manager and test helpers; never published
lint/               the project's own oxlint rules
skills/storehouse/  the skill `npx skills add osroc-labs/storehouse` installs
scripts/            schema.ts, live.ts: run with plain `node`
site/               the one-page site at storehouse.osroc.io (Astro); its own package, never published
  brand/            the brand kit, kept as delivered: logo, fonts, colors, BRAND.md
  scripts/          cli-docs.ts: runs the CLI to write src/generated/cli-docs.json
docs/               what this file and AGENTS.md point to
```
