# Mission Control

Tenant-isolated mission planning with a TypeScript API and CLI. All seven implementation steps are complete; no web UI.

[CLI walkthrough](WALKTHROUGH.md) · [Design blueprint](DESIGN.md) · [Schema](SCHEMA.md) · [Implementation sequence](IMPLEMENTATION-PLAN.md) · [Assumptions and deviations](DESIGN-DEVIATIONS.md)

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

API: `http://127.0.0.1:3000` (`PORT` in `.env`); PostgreSQL: `127.0.0.1:55432`. Compose volumes survive restarts; `docker compose stop` preserves data. Seeds are atomic, require an empty database and never reset data. To upgrade, rerun migrations and restart the API; migrations are repeatable and do not insert fixtures.

Compose provisions separate owner/migration and unprivileged runtime roles for development/tests. The API rejects superuser/role-administration credentials. Migration credentials install `btree_gist` for booking exclusion. With an existing PostgreSQL 17 instance, run `docker/init.sql` once as administrator using `psql`, then adjust `.env` ports. This provisioning script is not repeatable and does not drop existing objects.

## Demo and CLI

All seeded passwords are **`Local-mission-123!`**, for local evaluation only:

| Organisation | Accounts |
| --- | --- |
| `atlas` | `director`, `director2` (Directors); `lead` (Lead); `alex`, `sam`, `jules`, `lee` (Crew) |
| `boreal` | `director` (Director); `lead` (Lead); `alex` (Crew) |

```sh
npm run mc -- login --org atlas --username lead
npm run mc -- whoami
npm run --silent mc -- --json whoami
npm run mc -- logout
npm run mc -- --help
```

Follow the [walkthrough](WALKTHROUGH.md) for planning → matching → consent → approval → completion/cancellation and failure recovery. Create/list/show commands supply IDs and versions; no database knowledge is needed. Use `<command> --help` for options.

Seeds have five Atlas and two Boreal crew profiles, different catalogues and overlapping names. Alex has both skills; Sam is pilot-only, Jules underqualified, Lee unavailable, and Leads have profiles. Fourteen missions cover every state, partial/declined consent, rejection, conflicts and adjacent bookings. Stable IDs use the seed day’s UTC midnight as their date anchor; availability spans −7 through +35 days, end exclusive. [Seed examples](WALKTHROUGH.md#seed-examples) age with real time; `Active patrol` is active only on seed day. Qualifications are self-declared.

**Sessions and scripts:**

- Passwords use hidden prompts. `login --password-stdin` reads one line from a secure pipe; `password change --password-stdin` reads current/new passwords on two lines. Never put secrets in arguments/history. Password changes revoke all your sessions; log in again.
- `--api <origin>` or `MC_API_URL` overrides the saved origin. HTTP is loopback-only; remote origins require HTTPS. Tokens cannot follow redirects or cross origins. Log out before switching accounts/servers.
- Credentials live at `~/.config/mission-control/session.json`, outside the repository, with Unix ownership checks and directory/file modes `700`/`600`. `MC_CONFIG_DIR` selects another absolute directory outside the project. Login JSON exposes user/expiry, never the token.
- Expired/revoked session: logout/login. Logout is repeatable; network failure retains credentials for revocation retry. A lost login response may leave an unused session until its 24-hour expiry.
- `--json` sends results to stdout, errors to stderr; failures exit nonzero. Use `npm run --silent mc --` for clean JSON. Destructive actions require confirmation (`--yes` for scripts). Writes never retry automatically; inspect lists/history after uncertain results.

## Commands and permissions

Prefix commands with `npm run mc --`. Replace IDs/versions with reviewed output; timestamps require an offset, such as `2027-01-10T09:00:00Z`, and mission starts must be future.

| Commands | Purpose / key options |
| --- | --- |
| `login`, `logout`, `whoami`, `password change` | Authentication and own password |
| `org show/update` | Read settings; Director changes `--name` |
| `members list/create` | Director provisioning: `--username`, `--name`, `--role`; password prompted privately |
| `crew create/list/show/update/history` | Create with `--member <id>`; profile operations accept `--crew <id\|me>`; update `--name`, `--bio`, `--active true\|false` |
| `skills list/add/rename/remove` | Catalogue; mutations use `--name` and/or `--skill <id>` |
| `crew skills set/remove` | Own `--crew`, `--skill`; set `--level 1–5` |
| `availability list/add/remove` | `--crew`; add `--start/--end`; remove `--window <id>` |
| `missions create/list/show/update/history` | Create `--title`, optional `--brief`, `--start/--end`; target `--mission`; list `--state` |
| `positions add/update/remove` | `--mission`, `--version`, `--position` for existing positions; `--label`, `--requires piloting:3 medical:2` |
| `missions match/propose` | `--mission`; propose `--version` with `--suggested` or `--pairs <position-id>=<crew-id> ...` |
| `assignments list/show/accept/decline/retract/remove` | List `--mine`; actions `--assignment`; mutations use reviewed `--version` |
| `missions submit/withdraw/approve/reject/cancel/complete` | `--mission`, reviewed `--version`; withdraw/reject/cancel require `--reason` |

To provision crew: Director creates a member and optional crew profile, sharing the initial password outside the app. That person declares skills/availability, then a Lead discovers them. Any role may have a profile. Directors manage accounts/catalogue/profile metadata and active status; only profile owners declare skills/availability. Leads read tenant crew; Crew Members see only themselves. Member lists are Director-only; everyone can read the tenant catalogue. Deactivation affects staffing, not login.

Skill renames must preserve meaning; referenced skills cannot be deleted. Proficiency: 1 beginner, 2 basic, 3 independent, 4 advanced, 5 expert. Availability uses positive `[start,end)` intervals, returned in UTC; overlapping/adjacent windows combine for coverage. Removing a window removes that record only and must preserve confirmed-work coverage.

Lists accept `--limit` (default 25, max 100), `--offset`, and `--search` for members/crew/skills/missions. Search is a literal case-insensitive substring. JSON lists return `{items, nextOffset}`; human output supplies the next offset. Offset pages can shift during concurrent edits.

## Mission rules

- **Draft:** creator is immutable owner. Directors edit any tenant draft; Leads edit only their own but can read others. Crew sees only current/past assigned missions, own positions/assignments and filtered history. Each position takes one distinct person meeting every skill threshold. `--requires` accepts exact names or UUIDs and replaces the requirement set; `--clear-requirements` empties it. Empty drafts/requirements are valid. Removed positions remain visible; ordinals are never reused.
- **Versions:** every existing mission/assignment mutation requires the reviewed mission version. Changes increment it once with an atomic event; identical valid patches/proposals are no-ops. On `STALE_VERSION`, show/history, review, then explicitly retry. Creation/timeline changes require future start. Acceptance/approval can review and confirm interactively; scripts must pass `--version`. Commands never silently refresh it.
- **Matching:** reads the full tenant pool in one consistent snapshot. Eligibility requires active status, all skills, full availability and no confirmed overlap. Augmenting paths guarantee maximum coverage, assigning Sam→Pilot and Alex→Medic when needed. Output explains proficiency, exclusions, competing needs, coverage, snapshot/version and workload. Prefer fewer confirmed hours clipped to the proposed start month in UTC, then crew UUID. Completed work counts; tentative/released work does not. This is a heuristic, not a capacity cap or globally optimal fairness.
- **Proposals/consent:** matching is read-only and does not pin existing choices. `--suggested` requires a complete match and its reviewed version. Manual proposals may be partial and replace the whole roster: omitted pairs withdraw, unchanged pairs retain consent, swaps are atomic. The API also accepts an empty roster. Recheck `INELIGIBLE_CREW` and rematch if profiles/bookings changed. Acceptance is personal consent without reservation; tentative overlaps are allowed. Decline is terminal; reproposal creates a new attempt. Retract returns accepted→proposed; owner/Director removal withdraws an attempt. History retains all attempts.
- **Material edits:** title/brief/time changes reset all acceptances; position label/requirements reset only that position; removal/replacement withdraws its attempt. Events preserve prior plans/responses. Future/active confirmed commitments block invalidating profile edits (`CONFIRMED_WORK`); safe skill reductions/redundant-window removal are allowed. Ended work no longer restricts profiles.
- **Submit/review:** requires ≥1 active position, complete accepted roster, eligibility and future start. Submission freezes plan/consent without booking. Only a Director other than the creator approves/rejects. Owner/Director withdrawal or independent rejection returns to draft and resets consent; a trimmed 1–2000-character reason and confirmation are required. Reasons are planner-only. Approval atomically rechecks eligibility and books everyone with version/history; failure leaves the plan submitted. On conflict/ineligibility, withdraw, revise/rematch, obtain fresh consent and resubmit.
- **Operate/close:** approved phase derives from server time: `scheduled` before start, `active` during `[start,end)`, then `awaiting_completion`; other states have `phase: null`. No activation command/job/event/version change. Owner/Director completes at/after end or cancels a draft/submitted/approved plan, even late, with confirmation. `MISSION_NOT_ENDED` means wait or cancel an aborted mission. Completion retains bookings/workload; cancellation withdraws tentative assignments, releases the whole confirmed booking and removes even elapsed workload. Events retain prior consent/bookings; cancellation reasons are planner-only. Terminal plans are final; approved edits require cancellation/replacement and fresh consent/approval.

## API reference

JSON under `/v1` (except `/health`), with `Authorization: Bearer <token>`. Only login returns the raw token; responses disable caching. Braces below denote separate action endpoints.

| Method / path | Body / result |
| --- | --- |
| `GET /health` | Public process/database readiness: 200 or 503 |
| `POST /auth/login` | `{organisation, username, password}` → `{token, expiresAt, user}` |
| `GET /me`; `POST /auth/logout`; `PUT /me/password` | Identity; logout `{}`; password `{oldPassword, newPassword}` revokes all own sessions |
| `GET/PATCH /organisation` | Settings; PATCH `{name}` |
| `GET/POST /members` | Members; POST `{username, displayName, role, password}` |
| `GET/POST /crew`; `GET/PATCH /crew/:id` | POST `{userId}`; profile/skills; PATCH `{displayName?, biography?, active?}` |
| `GET/POST /skills`; `PATCH/DELETE /skills/:id` | Create/rename `{name}`; delete unreferenced skill |
| `PUT/DELETE /crew/:id/skills/:skillId` | PUT `{proficiency}`; remove own skill |
| `GET/POST /crew/:id/availability`; `DELETE /crew/:id/availability/:availabilityId` | Windows; POST `{start, end}`; delete validates parent/child |
| `GET/POST /missions`; `GET/PATCH /missions/:id` | POST `{title, brief?, start, end}`; PATCH `{version, title?, brief?, start?, end?}` |
| `GET /missions/:id/history` | `{missionId, version, items, nextOffset}`, ordered by version |
| `POST /missions/:id/positions` | `{version, label, requirements?: [{skillId, minProficiency}]}` |
| `PATCH/DELETE /missions/:id/positions/:positionId` | PATCH `{version, label?, requirements?}` replaces supplied requirements; DELETE `{version}` soft-removes |
| `GET /missions/:id/match`; `PUT /missions/:id/proposals` | Explained match; PUT `{version, proposals: [{positionId, crewId}]}` replaces roster |
| `DELETE /missions/:id/proposals/:assignmentId` | `{version}` withdraws current proposal |
| `GET /assignments`; `GET /assignments/:id`; `GET /crew/:id/history` | Visible attempts; `mine=true` restricts any role to own assignments; detail includes plan/position/version |
| `POST /assignments/:id/{accept,decline,retract}` | `{version}` → assignment/version |
| `POST /missions/:id/{submit,approve,complete}` | `{version}` |
| `POST /missions/:id/{withdraw,reject,cancel}` | `{version, reason}` |

Crew `:id` accepts UUID or `me`. Lists use `limit/offset`; searchable lists use `q`, missions also `state` (search covers title/brief). Creation returns 201. Mission/position/proposal writes return the updated visible mission/attempts; other deletes return `{message}`. PATCH requires an editable field; unknown/protected fields are rejected.

Names/biographies are trimmed; skill and login names are lowercase; passwords are unchanged. Display/organisation names, mission titles and position labels: 1–120 characters; skill names: 1–80; biography: ≤2000; brief: ≤4000. Usernames: 1–64 lowercase letters/digits/`._-`, beginning with a letter/digit. New passwords: 12–128 characters. Roles and organisation slugs are immutable.

## Security and errors

Tenant/user come only from the session. Scoped reads and composite foreign keys enforce tenant/parent relationships; no RLS or cascading deletions. Runtime roles cannot UPDATE/DELETE mission events. Login/password changes serialize on the user row; password changes recheck the session after acquiring the lock.

Passwords use scrypt (`N=32768, r=8, p=3`, random 16-byte salt, 64-byte key, 64 MiB ceiling). Sessions use 32 random bytes, SHA-256 token hashes and 24-hour expiry. Login/password changes share ten attempts/minute per process; users share the budget and restarting clears it. JSON bodies are limited to 16 KiB.

Errors return `{error: {code, message, recovery, requestId}}`; IDs also appear in headers/logs. Logs include route/status/timing/actor/tenant, never bodies, passwords, tokens or SQL.

| Status | Recovery |
| --- | --- |
| 400 / 401 / 403 | Correct input / check credentials or login / use an authorised account |
| 404 | List visible resources; missing, foreign and private records are indistinguishable |
| 409 / 422 | Review current mission/assignments before retrying / correct eligibility or rematch |
| 429 / 500 / 503 | Wait / use request ID / check database readiness |

## Verify and maintain

```sh
npm run typecheck
npm run build
npm test
npm run start
```

Stop `dev` before `start` on the same port. Build emits Node ESM into `dist`; `test:unit` needs no database. Integration tests migrate/reset only loopback `mission_control_test`, require both test URLs with distinct runtime/migration roles, and never fall back to development. Test/seed URLs reject query parameters/fragments to prevent connection overrides. Tests cover real PostgreSQL constraints, lock races, safe errors and CLI subprocesses; integration files run serially with shared fixtures/API/CLI helpers.

One package, four feature groups (auth, organisation, crew, missions):

- `api/`: shared HTTP policy/authentication in `app.ts`, input validation and routes calling domain functions. Only health/login are public.
- `domain/`: permissions, scoped queries and transactions. Mission modules: `planning`, `matching` (queries/explanations), `matcher` (pure algorithm), `assignments`, `approval`, `lifecycle`, `reads`, `shared` (reads/checks), `changes` (consent/snapshots/events). `crew-bookings` guards eligibility edits. Public mutations own transactions; mission/crew locks serialize related writes; mission detail/history use consistent snapshots. No repository/generic CRUD layer.
- `cli/`: command registration/output in `index.ts`, one HTTP client/context, shared `mission-output.ts`, and type-only domain imports for response shapes.
- `db/`: schema, migrations, fixtures. For schema changes: `npm run db:generate`, inspect SQL, migrate. Never edit applied migrations; append events atomically with state changes.

Limits: local evaluation, Unix credentials, process-local throttling, no expired-session cleanup, public onboarding/recovery, deployment or production identity integration. Profile edits use last-write-wins under locks; creation lacks idempotency, duplicate availability is allowed, repeated skill PUTs replace levels, repeated removals return 404. Provisioning sends no invitations or forced password resets. PostgreSQL major/npm dependencies are pinned. Tests inject seed dates; production uses real time. See [assumptions and deviations](DESIGN-DEVIATIONS.md) for verification boundaries.

References: [Hono Node](https://hono.dev/docs/getting-started/nodejs), [Drizzle migrations](https://orm.drizzle.team/docs/migrations), [Node scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
