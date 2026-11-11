# Changelog

Each release, newest first. The version is the git tag and the npm version.

## Unreleased: 0.1.0

The first release.

- `storehouse.json`, a manifest of each app's secrets per environment, with a JSON Schema for editors.
- `status`, `set`, `get`, `history`, `check`, `pull` and `push`.
- Push targets: Cloudflare Workers, GitHub Actions, Vercel and Fly.
- `storehouse trust`: a person trusts the projects a manifest sends values to and the repo-local CLIs a push runs, once per repo, shared by its git worktrees.
- Protected envs, for people only, and `protectedInvocation` for a repo's own guard.
- `storehouse agents`, a guide for coding agents that `--write` keeps in AGENTS.md, and a skill: `npx skills add osroc-labs/storehouse`.
- Google auth from `GOOGLE_OAUTH_ACCESS_TOKEN`, gcloud or Application Default Credentials, with no Google SDK.
