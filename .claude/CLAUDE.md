<!-- kru v0.242.0 · derived 2026-11-21 · `skills/setup/SKILL.md` to re-derive -->

Load **`skills/lead/SKILL.md`** before building, reviewing, or dispatching a seat — it carries how the
team works.

- **data** → `kru:postgres-architect` — drizzle-orm ^0.45, `server/db`, migrations in `server/db/migrations`
- **ui** → `kru:react-ui-builder` — React 18 + Tailwind 4 in `src`; tokens in `.context/DESIGN.md`
- **node** → `kru:node-developer` — scripts in `scripts`
- **auth** → `kru:better-auth-specialist` — better-auth 1.6.26; `server/auth.ts`, `server/db/auth-schema.ts`, the client in `src/lib/auth.ts`
- **billing** → `kru:stripe-specialist` — stripe 21.0.1; `server/billing.ts`, `server/entitlements.ts`, `shared/billing.ts`
- **tooling** → `kru:toolchain-engineer` — `.oxlintrc.json`, `eslint.config.js`, `.prettierrc.json`, `.husky`, lint-staged in `package.json`, `commitlint.config.js`
- **uncovered** — the Express 4 server in `server` (`express` in `package.json`), the Gemini cloud worker among it (`server/geminiCloudWorker.ts`, its own Express app), and the `shared` code it shares with `src`: no seat builds on Express
- **deploy** → `kru:fly-platform-engineer` — `Dockerfile.fly` (the Fly image; `fitsTarget()` in `scripts/bundle-server.mjs` copies only packages built for the build stage's OS, CPU and glibc, so both its `FROM`s stay Debian glibc on one arch, and only its build-time `node server.mjs` run catches a mismatch, in a statically imported package; flyctl otherwise builds the self-host `Dockerfile`, so a deploy passes `--dockerfile Dockerfile.fly`, which `[build] dockerfile` in the app's out-of-repo `fly.toml` overrides), upstream's self-host `Dockerfile`, `workers/gemini` (the Gemini worker's image), and the root `.dockerignore` for all of them
- **skills** → `kru:drizzle`, `vitest`, `tailwind`, `zod`, `typescript`, `shadcn`, `api-design`, `tigris` — drizzle-orm, vitest ^5, tailwindcss ^4, zod ^3, `package.json`; `shadcn` for `components.json`; `api-design` for the agent keys `server/agentKeys.ts` mints and the webhooks `server/webhooks.ts` sends; `tigris` for the seat writing upload storage code (`server/storage.ts` on `@aws-sdk/client-s3`): the live uploads sit in a Tigris bucket on the Fly app, and `BUCKET`, `ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` and `REGION` are set by hand as app secrets, not the `fly storage create` defaults; `deploy` carries `tigris` too
- **test** — `bun run test` (vitest); browser tests share one Chromium (`.context/TECHSTACK.md` §7)
- **verify** — `bun run typecheck`, `bun run lint`, `bun run format:check` (`package.json` scripts)

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.
