# storehouse

A command-line tool for Google Secret Manager: a manifest in the repo says which secrets each environment has, and one short command sets, reads, pulls or pushes them.

```
$ storehouse status
             dev          stage        purpose
AUTH_SECRET  set 10d ago  set 10d ago  Signs session cookies.
SMS_SID      set 2d ago   missing      The SMS account that texts sign-in codes.
SEED_TOKEN   set 7d ago   -            A sandbox token, for the seed script.

prod is protected and not shown. Name it to include it: storehouse status dev stage prod
```

## Why

Secret Manager is a good place to keep secrets, and `gcloud secrets` is a hard way to work with them. Every command needs the full secret name, the project and `--data-file=-`. Nothing shows what's set in which environment. Getting values into a local `.env` or onto the platform where the app runs is a script each team writes for itself.

storehouse keeps Secret Manager as the one source of truth and adds:

- **A manifest in the repo,** `storehouse.json`: every secret, what it's for and which environments use it, reviewed in a commit. storehouse never writes to it.
- **One picture:** `storehouse status` shows what's set where, and exits non-zero when a required secret is missing.
- **Pulls and pushes:** a local dotenv file for development, and pushes to Cloudflare Workers, GitHub Actions, Vercel and Fly, always with values on stdin, never in a command's arguments.
- **A CI check** that the manifest is valid and that every secret your GitHub Actions workflows read exists.
- **Protected environments:** prod needs a person at a terminal who types its name, and refuses a coding agent that announces itself. A label on each prod secret keeps that rule when the manifest is edited; [the limits](#protected-environments) say what it doesn't stop.

| Instead of | Why storehouse |
| --- | --- |
| `gcloud secrets` | Short commands by key and environment, a status table, pulls and pushes. |
| fnox, secretspec, varlock | Built for Secret Manager alone, with its own login (`gcloud`) or application default credentials, a manifest it never rewrites, and no `exec` that hands a command your production secrets. |
| Doppler, Infisical, 1Password | They replace Secret Manager. storehouse works with the secrets, IAM and audit logs you already have. |

## Install

storehouse runs on macOS and Linux (not Windows yet) with Node 24 or later.

```sh
npm install -g @osroc-labs/storehouse     # the storehouse command, everywhere
npx @osroc-labs/storehouse status         # or once, without installing
pnpm add -D @osroc-labs/storehouse        # or per project: pnpm storehouse status
```

It signs in to Google the way `gcloud` does, so if `gcloud auth login` works, storehouse works. [Auth](#auth) has the other ways.

## Quickstart

In a project where you can create secrets (a scratch one is best for a first try):

1. Write `storehouse.json` at the root of your repo:

   ```json
   {
     "$schema": "https://cdn.jsdelivr.net/npm/@osroc-labs/storehouse/schema.json",
     "project": "my-gcp-project",
     "name": "myapp-{env}-{key}",
     "envs": {
       "dev": {},
       "prod": { "protected": true }
     },
     "secrets": {
       "API_KEY": { "purpose": "Calls the payments API.", "required": true }
     }
   }
   ```

2. `storehouse check` checks it, with no Google access.
3. `storehouse status` shows `API_KEY` missing in dev, and exits 4 because it's required.
4. `storehouse set dev API_KEY` asks for the value (hidden) and stores it as `myapp-dev-API_KEY`. Piping works too: `printf %s "$VALUE" | storehouse set dev API_KEY`.
5. `storehouse status` shows it set. `storehouse history dev` shows when.
6. `storehouse pull dev` writes `.env.dev` (0600) for local development, and adds it to `.gitignore` if git doesn't already ignore it.

## The manifest

`storehouse.json` is found in the current directory or the nearest parent. Paths in it are relative to it, so a repo can hold one per app directory. Add the `$schema` line above and your editor completes and checks it.

| Field | |
| --- | --- |
| `project` | The Google Cloud project id that holds the secrets. |
| `name` | How an env and a key become a Secret Manager name, with `{env}` and `{key}`: `"myapp-{env}-{key}"`. |
| `envs.<env>` | An environment. Its name is lowercase letters, digits, `-` and `_`. |
| `envs.<env>.project` | This env's project, for apps that keep each env in its own. |
| `envs.<env>.protected` | `true` for an env only people may use ([below](#protected-environments)). |
| `envs.<env>.pull.file` | The dotenv file `pull` writes, a relative path inside the repo. Default: `.env.<env>` beside `storehouse.json`. |
| `envs.<env>.push` | Where `push` sends the env's secrets: a list of [targets](#push-targets). |
| `secrets.<KEY>` | A secret, by the environment variable name the app reads. |
| `secrets.<KEY>.purpose` | What it's for. Required, and shown by `status`. |
| `secrets.<KEY>.required` | A missing required secret fails `status` and stops `pull` and `push`. Default `false`. |
| `secrets.<KEY>.envs` | The envs that use it. Default: all of them. |
| `secrets.<KEY>.pull` / `.push` | Whether `pull` writes it and `push` sends it. Default `true`. |
| `secrets.<KEY>.name` | Its own name pattern, for a secret that already has a name. |
| `workflows` | GitHub Actions that name secrets, for `check` ([below](#check-in-ci)). |

`project` and `name` may be left out at the top when every env has a project and every secret a name. `$schema` can also point at `./node_modules/@osroc-labs/storehouse/schema.json`, the schema of the version you installed.

## Commands

The env is always the first word after the command, and a key is always a manifest key, never a Secret Manager name. Every command takes `--help`.

| Command | |
| --- | --- |
| `storehouse status [env…]` | One row per secret and one column per env: `set` with when it last changed, `missing`, `MISSING` when it's required, `no access`, or `-` where it isn't used. With no env it shows every env except protected ones. `--json`. Never reads a value. |
| `storehouse set <env> <KEY>` | Reads the value from a hidden prompt, or stdin when piped, and drops one trailing newline. At the prompt, Enter ends the value, and a multi-line value such as a PEM key can be pasted whole. Creates the secret if it's new, and adds a version only when the value changed. Prints the name, never the value. |
| `storehouse get <env> <KEY>` | Prints the latest value exactly as stored. `--out <path>` writes it to a 0600 file instead; `--force` replaces one, or writes inside git's own directory. |
| `storehouse history <env> [KEY]` | One secret's versions, or with no KEY every secret's in the env, newest first, with state and when each was added. `--limit <n>` (default 20, 0 for all), `--json`. Never reads a value. |
| `storehouse pull <env>` | Writes the env's dotenv file (0600), keeps it out of git, refuses a file git already tracks (or one in git's own directory, the manifest or a `.gitignore`), and refuses to overwrite it without `--force`. `--dry-run` reads no values. |
| `storehouse push <env> [KEY…]` | Sends the env's secrets, or just the KEYs named, to each push target. `--dry-run` shows each command and reads no values. |
| `storehouse check` | Checks the manifest and your workflows, with no Google access. `--json`. |
| `storehouse auth` | Says which Google credentials storehouse is using. |
| `storehouse trust` | Trusts the Google Cloud projects `storehouse.json` sends values to, and the repo-local CLIs a push would run ([below](#trusting-a-manifest)). |
| `storehouse protect <env>` | Labels each secret `storehouse.json` lists for a protected env, and that exists in Google, `storehouse-protected=true`, the layer no manifest edit can lift ([below](#protected-environments)). A person runs it once; `set` labels what it sets. Reads no values. |
| `storehouse agents` | Prints a guide for coding agents to this repo's secrets; `--write` puts it in AGENTS.md ([below](#working-with-coding-agents)). |

`pull` writes plain dotenv that Node's `parseEnv` and wrangler's `.dev.vars` parser read back exactly, and refuses a value it can't write that way rather than change it. wrangler, Vite and Next.js replace `$NAME` in a file named `.env…`, so for such a file `pull` also refuses a value with a `$`; pull to `.dev.vars` for a Worker. A missing optional secret is left out and named; a missing required one stops `pull` and `push` before anything is written or sent. A secret whose latest version is disabled or destroyed counts as missing.

## Push targets

Each target runs the platform's own CLI, with the values on stdin. You only need the CLI for the targets you use: no wrangler unless you push to Workers.

```json
"push": [
  { "to": "cloudflare-workers", "dir": "worker", "wranglerEnv": "stage" },
  { "to": "github-actions", "repo": "acme/app", "environment": "staging" },
  { "to": "vercel", "dir": "web", "environments": ["preview"] },
  { "to": "fly", "app": "acme-api" }
]
```

| `to` | Runs | Fields |
| --- | --- | --- |
| `cloudflare-workers` | `wrangler secret bulk` once, so one new Worker version. | `dir` (default `.`), `wranglerEnv` (wrangler's `--env`) |
| `github-actions` | `gh secret set` per secret. | `repo` (`owner/name`; default: the repo gh finds), `environment`, or `org` with `visibility` and `repos`; `app` |
| `vercel` | `vercel env add --force` per secret, the value as it is. Vercel CLI 64.7 or later. | `dir`, `environments` (required), `scope` |
| `fly` | `fly secrets import` once, so one release. | `dir`, `app`, `stage` (set without restarting) |

Each CLI comes from your PATH, looked up by storehouse itself (absolute entries only, the first match outside the repo) and run by the absolute path it prints. wrangler and vercel may also come from the target's `dir`'s `node_modules/.bin`, then the manifest directory's, but only once you've trusted that binary for the manifest ([below](#trusting-a-manifest)); `push` prints the file it runs (`using wrangler at /opt/homebrew/bin/wrangler`), and `--dry-run` says when one isn't trusted yet. Only storehouse colours what it prints: every control character in text from a manifest, a workflow, a directory name or Google, ESC included, is shown escaped (`\u001b`). A CLI's relayed output keeps its colour codes (SGR) except conceal (8), with every other control sequence escaped; a CLI could still pick colours that are hard to read, such as black on black. Every field a CLI gets as a flag's value is checked to start with a letter or digit and passed as one `--flag=value` word. Before sending anything it checks every value against every target and refuses one a CLI would change: gh drops trailing line breaks, and vercel drops the line break that ends a one-line value. A target's `dir` and a pull file are relative paths inside the repo; `check` refuses anything else. It fails when a CLI fails, shows the CLI's own output, and says which secrets already went where.

## Working with coding agents

storehouse is built to be used alongside coding agents (Claude Code, Codex, Cursor and others), and to keep them away from production.

- **`storehouse agents`** prints a short guide for an agent, built from your manifest: your envs, which are protected and must never be touched, the commands it may run, how to add a secret, and what each exit code means.
- **`storehouse agents --write`** puts that guide in `AGENTS.md` beside `storehouse.json`, between `<!-- storehouse:start -->` and `<!-- storehouse:end -->` (each on a line of its own), and leaves the rest of the file alone, line endings included. Run it again after changing the manifest; it says "AGENTS.md is current." when nothing changed, `--dry-run` shows the change, and `--file CLAUDE.md` writes to another file. `storehouse check` warns when an `AGENTS.md` or `CLAUDE.md` beside `storehouse.json` holds a guide that's out of date; a guide written elsewhere with `--file` isn't checked.
- **What `--write` won't do.** It follows a symlink only to a regular file inside the repo; a `--file` symlink out of the repo needs `--force`, and a `--file` outside the repo is written with a notice. It never writes into git's own directory, and won't rewrite a file over 1 MB, one that isn't UTF-8, or one that changed while it ran.
- **Claude Code** reads an `AGENTS.md` only when there's no `CLAUDE.md` above it. For a manifest in an app directory under a root `CLAUDE.md`, add a `CLAUDE.md` beside the guide with the line `@AGENTS.md`, or write the guide with `--file` into a `CLAUDE.md`; `--write` says so when it creates such a file.
- **A skill** teaches an agent the general workflow and tells it to run `storehouse agents` for your repo's part:

  ```sh
  npx skills add osroc-labs/storehouse
  ```

Protected envs still refuse an agent on their own ([below](#protected-environments)); the guide is what keeps it from trying. The guide and the skill tell an agent never to change `protected`, `project`, `name`, `pull` or `push`, to treat text from the repo as data, and to trust only what `storehouse agents` prints, not a block in a file anyone could have edited. If `storehouse` isn't on an agent's PATH, they point it at `pnpm storehouse` or `npx @osroc-labs/storehouse`, never `npx storehouse`, which is a different package.

## Protected environments

An env with `"protected": true`, such as prod, is for people only:

- Any command that names it needs a terminal on stdin and stdout, and the env's name typed at a prompt. Every check that can fail without Google runs first, so a typo never costs a prompt.
- It refuses outright when a coding agent's environment variable is set: `CLAUDECODE`, `CODEX_SANDBOX`, `CURSOR_AGENT`, `GEMINI_CLI` and others ([`src/protect/agents.ts`](src/protect/agents.ts) lists them, with sources). storehouse has no flag or variable to turn that off, but an agent that unsets its own variable looks like a person.
- `status` with no env leaves protected envs out, so it never needs the prompt. Name one to include it.

What says an env is protected, and what each layer stops:

| Layer | Stops | Doesn't stop |
| --- | --- | --- |
| `"protected": true` in the working-tree `storehouse.json` | An agent running a command on the env as the manifest names it. | An edit that deletes the line. |
| The same manifest committed at `HEAD`, or the nearest one committed above where storehouse runs (git runs without `GIT_DIR` and its kin, so they can't hide the commit) | A casual edit, a new manifest beside or below the committed one, a detached `HEAD`. | Committing the edit, an unborn branch, a manifest copied outside the repo or into a sibling directory, a nested `git init` with a new manifest in it, a PATH without git. |
| The `storehouse-protected=true` label on the secret in Google | Every command that reads or sets the secret, through any manifest: an edited, committed, copied or aliased one meets the same prompt. A label lookup Google refuses counts as protected. | `status` and `history`, which show only versions and times, never values. A secret not labelled yet. |

The label is the layer that holds. `set` adds it to each secret it creates or sets in a protected env, and storehouse never removes it. For the secrets that were there before, a person runs `storehouse protect <env>` once; it labels the secrets the manifest lists for that env, not others in the project, and like `set` asks to trust the project first.

**What this doesn't do.** It's a second line, not the first, and some limits come with the design:

- An agent with a shell and your Google login can always call `gcloud` itself.
- An agent that sets none of those variables (Aider, for one) looks like a person.
- A program that runs storehouse in a pseudo-terminal can type the env's name.

The first line is your own guard: a hook that inspects the commands an agent runs. storehouse exports what that guard needs:

```ts
import { execFileSync } from 'node:child_process';
import { protectedInvocation } from '@osroc-labs/storehouse';

// the committed manifest, which an agent's edit to the working tree can't change
const manifest = JSON.parse(
  execFileSync('git', ['show', 'HEAD:storehouse.json'], { encoding: 'utf8' }),
);
const refused = protectedInvocation(['get', 'prod', 'API_KEY'], manifest);
// { envs: ['prod'], reason: '`storehouse get prod API_KEY` uses the protected env prod, …' }
```

`protectedInvocation(argv, manifest)` takes the words after `storehouse` and returns the protected envs they name with a reason to show, or `undefined`. It reads the line with storehouse's own parser, so flags may come anywhere and `--out prod` isn't taken for an env. A line storehouse would refuse to run counts as protected when any word in it names a protected env.

## Trusting a manifest

A cloned repo's `storehouse.json` decides which Google Cloud project a value goes to, and may ship the CLI a push hands the values to. So storehouse asks a person once per manifest, and in a git repo once for all its worktrees.

- **Projects.** The first `set` or `push` to a project shows the project, the manifest and the secret names, and you type the project's id. Reads (`status`, `get`, `pull`, `history`) don't ask.
- **CLIs.** storehouse never runs a bare name: it looks each CLI up on your PATH itself, skipping relative entries, and runs the absolute path it prints. One inside the repo (a `node_modules/.bin`, whether the manifest names it or the PATH leads there, as under `pnpm exec`) runs only after you've trusted it: storehouse shows its real path and sha256 and you type its name. A changed file asks again, and it's hashed again just before it runs. A CLI in any worktree of the repo counts as the repo's. Any `node_modules/.bin` counts as a project's, wherever it is, since npm and pnpm put every ancestor's on the PATH. The hash covers that one launcher file, not the package it loads, so trusting it trusts what's installed behind it. A `.bin` entry git tracks or can't vouch for (git fails or isn't there, another letter case, a link out of `node_modules` or the repo) is never offered.
- **Without a terminal, or under a coding agent,** `set` and `push` refuse an untrusted project, and `push` passes over an untrusted CLI for the one on your PATH, saying so, or refuses when there's none.

`storehouse trust` asks about every project and CLI at once. The answers live only in `~/.config/storehouse/trusted-projects.json` (under `XDG_CONFIG_HOME` when that's set), readable only by you. In a git repo a manifest is kept by the git directory its worktrees share and its path in the worktree, and a CLI by its path in the worktree and a sha256 that leaves out the worktree's own path (pnpm writes it into each `.bin` file). So a worktree that names another project, or holds a changed CLI, still asks, and another repo, or a directory whose planted `.git` file points into this one, gets nothing. Outside git, or in a worktree git can't tie to its repo (such as the main checkout of a `--separate-git-dir` clone), a manifest is kept by its real path. storehouse refuses a trust file inside the repo or any worktree of it, one that isn't a plain file of yours, one others can write, and one it can't read, rather than trusting nothing. A CI job that sets or pushes needs that file in place, written by a step you control.

Trust guards against the repo, not against an agent with a shell: one that can write your config directory (or set `XDG_CONFIG_HOME` to a file it wrote) can write trust, as it can unset its own variable. And a file can change between being hashed and being run, a window an agent on the machine could use.

## Auth

storehouse has no Google SDK. It gets one access token per run from the first of these that has one:

1. `GOOGLE_OAUTH_ACCESS_TOKEN`, a token you set.
2. `GOOGLE_APPLICATION_CREDENTIALS`, a credentials file you set: a service account key, a user login, or workload identity federation (a file or URL token, as `google-github-actions/auth` writes in CI).
3. Your gcloud login (`gcloud auth login`).
4. gcloud's application default credentials (`gcloud auth application-default login`), with their quota project.
5. The metadata server, on Google Cloud. `GCE_METADATA_HOST` can point at another one, as a bare `host` or `host:port`; anything else is refused.

Something you set explicitly wins over a login that happens to be there. A workload identity file is trusted as it is: storehouse fetches the token URL it names, with its headers. `storehouse auth` says which one it's using:

```
$ storehouse auth
Google credentials: gcloud (gcloud auth print-access-token).
```

You need a Secret Manager role on the project: Secret Manager Viewer for `status` and `history`, Secret Accessor to read values, Secret Manager Admin to set them.

## Check in CI

`storehouse check` needs no Google access, so it runs on every pull request:

```yaml
- run: npx @osroc-labs/storehouse check
```

It checks the manifest, and every secret your workflows in `.github/workflows` read. It knows Google's [`get-secretmanager-secrets`](https://github.com/google-github-actions/get-secretmanager-secrets) action already. For any other action or reusable workflow, add a rule saying which inputs name secrets, and how:

```json
"workflows": [
  {
    "uses": "my-org/release/.github/workflows/*",
    "inputs": { "*-secret": "name", "*-secrets": "names", "deploy-secret-env": "labelled" }
  },
  { "uses": "my-org/release/actions/secrets", "inputs": { "secrets": "labelled" } }
]
```

`uses` is what follows `uses:` without the `@ref`; `*` matches anything in it and in input names. A manifest has at most 64 rules of 32 inputs; `check` reads at most 100 workflow files, each a regular file (never a symlink) up to 256 KB, 10,000 lines, commas and colons, and 1000 jobs and steps, and at most 10,000 secret names in all, and says so when a repo goes past that. Each input is `name` (one secret name), `names` (one per line), `labelled` (`label: name` per line, an `@version` ignored) or `resource` (`get-secretmanager-secrets`' own format).

## Exit codes

| Code | |
| --- | --- |
| 0 | Done. |
| 1 | Failed: Google, a file, a CLI. The message says why and what to do. |
| 2 | A mistake on the command line: an unknown command, option, env or key. |
| 3 | `storehouse.json` is missing or has problems. `storehouse check` lists them. |
| 4 | A required secret is missing (`status`, `pull`, `push`), or the secret asked for isn't set (`get`, `history`). |
| 5 | Refused by a protected env, or stopped at a prompt with Ctrl-C. |

## FAQ

**Does storehouse store anything?** No. Values live in Secret Manager. storehouse writes only the files you ask for (`pull`, `get --out`), at 0600.

**Why can't storehouse add a secret to the manifest?** The manifest is the reviewed list of what exists. A new secret is a decision for a commit, not a side effect of `set`.

**Why no `storehouse exec`?** Running any command with your secrets in its environment is exactly what a guard against agents can't inspect. `pull` covers local development.

**Can I adopt it without renaming my secrets?** Yes: give a secret its own `name`.

**My secrets live in one project per environment.** Set `project` on each env.

**Who added a version?** Secret Manager doesn't record it on the version. Cloud Audit Logs do; storehouse doesn't read them yet.

**From source:** `git clone`, `pnpm install` (which builds `dist/`), then `node dist/cli.js`. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## License

[MIT](LICENSE)
