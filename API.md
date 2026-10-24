# API reference

HTTP contract for clients. For setup see [README](README.md); permissions and lifecycle rules are defined in [DESIGN](DESIGN.md), with implementation clarifications in [DESIGN-DEVIATIONS](DESIGN-DEVIATIONS.md).

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

Crew `:id` accepts UUID or `me`. Creation returns 201. Mission/position/proposal writes return the updated visible mission/attempts; other deletes return `{message}`. PATCH requires an editable field; unknown/protected fields are rejected.

Names/biographies are trimmed; skill and login names are lowercase; passwords are unchanged. Display/organisation names, mission titles and position labels: 1–120 characters; skill names: 1–80; biography: ≤2000; brief: ≤4000. Usernames: 1–64 lowercase letters/digits/`._-`, beginning with a letter/digit. New passwords: 12–128 characters. Roles and organisation slugs are immutable.

Lists accept `limit` (default 25, maximum 100) and `offset` (default 0), returning `{items, nextOffset}`. Members/crew/skills/missions accept `q`, a literal case-insensitive substring. Missions also accept `state`; their search covers title/brief. Concurrent changes may shift offset pages. Availability is the union of positive `[start,end)` windows; timestamps require an offset and responses use UTC. Proficiency levels: 1 beginner, 2 basic, 3 independent, 4 advanced, 5 expert.

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
