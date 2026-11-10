# storehouse

**Status:** the first release is built: the manifest, every command below, four push targets, protected environments and auth without the SDK. [Later](#later) lists what comes after. Where building it changed the design, this spec says so.

## What it is

A command-line tool for Google Secret Manager. Each repo commits a manifest, `storehouse.json`, that says which secrets the app has in each environment, what each is for and where it's sent. The values never touch the repo. One short command does each thing a person does with a secret, and `storehouse status` shows the whole picture at a glance.

It's for anyone whose secrets live in Secret Manager. Published as `@osroc-labs/storehouse`, with the command `storehouse`.

### Why not something that exists

| Tool | Why not |
| --- | --- |
| fnox, secretspec, varlock | A config in the repo plus a GCP provider, but GCP is one backend among many. fnox writes to its committed config on every `set` to a profile, and its `exec` and profile flags give an agent many ways to reach production. |
| Doppler, Infisical, 1Password | They replace Secret Manager instead of working with it. |
| `gcloud secrets` | Every command needs the full secret name, the project and `--data-file=-`, there's no picture of what's set where, and it pushes nowhere. |

What storehouse adds: a status table across environments, a manifest it never rewrites, pushes to where secrets run, a CI check that workflows name only secrets that exist, and protected environments that an agent can't use.

## The manifest

`storehouse.json`, found from the current directory upward, with a JSON Schema so editors complete and check it:

```json
{
  "$schema": "https://cdn.jsdelivr.net/npm/@osroc-labs/storehouse/schema.json",
  "project": "myapp-prod-123",
  "name": "myapp-{env}-{key}",
  "envs": {
    "dev": { "pull": { "file": "worker/.dev.vars" } },
    "stage": { "push": [{ "to": "cloudflare-workers", "dir": "worker", "wranglerEnv": "stage" }] },
    "prod": {
      "protected": true,
      "push": [{ "to": "cloudflare-workers", "dir": "worker", "wranglerEnv": "prod" }]
    }
  },
  "secrets": {
    "AUTH_SECRET": { "purpose": "Signs session cookies. Different per environment.", "required": true },
    "SMS_ACCOUNT_SID": { "purpose": "The SMS account that texts sign-in codes." },
    "SEED_TOKEN": { "purpose": "A sandbox token, for the seed script.", "envs": ["dev"], "pull": false }
  }
}
```

- **`name`** turns an env and a key into the secret's name in Secret Manager, with `{env}` and `{key}`. A secret can set its own `name` instead, so a repo adopts storehouse without renaming anything. `check` refuses a pattern that makes the same name twice in one project.
- **`project`** is per app, and an env can override it for apps that keep each environment in its own project. Either may be left out as long as every env ends up with one.
- **An env** name is lowercase letters, digits, `-` and `_` (it becomes a label). It has `protected`, a `pull` file and `push` targets.
- **A secret** is keyed by an environment variable name. It has a `purpose` (required, shown in `status`), `required` (default false), `envs` (default all), `pull` and `push` (default true) and its own `name`. The schema is strict, so it refuses a field it doesn't know, such as `file` or `readers` from [Later](#later), rather than ignoring it.
- **`workflows`** describes GitHub Actions that name Secret Manager secrets, for `check` ([below](#check-and-workflows)).
- **The schema** (`schema.json` in the package) is generated from the Zod schema the CLI checks with. `$schema` points at jsDelivr's copy of the latest published package; `./node_modules/@osroc-labs/storehouse/schema.json` is the same file, pinned to the installed version.
- **storehouse never writes to the manifest.** A new secret is added to it by hand, in a commit. `set` refuses a key the manifest doesn't list and says what to add.
- **A repo may hold several manifests,** one per app directory. Every command uses the nearest one upward, and every path in a manifest is relative to the manifest's own directory.

## Commands

The environment is always the first word after the command, and a key is always a manifest key, never a Secret Manager name.

| Command | What it does |
| --- | --- |
| `storehouse status [env…]` | One row per secret, one column per environment: set (with when it last changed), missing, missing and required, no access, or not used there. With no env it shows every env but the protected ones, and says how to include them. One secret Google won't show doesn't hide the rest. `--json`. Never reads a value. |
| `storehouse set <env> <KEY>` | Reads the value from a hidden prompt, or stdin when piped, and drops one trailing newline. At the prompt, Enter ends the value and a multi-line paste is kept whole (bracketed paste); one the terminal doesn't mark is refused rather than cut at its first line. Creates the secret with labels `storehouse=true`, `env=<env>` when it's new, adds a version only when the value changed, and prints the name, never the value. |
| `storehouse get <env> <KEY>` | Prints the latest value with no added newline, or writes it with `--out <path>`: created at 0600, and an existing file replaced only with `--force`, by renaming a new 0600 file over it. |
| `storehouse history <env> [KEY]` | Versions, their state and when each was added (`Nov 2 22:38  7d ago`, with the year when it isn't this one), never the values. Without a KEY, every secret's versions in the env in one list, newest first, with a secret that doesn't exist there listed once as missing. The newest 20 rows unless `--limit <n>` (0 for all). `--json`. Not by whom: a version doesn't record it; only Cloud Audit Logs do. |
| `storehouse pull <env>` | Writes the env's `pull` file (dotenv, 0600), or `.env.<env>` beside `storehouse.json` when the env has none. It makes sure git ignores the file, adding its path from the repo root to the root `.gitignore` when it isn't, and skips that outside a repo. It refuses a file git tracks (`git ls-files --error-unmatch`), which no ignore rule covers. A pull file and a push `dir` must be relative paths inside the repo (the manifest's directory outside one); `check` and every command refuse anything else, so a manifest edit can't point `pull --force` at a file elsewhere on disk. Refuses to overwrite a file without `--force`, and refuses a value it can't write losslessly: one Node's `parseEnv` and wrangler's `.dev.vars` parser (dotenv) wouldn't read back exactly, and for a file named `.env…` one with a `$`, which wrangler and other tools expand there. `--dry-run` reads no values. |
| `storehouse push <env> [KEY…]` | Sends the env's secrets to each of its push targets. A missing optional secret is skipped and named; a missing required one, or a KEY named on the command line, stops the push before anything is sent. `--dry-run` shows each command it would run, and reads no values. |
| `storehouse check` | Checks the manifest with no Google access, so it runs in CI. |
| `storehouse auth` | Says which Google credentials storehouse uses, and never prints the token. |
| `storehouse trust` | A manifest decides which project a value goes to and may ship the CLI a push runs, so the first `set` or `push` to a project asks the person to confirm it (the project, the manifest and the secret names), and the first push through a repo-local CLI asks too (its real path and sha256). The answers are kept per manifest in `$XDG_CONFIG_HOME/storehouse/trusted-projects.json` (0600). A trust file inside the repo, not a plain file of the person's, writable by others, or unreadable is an error, never "trusts nothing". Without a terminal or under an agent, an untrusted project is refused and an untrusted CLI is passed over for the PATH's, or refused when there's none. Reads don't ask. |
| `storehouse protect <env>` | Labels each secret the manifest lists for a protected env, and that exists in Google, `storehouse-protected=true`. Person-only, like any command on a protected env, and it asks to trust the project like `set`; it never removes a label and reads no values. |
| `storehouse agents` | Prints a Markdown guide for coding agents, built from the manifest: the envs, which are protected and off limits, what an agent may run, how to add a secret, the exit codes. `--write` puts it in AGENTS.md beside the manifest (or `--file`) between `<!-- storehouse:start -->` and `<!-- storehouse:end -->`, idempotently, in the file's own line endings, counting a marker only on a line of its own. It follows a symlink only to a regular file in the repo (a `--file` link out of it needs `--force`), and refuses a file over 1 MB, one that isn't UTF-8, or one that changes while it runs; it writes a temp file and renames it over the old one. `check` warns, without changing its exit code, when an AGENTS.md or CLAUDE.md beside the manifest holds a stale or unreadable guide. When it creates an AGENTS.md under a CLAUDE.md, it says Claude Code won't read it. The repo also ships a skill (`skills/storehouse`, `npx skills add osroc-labs/storehouse`) that teaches the general workflow and defers to `storehouse agents`. |

`pull` and `push` send text: each value must be UTF-8, and one trailing newline is dropped from it, as `set` drops one on the way in. `get` gives the bytes as stored.

Every command takes `--help`. An unknown option is named in storehouse's words (`Unknown option --all for storehouse history.`) with that command's usage. Every check that can fail without Google (the manifest, the arguments, the keys, a file that already exists) runs before a protected env's prompt. The exit codes are fixed, and listed in the README: 0 done, 1 failed, 2 a mistake on the command line, 3 a manifest problem, 4 a required secret missing (or the one asked for isn't set), 5 refused by a protected env or stopped at a prompt.

There's no `exec` (run a command with secrets in its environment). It would hand any command to the tool, so a repo's guard would have to inspect every command it wraps. `pull` covers local development.

### Push targets

Each target runs the platform's own CLI with the values on stdin, never in an argument. storehouse only needs the CLI for the targets a manifest uses: someone who never pushes to Workers never needs wrangler. It never spawns a bare name: it walks the PATH itself (absolute entries only), runs the first match outside the repo by its absolute real path, and prints that path; a match inside the repo or in any `node_modules/.bin`, as under `pnpm exec`, counts as repo-local. It uses the CLI on the PATH, or for wrangler and vercel an installed one from the target's `dir`'s `node_modules/.bin`, then the manifest directory's, once a person has trusted that binary's real path and sha256 for the manifest, and prints which. As a second line, an entry is never offered unless it's named exactly so in a `node_modules/.bin`, its real path is inside `node_modules` under the manifest's directory, and git, asked from the repo root and ignoring case, is sure it tracks neither; a git error or no git counts as tracked. `--dry-run` quotes any word a shell would split. A CLI's output is relayed with its SGR colour codes kept, except conceal (8, read as a number), and every other control sequence escaped. storehouse's own colours travel as markers with a per-run nonce, so text from a manifest, a workflow, a directory name or Google can never colour: every control character in it, ESC included, is escaped. The sha256 pins the launcher file only, and it's hashed again just before the run; trust guards against a repo, not an agent that can write the person's config directory. A field a CLI gets as a flag's value must start with a letter or digit, in its real shape (an `owner/name` repo, a label for wrangler's env), and goes as one `--flag=value` word. Before anything is sent, every value is checked against every target, so a value one CLI would change stops the whole push.

| `to` | Runs | Fields |
| --- | --- | --- |
| `cloudflare-workers` | One `wrangler secret bulk`, the values as JSON, so one new Worker version. It fails unless wrangler exits 0 and prints `Finished processing secrets file`, because wrangler 4 exits 0 when it couldn't read its input. The JSON escapes U+2028 and U+2029, which wrangler's line-by-line read would split on. | `dir`, `wranglerEnv` |
| `github-actions` | One `gh secret set` per secret. gh trims a value's trailing line breaks, so such a value is refused. | `repo`, `environment`, `org`, `visibility`, `repos`, `app` |
| `vercel` | One `vercel env add --force --yes` per secret (Vercel CLI 64.7 or later), the value as it is. vercel drops the line break that ends a one-line value read from stdin and leaves anything else alone, so a value that is one line plus its line break is refused. | `dir`, `environments`, `scope` |
| `fly` | One `fly secrets import`, each value triple-quoted, so one release. A value flyctl's parser wouldn't read back exactly (a carriage return, a line over 60,000 characters, a line ending in `"""`, a `#` after an odd number of quotes) is refused. | `dir`, `app`, `stage` |

### Check and workflows

`check` reads the manifest and the repo's `.github/workflows/*.yml` (at the git repo root, above a nested manifest), with no Google access:

- the schema, and that the names it makes are valid and unique per project;
- that each push `dir` and pull file's directory exists;
- that every secret a workflow names is in the manifest.

It knows Google's `google-github-actions/get-secretmanager-secrets`: its `secrets` input, `output:project/secret[/version]` or a full resource name, per line or comma. A secret in a project the manifest doesn't use isn't its to have, and is skipped. Any other action or reusable workflow is a rule in `workflows`: `uses` (with `*` for anything) and which `with:` inputs name secrets, each as `name` (one secret name), `names` (one per line), `labelled` (`label: name` per line, any `@version` ignored) or `resource` (Google's format). An input set by an expression (`${{ … }}`) can't be read until the workflow runs, so it's skipped. So a hostile repo can't hold `check` for long, a manifest has at most 64 rules of 32 inputs each, and `check` reads at most 100 workflow files, each a regular file read through a descriptor up to 256 KB (a symlink is never followed), with at most 10,000 lines, commas and colons (counted in one pass before the parse) and 1000 jobs and steps, at most 40,000 of those counted in all and 10,000 secret names in all, and makes at most 200,000 glob matches; a workflow's job ids and file names are shown escaped; past any of these it reports a problem instead.

## Protected environments

An env with `"protected": true` (prod) is for people only:

- Every command that names it needs a terminal on both ends and the env's name typed at a prompt. `status` with no env leaves it out instead of asking.
- Three layers say an env is protected, and only the last holds against a determined edit. The working-tree manifest stops an agent using the env as named. Its copy committed at `HEAD`, or the nearest manifest committed above the working directory (`git show HEAD:<path>`, run without `GIT_DIR` and the other `GIT_*` variables; a git error counts as no committed copy), stops a casual edit, but not a committed edit, an unborn branch, a copy outside the repo or a sibling directory, a nested `git init`, or a PATH without git. The `storehouse-protected=true` label on the secret applies the rules to any command that reads or sets it, through any manifest; a refused label lookup counts as protected. `set` adds the label to what it sets in a protected env, `storehouse protect <env>` adds it to every existing secret, and nothing removes it. `status` and `history` read only metadata and don't check the label.
- A pull file, a push `dir`, `get --out` without `--force` and the agents guide never land in git's own directory: any `.git` part in any letter case, or inside `git rev-parse --absolute-git-dir` or `--git-common-dir`. A pull file can't be the manifest or a `.gitignore` either.
- It refuses outright when a coding agent's environment variable is set (`CLAUDECODE`, and the ones Codex, Cursor, Gemini CLI and others set; `src/protect/agents.ts` lists them with sources), and storehouse has no flag or variable to turn that off (an agent that unsets its own variable looks like a person). Variables a person's own terminal also sets, such as Cursor's `CURSOR_TRACE_ID`, don't count. Aider sets none, so it isn't caught.
- So `get` never prints a protected value to a pipe, and `set` never reads one from a pipe.

This is a second line, not the first. Some limits come with the design: an agent with a shell can always call `gcloud` itself; a second manifest can map the same secrets to an unprotected env (the label catches that once it's on the secret); a program can run storehouse in a pseudo-terminal and type the env's name. The first line is the repo's own guard (a hook that inspects an agent's commands). storehouse exports `protectedInvocation(argv, manifest)` for it: `argv` is the words after `storehouse`, `manifest` is storehouse.json as parsed, and it returns the protected envs the line names with a reason to show, or undefined. It reads the line with the CLI's own parser, so a flag's value (`--out prod`) isn't taken for the env, and the CLI runs the same function before every command. A line the CLI would refuse counts as protected when any word in it names a protected env. A guard can't see through shell variables (`storehouse get $ENV KEY`); the CLI's own check still can.

## Auth

No Google SDK. One token per run, from the first source that has one:

1. `GOOGLE_OAUTH_ACCESS_TOKEN`: an explicit token, never refreshed.
2. `GOOGLE_APPLICATION_CREDENTIALS`: an explicit file: a service account key (a JWT signed with `node:crypto`, exchanged at Google's token endpoint), an authorized user (its refresh token) or an external account (workload identity federation from a file or URL token, through STS and optional service account impersonation).
3. gcloud's login: `gcloud auth print-access-token`.
4. gcloud's application default credentials file (`gcloud auth application-default login`), with its quota project sent as `x-goog-user-project`.
5. The metadata server on Google Cloud, asked with a one-second timeout.

Explicit beats ambient: a variable someone set wins over a login that happens to be there. A token is found again a minute before it expires, and once after Google refuses one (a 401), so a long run survives an expiry. `storehouse auth` says which source won. External accounts that run a program or read AWS credentials aren't read yet; a workload identity file's token URL is fetched as it is. `GCE_METADATA_HOST` must be a bare `host[:port]`.

Secret Manager is called over REST with `fetch`, eight requests at a time. A read is retried twice on a 429, a 5xx, a timeout or a dropped connection, waiting as long as `Retry-After` says (up to 30 seconds) or backing off. A write is never retried, so it can't add a second version. Every failure names its fix.

## How it's built

- **TypeScript, published as JavaScript,** for macOS and Linux. Node 24, pnpm, oxlint, oxfmt, knip, `node --test`. Node won't strip types from a package in `node_modules`, so the package ships built `dist/`.
- **Few dependencies:** Zod for the manifest, `yaml` for reading workflows, date-fns for the times a person reads.
- **Tests run against a fake Secret Manager** in the test process, with injected faults, and fake CLIs that record their argv. Every test run checks that no secret value reached stdout, stderr or a CLI's argv or env. Property tests cover the dotenv writer, the protected-env guard against the CLI's parser, and the paste reader. `pnpm test:live` runs against a real project with throwaway secrets.

## Later

- **File secrets and readers.** `set --file` for a file kept byte for byte (a signing certificate, a provisioning profile), and `readers`: the service accounts that should read a secret, compared with its IAM policy by `status --readers`.
- **Every manifest in a repo at once.** `check` and `status` across all of a repo's manifests, for a repo with an app per directory.
- **Kubernetes.** Where the External Secrets Operator or the Secret Manager CSI driver already reads Secret Manager into a cluster, there's nothing to push. storehouse's part there is the manifest, `status` and `readers`: what should exist, what does, and who can read it.
- **`init`**: a first manifest from a project's existing secrets, guessing the `name` pattern.
- **Who added a version,** from Cloud Audit Logs.
