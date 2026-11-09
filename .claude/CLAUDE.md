<!-- kru v0.174.0 · derived 2026-11-06 · `skills/setup/SKILL.md` to re-derive -->

Load **`skills/lead/SKILL.md`** before building, reviewing, or dispatching a seat — it carries how the
team works.

- **data** → `kru:postgres-architect` — drizzle-orm ^0.45, `server/db`, migrations in `server/db/migrations`
- **ui** → `kru:react-ui-builder` — React 18 + Tailwind 4 in `src`; tokens in `.context/DESIGN.md`
- **node** → `kru:node-developer` — Express server, scripts and workers in `server`, `shared`, `scripts`
- **deploy** → `kru:fly-platform-engineer` — `Dockerfile.fly` (the Fly image; `fitsTarget()` in `scripts/bundle-server.mjs` assumes its build and runtime stages, `oven/bun:1` and `node:22-slim`, are both Debian glibc on one arch; flyctl otherwise builds the self-host `Dockerfile`, so a deploy passes `--dockerfile Dockerfile.fly`, which a `[build]` section in the app's out-of-repo `fly.toml` overrides), upstream's self-host `Dockerfile`, and the root `.dockerignore` for both
- **skills** → `kru:drizzle`, `vitest`, `tailwind`, `zod`, `typescript` — drizzle-orm, vitest ^5, tailwindcss ^4, zod ^3, `package.json`
- **test** — `bun run test` (vitest); browser tests share one Chromium (`.context/TECHSTACK.md` §7)
- **verify** — `bun run typecheck`, `bun run lint`, `bun run format:check` (`package.json` scripts)

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.
