# AGENTS.md

This overrides earlier package-manager guidance.

- Use `pnpm` for dependency installation and scripts in this repo.
- Use `pnpx` when a one-off package runner is needed.
- Do not use `bun`, `bunx`, `npm`, or `npx` here unless the USER explicitly asks.
- Prefer updating `pnpm-lock.yaml` and removing `bun.lock` if both appear.
