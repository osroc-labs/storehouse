# Security

## Reporting a problem

Please report a security problem privately, through a [GitHub Security Advisory](https://github.com/osroc-labs/storehouse/security/advisories/new). Don't open a public issue. You'll get an answer within a week, and credit in the advisory if you'd like it.

Never include a real secret's value, an access token or a key file in a report. A secret's name and the command you ran are enough.

## In scope

- A secret value reaching anywhere it shouldn't: argv, a log line, an error message, a file with a wider mode than 0600, a file git doesn't ignore.
- A way past a protected env's rules: running a command against it under a detected agent, without a terminal, or without typing its name.
- `protectedInvocation` reading a command line differently from the CLI.
- A value written or pushed changed (`pull`, `push`), where storehouse said it was sent as is.
- Credentials handled unsafely: a token or key logged, sent anywhere but Google, or kept after the run.

## Out of scope

- What someone with a shell and Google access can do without storehouse. An agent can always call `gcloud` itself; protected envs are a second line, not the first.
- Agents that set no environment variable storehouse can detect (Aider, for one).
- Problems in the CLIs storehouse runs (wrangler, gh, vercel, fly), or in Secret Manager.
