# Mission Control

TypeScript API and CLI for tenant-isolated mission planning. **Implemented: steps 1–3, authentication, organisation/crew management and draft mission planning.** Next steps follow [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md); [DESIGN.md](DESIGN.md) remains the blueprint. [SCHEMA.md](SCHEMA.md) documents implemented and planned tables.

## Run locally

Requires Node 22.13+ and Docker Compose. Run from the repository root:

```sh
npm ci
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

The API listens at `http://127.0.0.1:3000`; PostgreSQL at `127.0.0.1:55432`. Set `PORT` in `.env` if needed. Data survives restarts in the Compose volume. Seeding is atomic and refuses a nonempty database. Repeated migration runs are safe. Use `docker compose stop` to stop PostgreSQL without deleting data.

Compose creates separate database-owner migration roles and unprivileged runtime roles for development and tests. The API refuses superuser/role-administration credentials. For an existing local PostgreSQL 17 instance, run `docker/init.sql` once with `psql` as its administrator, then adjust the ports in `.env`. That script provisions dedicated databases/roles and is not repeatable; it does not drop existing objects. No extension is needed yet.

**Upgrading:** run `npm run db:migrate` and restart the API. Existing data remains intact; migrations do not insert fixtures. Use the CLI below to add profiles/skills/missions. `db:seed` requires an empty database and never resets existing data.

## Try the CLI

In another terminal:

```sh
npm run mc -- login --org atlas --username lead
npm run mc -- whoami
npm run mc -- --json whoami
npm run mc -- password change
# All sessions are now revoked. Log in with the new password.
npm run mc -- login --org atlas --username lead
npm run mc -- logout
npm run mc -- --help
```

Passwords are prompted privately. Every seeded account initially uses **`Local-mission-123!`**, for local evaluation only:

| Organisation | Usernames and roles |
| --- | --- |
| `atlas` | `director`, `director2` (Directors); `lead` (Lead); `alex`, `sam` (Crew) |
| `boreal` | `director` (Director); `lead` (Lead); `alex` (Crew) |

Use `--api <origin>` or `MC_API_URL` for another server. Subsequent commands use the saved origin unless explicitly overridden. HTTP is restricted to loopback; remote origins require HTTPS. Tokens cannot follow redirects or be sent to a different origin. Log out before switching accounts/servers.

The session is stored outside the repository at `~/.config/mission-control/session.json` (directory `700`, file `600`, Unix ownership checked). `MC_CONFIG_DIR` selects another absolute directory outside the project, useful for isolated tests. Login JSON contains the user and expiry, never the bearer token. Expired/revoked credentials: run `logout`, then `login`. Logout is safe to repeat; network failures retain the file so server revocation can be retried. A lost login response can leave an unused session until its 24-hour expiry.

For scripts, `login --password-stdin` reads one line from a secure pipe; `password change --password-stdin` reads current and new passwords on two lines. Never put secrets in command arguments or shell history. `--json` writes results to stdout and errors to stderr; failures exit nonzero. For clean JSON through npm, use `npm run --silent mc -- --json whoami`. Writes are never automatically retried.

## Configure crew through the CLI

Commands print discoverable IDs. Replace `<member-id>`, `<skill-id>` and `<crew-id>` below with the IDs shown by create/list commands. Start logged out:

```sh
npm run mc -- login --org atlas --username director
npm run mc -- org show
npm run mc -- org update --name 'Atlas Operations'
npm run mc -- members create --username jamie --name Jamie --role crew
# Enter an initial password privately, then share it with the person outside this app.
npm run mc -- members list --search jamie
npm run mc -- crew create --member <member-id>
npm run mc -- skills list
# Only if piloting is absent (an upgraded step 1 database):
npm run mc -- skills add --name piloting
npm run mc -- logout

npm run mc -- login --org atlas --username jamie
npm run mc -- crew update --crew me --bio 'Available for flight missions'
npm run mc -- crew skills set --crew me --skill <skill-id> --level 3
npm run mc -- availability add --crew me --start 2030-01-10T09:00:00Z --end 2030-01-10T17:00:00Z
npm run mc -- crew show --crew me
npm run mc -- availability list --crew me
npm run mc -- logout

npm run mc -- login --org atlas --username lead
npm run mc -- crew list --search jamie
npm run mc -- crew show --crew <crew-id>
npm run mc -- availability list --crew <crew-id>
npm run mc -- logout
```

Directors manage accounts, catalogue names and crew name/biography/active status. Any role can have a crew profile. All roles can edit their own name/biography, but **only the owner can declare skills and availability**. Leads can read all tenant crew; Crew Members can list/show only themselves. Member lists are Director-only; the skill catalogue is visible to all tenant members. Deactivating a crew profile affects staffing eligibility, not login access.

Other commands: `skills rename/remove --skill <id>`, `crew skills remove --skill <id>`, `availability remove --window <id>`, `crew update --active false`. Run each with `--help` for required options. Destructive commands prompt; scripts must explicitly supply `--yes`. Skill renames must preserve meaning; referenced skills cannot be deleted. Proficiency levels are 1 beginner, 2 basic, 3 independent, 4 advanced, 5 expert.

Lists accept `--limit` (25 by default, maximum 100), `--offset`, and `--search` on members/crew/skills. Human output supplies the next offset; JSON is `{items, nextOffset}`. Search is a literal, case-insensitive substring. Availability requires offset-bearing ISO timestamps and positive `[start,end)` intervals; responses use UTC. Overlapping/adjacent windows jointly provide coverage. Removing a window removes only that record.

Fresh seeds include Atlas/Boreal profiles for Leads and Crew, different skill catalogues, Alex with both skills, Sam with piloting only, and underqualified Leads without availability. Crew availability uses the fixed UTC interval **2030-01-01 through 2030-02-01 (exclusive)**. These are local examples, not qualifications verified by Directors.

## Plan a mission through the CLI

Log in as `atlas/lead`. Use IDs and the current version printed by each response:

```sh
npm run mc -- missions create --title 'Supply flight' --brief 'Deliver supplies' --start 2030-01-10T09:00:00Z --end 2030-01-10T17:00:00Z
npm run mc -- missions list --search supply --state draft
npm run mc -- missions show --mission <mission-id>
npm run mc -- positions add --mission <mission-id> --version 1 --label Pilot --requires piloting:3
npm run mc -- positions add --mission <mission-id> --version 2 --label Medic --requires medical:3
npm run mc -- missions update --mission <mission-id> --version 3 --brief 'Deliver medical supplies'
npm run mc -- positions update --mission <mission-id> --position <position-id> --version 4 --requires medical:4
npm run mc -- missions history --mission <mission-id>
# Optional: remove a position, retaining its history.
npm run mc -- positions remove --mission <mission-id> --position <position-id> --version 5 --yes
```

Directors can edit any tenant draft; Leads only their own. Other Leads can read it; Crew has no mission access until assignments arrive in step 4. Creation sets the immutable owner. Each position takes one person and may require several skills: `--requires piloting:3 medical:2` (exact names or UUIDs). Updates replace the requirement set; `--clear-requirements` empties it. Empty plans/requirements are allowed while drafting. Removed positions stay visible and their ordinals are never reused.

Every edit requires the mission version you reviewed. Changed writes increment it once with an atomic history event; identical valid patches do neither. On `STALE_VERSION`, run `missions show`, review changes, then explicitly retry with its version. After uncertain creation, inspect `missions list` or `missions history` before retrying. Creation and timeline changes require a future start; only drafts can be edited. Matching, assignments, approval and operation arrive in steps 4–6; representative mission seeds arrive in step 7.

## API

JSON under `/v1`; authenticated requests use `Authorization: Bearer <token>`. Only the login response returns a raw token. All responses disable caching.

| Method and path | Request / result |
| --- | --- |
| `GET /health` | Process/database readiness, 200 or 503; no authentication |
| `POST /v1/auth/login` | `{organisation, username, password}` → `{token, expiresAt, user}` |
| `GET /v1/me` | `{user}` from the session, including organisation and fixed role |
| `POST /v1/auth/logout` | `{}` → deletes current session |
| `PUT /v1/me/password` | `{oldPassword, newPassword}` → changes password, revokes all own sessions |
| `GET/PATCH /v1/organisation` | Organisation fields; PATCH `{name}` (Director) |
| `GET/POST /v1/members` | Paginated accounts; POST `{username, displayName, role, password}` (Director) |
| `GET/POST /v1/crew` | Paginated visible profiles; POST `{userId}` (Director) |
| `GET/PATCH /v1/crew/:id` | Profile with skills; PATCH `{displayName?, biography?, active?}` (at least one) |
| `GET/POST /v1/skills` | Paginated catalogue; POST `{name}` (Director) |
| `PATCH/DELETE /v1/skills/:id` | Rename with `{name}` / remove unreferenced skill (Director) |
| `PUT/DELETE /v1/crew/:id/skills/:skillId` | Set `{proficiency}` / remove own skill |
| `GET/POST /v1/crew/:id/availability` | Paginated windows; POST `{start, end}` for own profile |
| `DELETE /v1/crew/:id/availability/:availabilityId` | Remove own window, with parent/child validation |
| `GET/POST /v1/missions` | Paginated visible plans; POST `{title, brief?, start, end}` |
| `GET/PATCH /v1/missions/:id` | Plan with version/positions; PATCH `{version, title?, brief?, start?, end?}` |
| `GET /v1/missions/:id/history` | `{missionId, version, items, nextOffset}`; events ordered by mission version |
| `POST /v1/missions/:id/positions` | `{version, label, requirements?: [{skillId, minProficiency}]}` |
| `PATCH /v1/missions/:id/positions/:positionId` | `{version, label?, requirements?}`; replaces supplied requirements |
| `DELETE /v1/missions/:id/positions/:positionId` | JSON body `{version}`; soft-remove |

Crew `:id` accepts a UUID or `me`. Lists use `limit`/`offset`; members/crew/skills/missions accept literal substring `q`. Mission search covers title/brief and accepts a `state` filter. Creation returns 201. Mission/position writes return the complete updated mission; other deletes return `{message}`. PATCH requires at least one editable field. Names/biographies are trimmed; skill names are lowercase. Display/organisation names, mission titles and position labels are 1–120 characters; skill names 1–80; biographies at most 2000 and briefs 4000. Usernames are 1–64 lowercase letters/digits/`._-`, beginning with a letter/digit. Account roles and organisation slugs are immutable.

Tenant/user identity comes only from the session. Login names are trimmed/lowercased; passwords are not. New passwords require 12–128 characters. Unknown fields are rejected. Error responses contain `{error: {code, message, recovery, requestId}}`; request IDs also appear in headers and structured logs. Logs contain route/status/timing/actor/tenant, never request bodies, passwords, tokens or SQL.

Errors: 400 correct input; 401 check credentials/login again; 403 use an authorised account; 404 list visible resources and check IDs (missing/foreign/private records are indistinguishable); 409 inspect existing records/references before retrying; 429 wait; 500 use the request ID; 503 check database readiness. Login and password changes share one process-wide budget of 10 attempts per minute. This simple limit suits the loopback-only service; local users share the budget and restarting the process resets it. JSON bodies are limited to 16 KiB.

Passwords use Node scrypt (`N=32768, r=8, p=3`, random 16-byte salt, 64-byte key, 64 MiB memory ceiling). Sessions use 32 random bytes, SHA-256 token hashes and 24-hour expiry. Login/password changes serialize on the user row; password changes recheck the session after acquiring the lock. Composite foreign keys prevent cross-tenant session references. The application scopes reads; there is no RLS.

## Verify and develop

```sh
npm run typecheck
npm run build
npm test
npm run start
```

Stop the development server before `start` on the same port. `build` emits Node ESM into `dist`. Tests migrate and reset **only** a loopback database named `mission_control_test`; both test URLs and distinct test runtime/migration roles are required. Test/seed URLs cannot contain query parameters or fragments, preventing connection-field overrides. Tests never fall back to the development database. The suite exercises real PostgreSQL constraints, deterministic lock races, safe failure responses, and real CLI subprocesses over HTTP. `npm run test:unit` needs no database.

Code follows four feature groups across `api/`, `domain/` and `cli/`: auth, organisation (settings, accounts, catalogue), crew (profiles, skills, availability), and missions. Mission domain operations live in `domain/missions/planning.ts`, keeping drafts, positions and history together. Add sibling workflow modules as matching, assignments and lifecycle operations are implemented; extract shared helpers only when another module needs them.

- `api/app.ts` owns shared HTTP policy and route registration. Login/health are public; every other route group mounts after authentication. Routes validate input and call domain functions.
- `domain/` owns permissions, tenant-scoped queries and transactions. Crew changes share crew-row locks; planning changes share mission-row locks. Mission detail/history reads use a consistent snapshot. No repository or generic CRUD layer.
- `cli/index.ts` registers commands and handles output/errors; feature files use one HTTP client and credential context. Type-only domain imports reuse response shapes without loading database code into the CLI.
- `db/` keeps one schema, migrations and fixtures. Tests share guarded database setup, an authenticated API test client and a real CLI subprocess runner; integration files run serially against the dedicated test database.

Change the schema, run `npm run db:generate`, inspect the generated SQL, then migrate. Do not edit applied migrations. Composite FKs enforce tenant/parent relationships; no cascading deletions. Mission event UPDATE/DELETE privileges are revoked from runtime roles in the migration; domain functions append events alongside changes.

Step 2 limits: profile edits use last-write-wins; offset pagination is not a snapshot across concurrent edits. Creation POSTs are not idempotent: after an uncertain response inspect lists before retrying, especially availability (duplicate windows are allowed). Repeat skill PUTs replace the level; repeat removals return 404. Account creation does not send invitations or force a password reset; the member can run `password change`. Crew history arrives with assignments in step 4, and confirmed-booking edit guards in step 5.

Current limits: local evaluation only, one saved CLI session, Unix credential permissions, process-local rate limits, no expired-session cleanup job, no public account provisioning or recovery. PostgreSQL uses a pinned major version; npm dependencies are pinned in `package.json` and `package-lock.json`. Drizzle Kit's development-only loader currently carries an esbuild development-server advisory; this project does not run its server or Studio. Runtime dependencies have no reported audit findings at implementation time. No deployment infrastructure or production identity integration is included.

Library references: [Hono Node adapter](https://hono.dev/docs/getting-started/nodejs), [Drizzle migrations](https://orm.drizzle.team/docs/migrations), [Node scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
