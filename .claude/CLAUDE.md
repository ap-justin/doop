<!-- kru v0.174.0 · derived 2026-11-06 · `skills/setup/SKILL.md` to re-derive -->

Load **`skills/lead/SKILL.md`** before building, reviewing, or dispatching a seat — it carries how the
team works.

- **data** → `kru:postgres-architect` — drizzle-orm ^0.45, `server/db`, migrations in `server/db/migrations`
- **ui** → `kru:react-ui-builder` — React 18 + Tailwind 4 in `src`; tokens in `.context/DESIGN.md`
- **node** → `kru:node-developer` — Express server, scripts and workers in `server`, `shared`, `scripts`
- **skills** → `kru:drizzle`, `vitest`, `tailwind`, `zod`, `typescript` — drizzle-orm, vitest ^5, tailwindcss ^4, zod ^3, `package.json`
- **test** — `bun run test` (vitest); browser tests share one Chromium (`.context/TECHSTACK.md` §7)
- **verify** — `bun run typecheck`, `bun run lint`, `bun run format:check` (`package.json` scripts)

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.
