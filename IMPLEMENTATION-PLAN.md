# Implementation plan

Follow [DESIGN.md](DESIGN.md) for product rules, permissions, storage constraints, and concurrency. This file defines build order, not new behaviour. Record departures in [DESIGN-DEVIATIONS.md](DESIGN-DEVIATIONS.md).

Complete each step through database → domain operation → API → CLI → focused tests. Add migrations and fixtures as needed, not the entire application upfront. Steps 1–2 cover identity/crew, 3–4 planning/consent, 5–6 approval/operation, and 7 delivery.

API paths below use `/v1`; braces list separate action endpoints. `/health` is unversioned. CLI commands use `mc` or `npm run mc --`.

## 1. Run locally and authenticate

**Build:** configure TypeScript/Node, Hono, Drizzle migrations, PostgreSQL Compose, test database, and CLI entry point. Add organisations/users/sessions and minimal fixtures for both tenants/all roles. Implement password/session handling, tenant context, validation, safe errors, logging, and CLI credential storage.

**API:** `GET /health`; `POST /auth/{login,logout}`; `GET /me`; `PUT /me/password`.

**CLI:** `login`, `logout`, `whoami`, `password change`; shared help, JSON output, exit codes, and HTTP error handling.

**Pass:** login → whoami → logout works through the real CLI; tenant identity is server-derived. Invalid credentials, expired/deleted tokens, and password-change/login races behave correctly. Health distinguishes database failure without exposing data. Fresh migration and typecheck pass.

## 2. Manage organisation and crew

**Build:** crew profiles, tenant skills, proficiency joins, availability, ownership checks, pagination/search, and explicit response fields. Director provisions an account, then creates its optional crew profile. Establish crew-row locking for profile changes; booking protections join it in step 5.

**API:**

- `GET/PATCH /organisation`; `GET/POST /members`.
- `GET/POST /crew`; `GET/PATCH /crew/:id`.
- `GET/POST /skills`; `PATCH/DELETE /skills/:id`.
- `PUT/DELETE /crew/:id/skills/:skillId`.
- `GET/POST /crew/:id/availability`; `DELETE /crew/:id/availability/:availabilityId`.

**CLI:** `org show/update`; `members list/create`; `crew create/list/show/update`; `skills list/add/rename/remove`; `crew skills set/remove`; `availability list/add/remove`. Support `--crew me` for personal operations.

**Pass:** Director creates a crew account; that person sets skills/availability and the Lead discovers them. Reject foreign IDs, mismatched parent/child references, peer access by Crew, forbidden edits, and invalid intervals/proficiency. Test availability unions and boundary adjacency.

## 3. Plan a mission

**Build:** missions, positions, requirements, and events. Add immutable ownership, mission locking/version checks, draft edits, position soft-removal, and history. Return positions and versions in mission reads. Keep action history and state changes atomic.

**API:** `GET/POST /missions`; `GET/PATCH /missions/:id`; `GET /missions/:id/history`; `POST /missions/:id/positions`; `PATCH/DELETE /missions/:id/positions/:positionId`.

**CLI:** `missions create/list/show/update/history`; `positions add/update/remove --mission ... --requires piloting:3`.

**Pass:** Lead creates and revises a mission entirely through the CLI. Other Leads can read but cannot edit it; Directors can manage it. Tenant/reference validation, protected fields, removed positions, invalid dates, stale writes, and identical-patch no-ops pass. Crew has no mission access until assigned.

## 4. Match crew and obtain consent

**Build:** assignments with uniqueness/booking constraints, matching, proposals, responses, and crew history. Implement the full-pool snapshot matcher and UTC workload calculation. Extend draft edits to invalidate affected consent; add restricted crew mission/event views and atomic roster swaps.

**API:**

- `GET /missions/:id/match`; `PUT /missions/:id/proposals`; `DELETE /missions/:id/proposals/:assignmentId`.
- `GET /assignments?mine=true`; `GET /assignments/:id`; `POST /assignments/:id/{accept,decline,retract}`.
- `GET /crew/:id/history`.

**CLI:** `missions match/propose` with explicit pairs or `--suggested`; `assignments list/show/accept/decline/retract/remove`; `crew history`.

**Pass:** Alex/Sam fills both positions; impossible rosters return explained partial results. Compare small graphs with exhaustive maximum cardinality. Verify deterministic results, candidates beyond page one, workload clipping, unchanged consent, invalidated consent, decline/reproposal, swaps, and historical privacy. Acceptance creates no booking. Test confirmed-work eligibility/workload using database fixtures until step 5 exposes approval.

## 5. Submit and approve safely

**Build:** submission freeze, withdrawal/rejection, and independent approval. Implement ordered mission/crew locks, post-lock eligibility/time checks, and all-or-nothing confirmation. Before exposing approval, complete profile/availability/skill guards against invalidating confirmed bookings. CLI review/confirmation uses the exact displayed version.

**API:** `POST /missions/:id/{submit,withdraw,approve,reject}`.

**CLI:** `missions submit/withdraw/approve/reject`; reasons where required; explicit reviewed `--version` for scripts.

**Pass:** accepted roster → submit → independent approval succeeds. Incomplete/invalid rosters and self-approval fail. Submitted edits fail; rejection/withdrawal resets consent. Two concurrent conflicting approvals produce exactly one winner, no partial bookings/events. Profile races, stale approvals, and lock waits crossing mission start cannot bypass eligibility.

## 6. Operate and close missions

**Build:** derived scheduled/active/awaiting-completion phases, explicit completion, cancellation and booking release. Keep completed bookings/history; support late cancellation before explicit completion. All approved edits remain prohibited.

**API:** `POST /missions/:id/{cancel,complete}`; existing reads expose phase and resulting history.

**CLI:** `missions cancel/complete`; `missions show/history` explains terminal states and cancellation/replacement recovery.

**Pass:** clock-driven phase changes require no job. Early completion fails; completion at/after end succeeds. Cancellation releases capacity and updates workload; replacement needs new consent/approval. Test late cancellation, terminal/repeated commands, cancellation/profile races, and preserved history.

## 7. Deliver a reproducible application

**Build:** finish representative Atlas/Boreal seeds, README setup, role credentials, successful CLI walkthrough, and failure/recovery examples. Supply scripts from DESIGN.md; separate migration/runtime/test credentials and guard seed/reset/test targets. Do not add new product features here.

**Pass:** from a clean checkout, install → start PostgreSQL → migrate → seed → run API/CLI. A real CLI test completes the journey plus decline/rejection/conflict recovery; restart preserves data. Run build, typecheck, unit tests and PostgreSQL integration tests. Verify every permission boundary and resource family, including lists, searches, counts, related records, events and error details. No SQL knowledge or fixture-ID lookup is needed to use the CLI.

**Finish:** document known limitations and any agreed deviations. Do not duplicate every API test through the CLI or introduce infrastructure to satisfy hypothetical future requirements.
