import type { CommandOption } from './options.ts';

// Where a command takes its env: the first word after it, every word after it, or nowhere.
export const EnvPosition = {
  first: 'first',
  all: 'all',
  none: 'none',
} as const;
export type EnvPosition = (typeof EnvPosition)[keyof typeof EnvPosition];

type CommandSpec = {
  args: string;
  min: number;
  max: number;
  envs: EnvPosition;
  options: readonly CommandOption[];
  summary: string;
  details: string;
};

export const commands = {
  status: {
    args: '[env…]',
    min: 0,
    max: Infinity,
    envs: EnvPosition.all,
    options: ['json'],
    summary: 'Show which secrets are set in each env, and when they changed.',
    details: `One row per secret and one column per env: set (with when it last changed), missing, MISSING (required) or a dash where the secret isn't used. It reads no values.

With no env it shows every env except protected ones; name a protected env to include it.`,
  },
  set: {
    args: '<env> <KEY>',
    min: 2,
    max: 2,
    envs: EnvPosition.first,
    options: [],
    summary: 'Store a value for a secret.',
    details: `Reads the value from a hidden prompt, or from stdin when it's piped, and drops one trailing newline. At the prompt, Enter ends the value, and a multi-line value (a PEM key, say) can be pasted whole. Creates the secret, labelled storehouse=true and env=<env>, when it's new, and adds a version only when the value changed. Prints the secret's name, never its value.

KEY must be in storehouse.json, used in <env>: add a new secret there first.`,
  },
  get: {
    args: '<env> <KEY>',
    min: 2,
    max: 2,
    envs: EnvPosition.first,
    options: ['out', 'force'],
    summary: "Print a secret's latest value.",
    details:
      'Prints the value with no newline added, or writes it to a file with --out. A protected env prints only to a terminal.',
  },
  history: {
    args: '<env> [KEY]',
    min: 1,
    max: 2,
    envs: EnvPosition.first,
    options: ['json', 'limit'],
    summary:
      'List versions and when each was added, for one secret or a whole env.',
    details: `With a KEY, that secret's versions in <env>, newest first. Without one, every secret's versions in <env> in one list, newest first, so you can see what changed lately; a secret that doesn't exist in <env> is listed once, as missing, at the end.

Shows the newest 20 versions unless --limit says otherwise. Never reads a value.`,
  },
  check: {
    args: '',
    min: 0,
    max: 0,
    envs: EnvPosition.none,
    options: ['json'],
    summary: 'Check storehouse.json, with no Google access.',
    details: `Checks the manifest against its schema, that the Secret Manager names it makes are valid and unique, that push directories exist, and that every secret a GitHub Actions workflow in .github/workflows names is in the manifest: Google's get-secretmanager-secrets action, and any other the manifest's "workflows" describes. It runs in CI.

It also warns, without changing the exit code, when an AGENTS.md or CLAUDE.md beside storehouse.json holds a storehouse guide that's out of date or can't be read.`,
  },
  trust: {
    args: '',
    min: 0,
    max: 0,
    envs: EnvPosition.none,
    options: [],
    summary:
      'Trust the Google Cloud projects and repo-local CLIs storehouse.json sends values to.',
    details: `A manifest decides which Google Cloud project a value you set or push goes to, so the first set or push to a project asks you to trust it for that manifest. This asks for every project at once. It shows each project with the envs and secrets it holds, and you type the project's id to trust it. It also asks about each CLI a push would run from the repo's own node_modules/.bin, showing its real path and sha256; push uses one only once it's trusted, and asks again when its content changes. The answers are kept only in ~/.config/storehouse/trusted-projects.json (or under XDG_CONFIG_HOME), readable only by you.`,
  },
  protect: {
    args: '<env>',
    min: 1,
    max: 1,
    envs: EnvPosition.first,
    options: [],
    summary:
      "Label a protected env's secrets so no manifest edit can lift its protection.",
    details: `Adds the storehouse-protected=true label to each secret storehouse.json lists for <env> that exists in Google, which only a protected env may do; a secret in Google that the manifest doesn't list isn't touched. Like set, it asks you to trust the manifest's project first. storehouse applies the protected rules to any secret with that label, whichever manifest names it, so an edited or copied storehouse.json can't reach it. set labels a secret it creates or sets in a protected env; run this once for the secrets that were there before.

Like any command on a protected env, it refuses a coding agent and asks a person at a terminal to type the env's name. It never removes a label, and reads no values.`,
  },
  auth: {
    args: '',
    min: 0,
    max: 0,
    envs: EnvPosition.none,
    options: ['json'],
    summary: 'Show which Google credentials storehouse uses.',
    details: `Finds a token the way every command does and says where it came from. The first source that has one wins: GOOGLE_OAUTH_ACCESS_TOKEN, then the file GOOGLE_APPLICATION_CREDENTIALS names, then gcloud's login, then gcloud's application default credentials, then the metadata server on Google Cloud. It reads no secrets and needs no storehouse.json.`,
  },
  agents: {
    args: '',
    min: 0,
    max: 0,
    envs: EnvPosition.none,
    options: ['write', 'file', 'dry-run', 'force'],
    summary: 'Print a guide for coding agents working with these secrets.',
    details: `Prints, as Markdown, what a coding agent may do with this repo's secrets: the envs and which are protected, the commands it may run, how to add a secret, and what each exit code means. It's built from storehouse.json and reads nothing from Google.

With --write it puts the guide in AGENTS.md beside storehouse.json (or --file), between <!-- storehouse:start --> and <!-- storehouse:end -->, creating the file if it's missing and leaving the rest of it alone. It does nothing when the guide there is current; --dry-run shows what it would change. It follows a symlink only to a regular file in the repo, never into git's own directory; one that leads out of the repo needs --file and --force. It won't rewrite a file over 1 MB or one that isn't UTF-8.

Claude Code reads an AGENTS.md only when no CLAUDE.md is above it, so for a manifest in an app directory under a CLAUDE.md, add a CLAUDE.md beside the guide with the line @AGENTS.md, or use --file CLAUDE.md. storehouse says so when it creates such a file.`,
  },
  pull: {
    args: '<env>',
    min: 1,
    max: 1,
    envs: EnvPosition.first,
    options: ['dry-run', 'force'],
    summary: "Write an env's secrets to its dotenv file.",
    details: `Writes envs.<env>.pull.file, or .env.<env> beside storehouse.json when the env has none (0600), with every secret used in <env>, except those with "pull": false. It makes sure git ignores the file, adding it to the repo's .gitignore if needed. Refuses to overwrite the file without --force, and refuses a value it can't write losslessly. A missing optional secret is left out and named; a missing required one stops the pull before anything is written.`,
  },
  push: {
    args: '<env> [KEY…]',
    min: 1,
    max: Infinity,
    envs: EnvPosition.first,
    options: ['dry-run'],
    summary: "Send an env's secrets to where they run.",
    details: `Sends every secret used in <env>, except those with "push": false, or only the KEYs named, to each of envs.<env>.push. A cloudflare-workers target gets one \`wrangler secret bulk\` with the values on stdin, so one new Worker version. Each CLI comes from your PATH; one in the repo's own node_modules/.bin is used only once you've trusted it (storehouse trust), and without a terminal an untrusted one is passed over for the PATH's. A missing optional secret is skipped and named; a missing required one stops the push before anything is sent.`,
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof commands;
