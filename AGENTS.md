# storehouse

A command-line tool for Google Secret Manager, with a manifest in the repo. Published as `@osroc-labs/storehouse`.

This file is a router. It stays short: rules live in the doc that owns them, and you read only the doc for what you're doing.

**Status: preparing the first public release** ([docs/plan.md](docs/plan.md)).

`pnpm check` is the gate CI runs (`.github/workflows/pr.yml`) · `pnpm lint` lints · `pnpm fix` lints and formats · `pnpm test:live` runs against a real project.

## Always

1. **This project's docs win over the skills.** A choice that differs is a dated line in [plan.md § Decisions](docs/plan.md#decisions), and you follow it.
2. **`pnpm check` passes before work is called done.** ([development.md § The gate](docs/development.md#the-gate))
3. **A value never reaches argv, a log, an error or a test's output.** Values go to a CLI on stdin, and the leak tests fail on a hit. ([development.md § Tests](docs/development.md#tests))
4. **Never touch a real secret you didn't create.** Live checks use throwaway `storehouse-live-*` secrets and clean them up. No agent runs a command against a protected env.
5. **The manifest is never written by storehouse.** People add secrets to it in a commit. ([docs/spec.md](docs/spec.md))
6. **Check the real system before trusting a doc.** If they disagree, fix the doc in the same change.
7. **A pull request says what was asked and how it's solved,** briefly. ([how-we-work.md](docs/how-we-work.md))

## Where to look

| Doing… | Read |
| --- | --- |
| What it is, who it's for, principles | [docs/vision.md](docs/vision.md) |
| What's being built now, and every decision that differs from the skills | [docs/plan.md](docs/plan.md) |
| The design: manifest, commands, protected envs, push targets | [docs/spec.md](docs/spec.md) |
| Setup, the gate, tests, live tests, releases, the site | [docs/development.md](docs/development.md) |
| Where code lives, and where a new file goes | [docs/layout.md](docs/layout.md) |
| Docs, pull requests, commits, memory | [docs/how-we-work.md](docs/how-we-work.md) |
| Writing or reviewing code | the `code-style` skill |
| Opening a PR and getting it green | the `ship` skill |
| Reviewing a change | the `review-code` skill (start with its `references/checklist.md`) |

## Plan mode

Keep plans extremely concise (sacrifice grammar), and end with any unresolved questions.
