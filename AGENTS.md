# myteam Agent Guide

## Identity
You are a multi-agent task runner. Spawn CLI agents (opencode, codex, claude) with session memory, real-time DAG visualization, and multi-CLI collaboration.

## Iron Laws

0. **Reference Before Implementation** — Before implementing ANY feature, first check `docs/clowder-ai-reference.md` to see how clowder-ai does it. Do not assume; verify the reference first.
1. **Runtime Sanctuary** — `../myteam-runtime` is the production-like environment. NEVER modify code directly in it. NEVER restart it without explicit `MYTEAM_RUNTIME_RESTART_OK=1`. Sync only via `pnpm runtime:sync`.
2. **Feature-Only Development** — ALL code changes happen in feature worktrees (`../myteam-{name}` on `feat/{name}` branches). Never commit directly to `main` or `runtime/main-sync`. The main repo is source-of-truth only (sync + plan + doc).
3. **PR Gate** — Changes flow: feature worktree → PR → squash merge → main → runtime/alpha sync. No exceptions.
4. **DB Isolation** — Each environment has its own SQLite (`~/.myteam/{env}/data.sqlite`). Never flush runtime DB.
5. **Port Discipline** — Port 3001/5173 belongs to runtime. Alpha uses 3011/5183. Features derive ports via `scripts/derive-ports.mjs`.
6. **Sibling Path** — Worktrees must be at `../myteam-{name}` (sibling of project), NEVER inside the project dir.

## Environment System

| Env | Path | Branch | API | Web | DB |
|-----|------|--------|------|------|-----|
| Runtime | `../myteam-runtime` | `runtime/main-sync` | 3001 | 5173 | `~/.myteam/runtime/` |
| Alpha | `../myteam-alpha` | `alpha/main-sync` | 3011 | 5183 | `~/.myteam/alpha/` |
| Feature | `../myteam-{name}` | `feat/{name}` | derived | derived | `~/.myteam/feature-{name}/` |

See `docs/environments.md` for full details.
See `docs/clowder-ai-reference.md` for clowder-ai implementation reference (check before implementing).

## CLI Spawn Rules

- opencode: `--auto`
- codex: `--sandbox danger-full-access --config approval_policy="never"` (resume: `exec resume <id>`, NO `--sandbox` flag)
- claude: `--permission-mode bypassPermissions --include-partial-messages --verbose` (resume: `--resume`)
- API must run with `tsx` (NOT `tsx watch`) in runtime — watch mode kills API when CLI agents edit source files

## Key Paths

- API: port from `MYTEAM_API_PORT` env (default 3001)
- DB: path from `MYTEAM_DB_PATH` env (auto-derived from `MYTEAM_ENV`)
- Config: `config/` dir from worktree root
- tsx binary: `node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/cli.mjs`
- vite binary: `node_modules/.pnpm/vite@5.4.21/node_modules/vite/bin/vite.js`
