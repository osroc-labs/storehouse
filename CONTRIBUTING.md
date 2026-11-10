# Contributing

Thanks for helping. A bug report with the command you ran and its output is as useful as a pull request; never paste a secret's value, a token or a key file.

## Run it

```sh
asdf install                  # Node and pnpm, from .tool-versions (or mise install)
pnpm install                  # also builds dist/
pnpm check                    # typecheck, lint, format, unused exports, tests with coverage: what CI runs
node src/cli.ts --help        # the CLI from source
```

`pnpm fix` fixes what lint and the formatter can. [docs/development.md](docs/development.md) has the rest, and [AGENTS.md](AGENTS.md) points to every doc.

## Tests

- A test sits beside its module and runs with `node --test`.
- Nothing reaches Google. Tests run against a fake Secret Manager in the test process (`src/testing/fake-secret-manager.ts`), which can also fail on purpose: a 429, a timeout, a dropped connection.
- Push targets run against fake CLIs on a temporary PATH (`src/testing/fake-cli.ts`) that record their argv, stdin and env.
- Every test run checks that no secret value reached stdout, stderr or a CLI's argv or env.
- `pnpm check` fails when coverage of `src/` drops below its threshold.
- `STOREHOUSE_LIVE_PROJECT=<project> pnpm test:live` runs against a real project you can create secrets in, with throwaway `storehouse-live-*` secrets it deletes afterwards. It isn't part of `pnpm check`.

## Adding a push target

1. Add its schema to the `pushTarget` union in `src/manifest/schema.ts`, with a description on every field, and run `pnpm schema`.
2. Add `src/push-targets/<target>.ts`: `format` (how a push names it) and `getInvocations` (each CLI run, values on stdin only). Read the CLI's source for how it reads stdin, and refuse a value it would change.
3. Add it to the table in `src/push-targets/push-targets.ts`. The build fails until you do.
4. Test it in `src/push-targets/push-targets.test.ts` with a fake CLI: the argv and stdin, a missing CLI, not logged in, a failure, and a value it can't take.
5. Document it in the README and in `docs/spec.md`.

## Pull requests

- One change per pull request, with what was asked and how it's solved.
- `pnpm check` passes.
- A new user-facing message is one plain sentence that names the fix.
