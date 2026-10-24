# Mission Control

Multi-tenant mission planning with a TypeScript API, PostgreSQL and a CLI. No web UI. Directors administer and independently approve; Leads plan their own missions; Crew manage their profiles and personal consent.

## Run locally

Requires Node 22.13+ and Docker Compose. From the repository root:

```sh
npm ci
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

API: `http://127.0.0.1:3000` (`PORT` in `.env`); PostgreSQL: `127.0.0.1:55432`. `/health` reports database readiness. Compose volumes survive restarts; `docker compose stop` preserves data. Seeding requires an empty database and never resets it. To upgrade, rerun migrations and restart; migrations do not insert fixtures.

Compose provisions separate migration/runtime roles and development/test databases. Migration credentials install `btree_gist` for booking exclusion; use the unprivileged runtime credentials for the API. Alternatively, run `docker/init.sql` once as administrator on PostgreSQL 17 and adjust `.env` ports. That provisioning script is not repeatable.

All demo passwords: **`Local-mission-123!`** (local evaluation only).

| Organisation | Accounts |
| --- | --- |
| `atlas` | Directors `director`, `director2`; Lead `lead`; Crew `alex`, `sam`, `jules`, `lee` |
| `boreal` | Director `director`; Lead `lead`; Crew `alex` |

Seeds use stable IDs and dates relative to the seed day's UTC midnight. They cover every mission state, different skill catalogues, unavailable/underqualified crew, competing skills and booking conflicts. Availability spans −7 through +35 days, end exclusive. Demos age with real time; see [seed examples](WALKTHROUGH.md#seed-examples).

## Core workflow

Start in another terminal:

```sh
npm run mc -- login --org atlas --username lead
npm run mc -- missions list --search 'Supply flight' --state draft
npm run mc -- missions show --mission <id>
npm run mc -- missions match --mission <id>
```

Use the IDs and versions printed by list/show; no SQL or source knowledge is needed. Follow the [CLI walkthrough](WALKTHROUGH.md) for the complete journey and recovery examples:

| Actor | Commands / outcome |
| --- | --- |
| Director → crew owner | `members create`, `crew create`; owner uses `crew skills set` and `availability add` |
| Lead | `missions create`, `positions add`, `missions match`, `missions propose` |
| Each assigned person | `assignments list --mine`, `assignments show`, `assignments accept` (or decline/retract) |
| Lead → independent Director | `missions submit` → `missions approve` (or reject) |
| Owner or Director | Time makes the approved mission active; `missions complete` after its end, or `missions cancel` |

`npm run mc -- --help` and `<command> --help` list options. Profile commands accept `--crew me`; lists support `--limit/--offset`, and members/crew/skills/missions support `--search`.

- Every existing mission/assignment write uses the reviewed `--version`. Acceptance and approval can display/confirm interactively; scripts must supply it. On `STALE_VERSION`, review show/history before explicitly retrying.
- Proposals replace the whole roster; omitted pairs are withdrawn. `--suggested` requires a full match; manual `--pairs` may be partial. Draft edits invalidate affected consent. Declined attempts need a new proposal.
- Submission needs at least one position and a fully accepted, eligible roster. Submitted plans freeze; withdraw/reject returns to draft and resets consent. Approved changes require cancellation and replacement with fresh consent/approval.
- Completion retains bookings/workload. Cancellation is allowed until explicit completion, releases the entire booking and removes even elapsed workload. Both are final.

Passwords use hidden prompts or `--password-stdin` (one line; password change takes current/new on two lines). Never pass secrets in arguments. Sessions last 24 hours; password changes revoke all own sessions. Logout/login to switch accounts or recover from expiry. `MC_CONFIG_DIR` selects an absolute credential directory outside the repo, default `~/.config/mission-control`, with Unix directory/file modes `700`/`600`. Separate directories allow parallel users.

Use `--api` or `MC_API_URL` to select an origin; remote origins require HTTPS and saved tokens cannot cross origins or follow redirects. Logout network failures retain credentials for revocation retry. `npm run --silent mc -- --json ...` gives clean JSON on stdout, errors on stderr and nonzero failures. Destructive actions need confirmation (`--yes` for scripts). Writes never retry automatically; inspect lists/history after uncertain results, especially creates.

## Key decisions and limits

One package: `api/` validates HTTP input, `domain/` owns permissions and transactions, `db/` owns schema/migrations/fixtures, and `cli/` calls the API through one client. Hono keeps routing small; Drizzle/pg keeps queries and PostgreSQL constraints explicit. Mission modules follow workflows; there is no generic repository or workflow engine.

Tenant identity comes from sessions. Scoped queries, private response projections and composite foreign keys protect tenant/record boundaries; there is no RLS. Approval locks the mission then crew, rechecks eligibility and reserves everyone atomically; a database exclusion constraint prevents overlapping confirmed bookings. These safeguards also protect profile edits and consent history.

Matching uses augmenting paths for maximum coverage, including scarce-skill reassignment. Workload preference is confirmed hours clipped to the proposed start month in UTC, then crew UUID. It is neither a capacity cap nor globally optimal fairness. Matching reads the whole tenant pool; large-tenant performance is unverified.

Local evaluation scope: self-declared skills, trusted accounts, manual provisioning, Unix credential storage and a shared ten-attempt/minute/process authentication budget. No account disable/recovery, expired-session cleanup, configurable approvals, partial capacity, notifications or deployment infrastructure. Profile edits use last-write-wins; offset pages may shift; creates lack idempotency keys. Production security, load and Windows credential protection remain unverified.

## Verify and maintain

```sh
npm run typecheck
npm run build
npm test
npm run start
```

Stop `dev` before `start` on the same port. Build emits Node ESM into `dist`. `npm run test:unit` needs no database. Integration tests migrate/reset only the named loopback `mission_control_test`, using separate runtime/migration roles; they never fall back to development. The suite covers real PostgreSQL isolation, consent, booking races and CLI journeys including rejection/conflict recovery and API restart persistence.

For schema changes: `npm run db:generate`, inspect the SQL, then migrate. Never edit applied migrations.

| Document | Purpose |
| --- | --- |
| [WALKTHROUGH](WALKTHROUGH.md) | CLI journey, recovery and seed examples |
| [API](API.md) | HTTP operations, input limits and error contract |
| [DESIGN](DESIGN.md) | Preserved accepted blueprint |
| [DESIGN-DEVIATIONS](DESIGN-DEVIATIONS.md) | Agreed clarifications, implementation assumptions and actual departures |
| [SCHEMA](SCHEMA.md) | Current database structure and constraints |
| [IMPLEMENTATION-PLAN](IMPLEMENTATION-PLAN.md) | Original build order and acceptance criteria |
