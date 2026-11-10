# Plan

What's being built now, and every decision that differs from the skills this project started from.

## Now

The first public release: the CLI from [spec.md](spec.md) (manifest, status, set, get, history, check, pull, push to Cloudflare Workers, GitHub Actions, Vercel and Fly, protected envs), Google auth without the SDK, and the repo ready for strangers. Publishing to npm and making the repo public are the owner's steps ([development.md § Releases](development.md#releases)).

## Decisions

A project choice wins over a skill's default. Each is one dated line, tagged with the scaffold layer or file it covers, saying what was chosen and why.

- 2026-11-09 [skills] Started from the `new-project` skill, brought up to it after the first PR. The owner's skills are installed locally with `npx skills add` and are not part of this repo (`.gitignore`). (Tanner)
- 2026-11-09 [web, storybook, e2e, worker, database, format] Not used: storehouse is a CLI and a small library, with no UI, Worker or database. (Agent)
- 2026-11-09 [tests] `node:test`, not Vitest. Node runs the TypeScript itself, there's one runtime, and the coverage gate is Node's own `--test-coverage-*`. (Agent)
- 2026-11-09 [tsconfig.build.json] A second tsconfig emits `dist/`: the published package can't ship `.ts` (Node won't strip types inside `node_modules`). (Agent)
- 2026-11-09 [ci] `pr.yml` runs on `ubuntu-latest` and `macos-latest`: the terminal code (raw mode, the pseudo-terminal tests) differs between them. (Tanner)
- 2026-11-09 [README.md] The README is for people using storehouse, not working on it; its "Run it" block lives in [CONTRIBUTING.md](../CONTRIBUTING.md). (Agent)
- 2026-11-09 [release] A plain tag-based release (`v*` tag, npm trusted publishing), not changesets: one package, one maintainer, a hand-written CHANGELOG. (Agent)
- 2026-11-09 [web] A one-page marketing site in `site/`: static Astro on Workers Static Assets at storehouse.osroc.io, its own workspace package, not the scaffold's web layer. Astro matches osroc.io's site. (Tanner)
- 2026-11-09 [site] No `astro check`: `@astrojs/check` 0.9.12 won't load with Astro 7's wasm peers. The site's code is a little markup and one script that `tsc -b` checks; `astro build` catches the rest. (Agent)
