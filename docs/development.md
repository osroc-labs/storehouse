# Development

## Setup

1. Install the pinned Node and pnpm: `asdf install` (or `mise install`) reads `.tool-versions`.
2. `pnpm install`. It also builds `dist/`.

## The gate

`pnpm check` is the one gate, the same locally and in CI (`.github/workflows/pr.yml`, on every pull request, on Linux and macOS). It typechecks (`tsc -b`), lints (oxlint, oxfmt, knip) and runs the tests. `pnpm fix` fixes what lint and format can.

- **Lint holds only cheap rules with one right answer.** Taste lives in the `code-style` skill and in review.
- **A disable names one rule and its reason:** `// oxlint-disable-next-line <rule> -- <why>`.
- **Knip fails on an export nothing imports.**
- **The site's generated docs must be current** ([§ The site](#the-site)), and the site must build.

## Tests

- **A test sits beside the module it tests,** and runs with `node --test`.
- **Nothing reaches Google or a real CLI.** The tests run against a fake Secret Manager in the test process (`src/testing/`), with faults injected on purpose, and fake CLIs on a temporary `PATH` that record their argv.
- **No value leaks.** Every CLI test run fails if a secret value turns up in stdout, stderr or a CLI's argv or env (`get` printing one is the exception it's for).
- **Property tests** (`*.property.test.ts`, fast-check) cover what has too many inputs to list: the dotenv writer against both parsers, the protected-env guard against the CLI's parser, the paste reader over every chunk split.
- **Coverage gates the run:** `pnpm test` fails below 97% of lines and functions and 90% of branches in `src/`. Those numbers sit just under today's; what's left uncovered is mostly the real terminal (raw mode), which the pseudo-terminal tests run in a child process the coverage can't see.
- **`pnpm test:live`** runs the commands against a real project, set by `STOREHOUSE_LIVE_PROJECT`, with throwaway `storehouse-live-<random>` secrets it deletes in a `finally`. It never touches another name. It isn't part of `pnpm check`.

## Releases

A plain tag-based release: a `v*` tag runs `.github/workflows/release.yml` in three jobs. `verify`, with no OIDC token, checks the tagged commit is on `master` before any of its code runs, then runs `pnpm install --frozen-lockfile` and the whole `pnpm check` (the site included), and checks the tag matches `package.json`. `pack`, with no OIDC token either, checks out the commit again, installs only the library (`pnpm install --frozen-lockfile --filter @osroc-labs/storehouse`, so the site's toolchain never runs where the tarball is made), packs it (`pnpm pack` turns `catalog:` into real versions) and uploads the tarball with its sha256. `publish`, in the `npm` environment and the only job that can mint the OIDC token, checks out nothing and installs nothing: it downloads the tarball, checks its sha256 against `pack`'s, and runs `npm publish <tarball> --provenance --ignore-scripts` on a pinned Node (24.22.1, npm 11.19.1). npm's trusted publishing signs in with that token, so there's no `NPM_TOKEN`.

To release:

1. Move the "Unreleased" section of CHANGELOG.md under the new version, and set `version` in package.json to match.
2. Merge that to `master`.
3. `git tag v<version> && git push origin v<version>`.

Once, before the first release, the owner:

1. Creates the npm organization `osroc-labs` on npmjs.com, if it doesn't exist yet.
2. Makes the GitHub repository public: npm's provenance needs a public repository.
3. Adds a trusted publisher to the package on npmjs.com (the package's Settings → Trusted publishing): GitHub Actions, organization `osroc-labs`, repository `storehouse`, workflow `release.yml`, environment `npm`. It needs npm CLI 11.5.1 or later, which Node 24 ships.
4. Once the repository is public, and before the first `v*` tag, protects the release in GitHub's settings. These two are the real gate; the workflow's own checks come from the tagged commit, so they only catch an honest mistake.
   - A tag ruleset on `refs/tags/v*`: only admins may create, update or delete such a tag (restrict creations, updates and deletions, with the admin role as the only bypass).
   - On the `npm` environment: deployment branches and tags limited to the `v*` tag pattern, and a required reviewer, so every publish waits for a person to approve it.
5. If npm won't take a trusted publisher before the package exists, publishes 0.1.0 once by hand from a clean checkout of the tag (`pnpm install && pnpm pack`, then `npm publish osroc-labs-storehouse-0.1.0.tgz --access public` while logged in to npm), then adds the trusted publisher. Every later release goes through the workflow.

## The site

`site/` is the one-page site at https://storehouse.osroc.io: an Astro build of static files, served by Workers Static Assets (`site/wrangler.jsonc`). It's a workspace package of its own, so the npm package never includes it. Its look follows `site/brand/BRAND.md`; what it says comes from the README and the CLI.

- `pnpm --filter storehouse-site dev` runs it locally.
- **Nothing on it is typed from the README or the CLI by hand.** `site/scripts/cli-docs.ts` runs each command's `--help`, runs `storehouse status` against the fake Secret Manager (and fails unless the README's sample is that output), runs `storehouse check` on the README's Quickstart manifest, checks the README's exit codes are the ones the CLI exits with, and parses the README sections the site shows (Install, Quickstart, Commands, Working with coding agents, Protected environments, Why). It writes them all to `site/src/generated/cli-docs.json`. `pnpm check` fails when that file is stale, so a README or CLI change fails until you run `pnpm --filter storehouse-site run docs` and commit the result. Only the headline, subhead, buttons and the status sentence are the site's own.
- **The brand kit is the source of its assets.** `site/public/` links the favicons and OG card from `site/brand/` rather than copying them. The OG card draws the install line, so the check also fails when `site/brand/build.mjs` doesn't say the README's.
- **Headers** are in `site/public/_headers`: hashed `/_astro/*` files cache for a year, and every response carries a CSP (`default-src 'self'`, plus the analytics beacon below), `nosniff`, `X-Frame-Options: DENY`, a referrer policy and a permissions policy. Styles and scripts are always separate files (`site/astro.config.ts`), so the CSP needs no inline hashes.
- **Analytics.** The osroc.io zone's Cloudflare Web Analytics adds its beacon (`https://static.cloudflareinsights.com/beacon.min.js`) to every page at the edge; it's not in the repo. It counts visits without cookies, to gauge interest, and the CSP allows its script and its report to `/cdn-cgi/rum` or `cloudflareinsights.com`. It's turned off in the zone's Web Analytics settings, not here.
- **Deploy:** `pnpm --filter storehouse-site run deploy` builds and runs `wrangler deploy`. It needs a wrangler login to the account that owns osroc.io. Deploy only from a commit whose `pnpm check` passes, and after every push to the site's branch.
