# How we work

## Docs

- **A rule lives in one doc.** AGENTS.md links to it and never restates it. _Why:_ a rule written twice disagrees with itself within weeks.
- **Read only the doc for what you're doing.** AGENTS.md says which.
- **The real system beats the doc.** Check it, then fix the doc in the same change.
- **A doc describes behaviour, not module names.** _Why:_ a doc that names a module becomes its spec, and the module can never go.

## Decisions

- **A choice that differs from a skill is a dated line in [plan.md § Decisions](plan.md#decisions),** with its reason.

## Pull requests

- **The title says what it does,** briefly. Stacked PRs start with their place: `[1/2]`.
- **The body is what was asked and how the code solves it,** then "Decisions I made". Not a list of every change.
- **`pnpm check` is green before review,** on Linux and macOS.

## Commits

- **Lowercase, about four words, almost never a body.**

## Memory

- **What an agent learns that isn't a rule yet goes in `.claude/memory/`,** one fact per file, indexed in its MEMORY.md. When it becomes a rule, it moves to its doc.
