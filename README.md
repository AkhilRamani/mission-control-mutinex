# Mission Control

TypeScript API and CLI for tenant-isolated mission planning. **Implemented: step 1, authentication and local setup.** Crew and mission workflows follow [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md); [DESIGN.md](DESIGN.md) remains the blueprint.

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

## API

JSON under `/v1`; authenticated requests use `Authorization: Bearer <token>`. Only the login response returns a raw token. All responses disable caching.

| Method and path | Request / result |
| --- | --- |
| `GET /health` | Process/database readiness, 200 or 503; no authentication |
| `POST /v1/auth/login` | `{organisation, username, password}` → `{token, expiresAt, user}` |
| `GET /v1/me` | `{user}` from the session, including organisation and fixed role |
| `POST /v1/auth/logout` | `{}` → deletes current session |
| `PUT /v1/me/password` | `{oldPassword, newPassword}` → changes password, revokes all own sessions |

Tenant/user identity comes only from the session. Login names are trimmed/lowercased; passwords are not. New passwords require 12–128 characters. Unknown fields are rejected. Error responses contain `{error: {code, message, recovery, requestId}}`; request IDs also appear in headers and structured logs. Logs contain route/status/timing/actor/tenant, never request bodies, passwords, tokens or SQL.

Errors: 400 correct input; 401 check credentials/login again; 404 check path; 409 check state then retry; 429 wait; 500 use the request ID; 503 check database readiness. Login and password changes share one process-wide budget of 10 attempts per minute. This simple limit suits the loopback-only service; local users share the budget and restarting the process resets it. JSON bodies are limited to 16 KiB.

Passwords use Node scrypt (`N=32768, r=8, p=3`, random 16-byte salt, 64-byte key, 64 MiB memory ceiling). Sessions use 32 random bytes, SHA-256 token hashes and 24-hour expiry. Login/password changes serialize on the user row; password changes recheck the session after acquiring the lock. Composite foreign keys prevent cross-tenant session references. The application scopes reads; there is no RLS.

## Verify and develop

```sh
npm run typecheck
npm run build
npm test
npm run start
```

Stop the development server before `start` on the same port. `build` emits Node ESM into `dist`. Tests migrate and reset **only** a loopback database named `mission_control_test`; both test URLs and distinct test runtime/migration roles are required. Test/seed URLs cannot contain query parameters or fragments, preventing connection-field overrides. Tests never fall back to the development database. The suite exercises real PostgreSQL constraints, deterministic lock races, safe failure responses, and real CLI subprocesses over HTTP. `npm run test:unit` needs no database.

Code is organised as `api/` (HTTP/validation), `domain/` (direct Drizzle operations), `db/` (schema/migrations/fixtures), and `cli/` (HTTP client/commands). Change the schema, run `npm run db:generate`, inspect the generated SQL, then migrate. Do not edit applied migrations. Authentication middleware supplies the tenant context for subsequent steps; enforce role/ownership checks when their resource operations are added.

Current limits: local evaluation only, one saved CLI session, Unix credential permissions, process-local rate limits, no expired-session cleanup job, no public account provisioning or recovery. PostgreSQL uses a pinned major version; npm dependencies are pinned in `package.json` and `package-lock.json`. Drizzle Kit's development-only loader currently carries an esbuild development-server advisory; this project does not run its server or Studio. Runtime dependencies have no reported audit findings at implementation time. No deployment infrastructure or production identity integration is included.

Library references: [Hono Node adapter](https://hono.dev/docs/getting-started/nodejs), [Drizzle migrations](https://orm.drizzle.team/docs/migrations), [Node scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
