# Vision

storehouse is a command-line tool for teams whose secrets live in Google Secret Manager. A manifest in the repo says which secrets an app has in each environment and where each one goes; one short command does each thing a person does with a secret.

## Who it's for

Developers on a small team that already uses Google Cloud, who set, pull and push secrets by hand today with `gcloud secrets` and a wiki page. They reach for storehouse when a secret changes, when a new person needs a local `.env`, and before a deploy.

## Principles

- **Secret Manager stays the source of truth.** storehouse never keeps its own copy. _Why:_ a second store drifts, and the team already trusts Secret Manager's access control and audit logs.
- **The manifest is reviewed, never written by the tool.** _Why:_ the list of what exists is a decision people make in a commit.
- **A value never touches argv, a log or the repo.** _Why:_ argv is visible to every process on the machine, and logs live forever.
- **Production is for people.** A protected env refuses agents and needs a terminal and its name typed. _Why:_ an agent with a shell shouldn't be one command away from production.
- **Every failure names its fix.** _Why:_ a secrets tool is used rarely, under pressure, by someone who forgot how it works.
