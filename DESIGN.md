# Mission Control: build plan

Accepted plan, 24 October 2026. Record later implementation departures in `DESIGN-DEVIATIONS.md`; agree product changes first. Implementation has not started.

## 1. Build

One Node/TypeScript service, PostgreSQL database, and CLI calling the API. Use Hono, Drizzle/`pg`, Zod, Commander, npm, `tsx`, and Vitest. Keep one package with `api/`, `domain/`, `db/`, `cli/`, and tests. Domain operations use Drizzle directly; one CLI HTTP client handles requests/errors. No generic repositories or workflow/event-replay frameworks.

Deliver the complete journey: configure crew → draft mission → match/propose → crew accept → submit → independent Director approve → time activates → complete or cancel.

Local evaluation scope: accounts are seeded or Director-created. No web UI, public onboarding/email/recovery/SSO, multiple tenants per account, editable/custom roles, configurable approvals, partial capacity, recurring calendars, notifications/jobs, verified qualifications, cross-mission optimisation, custom fields, or deployment infrastructure.

## 2. Enforce these rules

### Identity and access

Each account has one tenant and one role; any role may also have a crew profile. Mission creator becomes its immutable owner.

| Role | Permissions |
| --- | --- |
| Director | Tenant-wide visibility and planning; manage organisation name, members, skills, crew display/biography/active status. Approve/reject only another owner's mission. |
| Lead | Read tenant crew/missions; create missions and plan, submit, withdraw, cancel, complete only their own. |
| Crew | Own profile, skills, availability, assignments/history; restricted access to missions with current/past assignments. |

Every role may manage its own password/profile and respond only to its own crew assignments. Directors cannot fabricate another person's skills, availability, or consent. Proficiency is self-declared: 1 beginner, 2 basic, 3 independent, 4 advanced, 5 expert.

Crew mission responses expose title, brief, times/state/phase, their position/requirements, assignment and relevant history. Exclude peers, rosters, candidates, private events/approval notes. Former assignees retain brief visibility. Allowlist response/event fields; preserve historical proposal/consent details.

Derive tenant/user from the session, never client tenant fields. Scope every read, join, count, search, match, history and mutation; validate child-parent relationships and ownership. Missing/foreign/invisible IDs share a 404; forbidden actions on visible records return 403. Check visibility before exposing state/version/conflict details. Reject unknown/protected fields; parameterise SQL; never expose credentials, SQL errors, or hidden conflict IDs. RLS is deferred, so scoped queries and isolation tests are mandatory.

Login: organisation slug, username, password; identical 401s and dummy verification for unknown accounts. Use salted `scrypt`, documented parameters, and hashed random bearer tokens expiring in 24 hours. Logout deletes the session; password change verifies the old password and atomically updates it/deletes all sessions. Serialize login/session creation with password changes using a user-row lock.

CLI passwords use hidden prompts; tokens live outside the repo with owner-only permissions, never argv/logs/ordinary JSON. Bind locally to loopback, require TLS remotely, bound bodies/login attempts, and use non-superuser runtime credentials.

### Mission and assignment lifecycle

- Create `draft` with future start and positive duration. Each position needs one distinct person meeting every required skill threshold.
- Proposals become `accepted` or `declined` by assigned crew while draft. Acceptance is consent, **not a reservation**; overlapping tentative acceptances are allowed.
- Submit only a fully accepted, currently eligible roster; freeze it as `submitted`. Owner/Director withdrawal or independent Director rejection returns it to draft, resets all acceptances to proposed, and records a reason.
- Independent Director approval rechecks eligibility and atomically confirms and books all positions. Failure leaves the mission submitted and assignments accepted.
- Approved phase derives from time: scheduled, active during its interval, awaiting completion afterwards. Owner/Director completes at/after end; confirmed assignments remain historical bookings.
- Owner/Director can cancel draft/submitted/approved missions with a reason, including after scheduled end. Withdraw tentative assignments and release confirmed bookings. Completed/cancelled missions are terminal. Approved edits require cancellation/replacement and fresh consent/approval.

Draft title/brief/time edits reset all acceptances; position label/requirement edits reset that position. Resetting clears current response time, not history. Other position changes preserve unaffected consent. Replacement/removal withdraws the old assignment; declined/withdrawn/released attempts are terminal, so reproposal creates a new row. Draft crew can retract acceptance to proposed, then decline. After submission, they must request withdrawal/cancellation. Skill renames cannot change meaning.

Crew changes may invalidate tentative eligibility, requiring withdrawal/revision at approval. Reject skill/availability/active edits that invalidate future/active confirmed work; historical completed work imposes no restriction. Matching, proposing, accepting and timeline edits require future start; reschedule/cancel elapsed drafts.

### Concurrency

Every existing mission/assignment mutation requires the reviewed mission version and locks that mission. Increment once per change; identical valid patches/proposals are no-ops. Stale/repeated transitions return 409 without duplicate effects. CLI acceptance/approval displays the plan and uses that version; scripts provide `--version`. Never silently refresh consent or automatically retry writes.

Approval transaction (READ COMMITTED): lock mission; check version/state/independent Director; lock crew profiles in UUID order; sample actual current time after locks; recheck future start, consent, skills, full availability, and bookings; confirm assignments with mission interval and commit state/version/event together. Roll back everything on failure; overlap returns `CREW_CONFLICT`.

Profile edits use the same crew locks; cancellation locks mission then sorted crew. Profile-only writes never lock missions. Map deadlock/timeout to retryable conflict. Crew locks protect eligibility; the database exclusion constraint protects booking overlap.

### Matching and time

Use finite `[start,end)` UTC intervals stored as `timestamptz`; inputs require offsets. Explicit availability must cover the whole interval; merge overlapping/adjacent windows. Missing time is unavailable; adjacent bookings are allowed.

Eligible crew: active, all skill thresholds met, full availability, no confirmed overlap. Read-only matching uses the full tenant candidate pool under REPEATABLE READ with a small fixed query set; display pagination cannot truncate candidates.

Use augmenting-path maximum-cardinality matching: positions ordered by candidate count then unique ordinal; candidates by workload then UUID; traversal-local visited sets permit reassignment. This guarantees a full roster when feasible, otherwise maximum-size partial coverage without duplicates. Alex (pilot+medical), Sam (pilot only) yields Sam→pilot and Alex→medical. Cost: O(P × E) after graph construction.

Workload = confirmed hours intersecting the mission start month's UTC boundaries, clipped to that month; include completed confirmed work, exclude tentative/released assignments. It is a preference, not a cap, actual-hours ledger, or globally optimal fairness. Cancellation removes the whole booking, including elapsed hours.

Show snapshot time/version, workload month/hours, roster, required/actual proficiency, availability, unfilled positions and exclusion/reassignment reasons. Distinguish no eligible candidate from candidates needed elsewhere. Matching never writes or pins existing proposals. Apply full suggestions atomically using their version; manual partial proposals are allowed, submission is not. Validate the final roster, withdraw replaced assignments before inserts to permit swaps, and retain unchanged consent.

## 3. Store only what is needed

- Organisations: unique immutable login slug, editable name. Users: tenant-unique normalised username, display name, password hash, fixed role. Sessions: token hash/expiry and tenant/user reference.
- Optional crew profiles: one per user, biography/active flag. Tenant skills: case-normalised unique names. Crew-skill joins: proficiency 1–5. Availability: intervals.
- Missions: immutable owner, title/brief, interval, state/version, creation time. Positions: mission, unique ordinal, label/removal time. Position-skill joins: minimum proficiency 1–5.
- Assignments: mission/position/crew, state, response time, nullable booked interval. Append-only mission events: actor/time/type, action-specific changes/reasons/consent details.

Use server-generated UUIDs, non-null tenant IDs and tenant-qualified FKs/uniqueness; skill joins use composite keys. Assignment/event references must also match their mission. Enforce required fields, valid enums/levels/intervals; cross-row eligibility/transitions belong in locked operations.

Partial unique indexes allow one current assignment per position and per crew/mission (`proposed`, `accepted`, `confirmed`). Booked interval exists exactly when confirmed, copied only at approval. PostgreSQL `btree_gist` exclusion prohibits confirmed overlap per tenant/crew.

Retain missions, accounts, assignments and events. Soft-remove draft positions, withdrawing their assignment and never reusing ordinals. Delete skills only if unreferenced. Index tenant lookup/search, states, crew and assignments; lists default to 25, maximum 100.

## 4. Implement and verify in order

Each slice includes migrations, API operations, CLI commands and focused tests.

| Slice | Build | Done when |
| --- | --- | --- |
| 1. Identity and crew | Setup; login/logout/whoami/password; organisation/member/crew/skill management; own skills/availability/history. | Two tenants/all roles work; foreign and same-tenant sibling references/private data are denied; expiry/revocation and password/login races pass. |
| 2. Planning and consent | Mission create/list/show/update/history; position add/update/remove; match/propose; assignment list/show/accept/decline/retract/remove. | Alex/Sam and impossible rosters behave correctly; small graphs match exhaustive cardinality; swaps, consent invalidation, stale versions and projections pass. |
| 3. Approval and operation | Submit/withdraw/approve/reject/cancel/complete; derived phase; atomic reservations. | Self-approval fails; competing approvals produce exactly one complete booking; profile races, start-crossing lock waits, frozen plans and late cancellation pass. |
| 4. Delivery | Representative seeds; setup/walkthrough; complete CLI flow and recovery; build/typecheck/tests. | Fresh setup works, restart preserves data/history, UTC boundary/adjacency/month clipping tests pass, and all workflows work without SQL/source knowledge. |

Expose JSON REST under `/v1`; CLI uses `mc` or `npm run mc --`. Help/list/show make names and IDs discoverable; mission show includes positions and visible assignments. Human output by default, `--json` for scripts, stderr/nonzero failures, confirmation for destructive commands (`--yes`). Mission/assignment reads return versions.

Errors include code/message, safe details, request ID, and recovery: 400 fix input/version; 401 login; 403 authorised account; 404 list visible resources; 409 refresh/withdraw/rematch; 422 correct identified positions/consent; 429 retry later. Creation POSTs are not idempotent: inspect lists/history after uncertain results before manually retrying.

## 5. Local delivery checklist

Provide `npm ci`, `.env.example`, PostgreSQL-only Compose, `db:migrate`, `db:seed`, `dev`, `mc`, `typecheck`, non-watch `test`, and `build`; document direct PostgreSQL as an alternative. Pin compatible versions, retain strict TypeScript/Node/ESM settings, remove JSX, and ignore secrets/build/OS files. Migration credentials install extensions; tests use a separate database and refuse non-test targets.

Seed Atlas/Boreal with differing crew sizes/catalogues, overlapping names, all roles, two Atlas Directors, a planner with a crew profile, Alex/Sam, unavailable/underqualified crew and varied workload. Cover all states, scheduled/active missions, accepted/declined/partial rosters, conflicts and adjacent intervals. Use stable IDs, a documented UTC anchor and injectable clock; refuse nonempty seeding except explicit local reset. Document local credentials and the complete CLI walkthrough/recovery.

Unit-test matching/time/transitions; use real PostgreSQL for permissions, constraints and races, plus CLI subprocess tests for the complete journey. Log request ID/route/status/latency/actor/tenant, never bodies/credentials. `/health` reports process/database readiness without tenant data.

Accepted limits: independent approval distinguishes trusted local accounts, not humans; skills are self-declared; read isolation relies on scoped queries, not RLS; matching memory grows with tenant size. Add production auth, account lifecycle controls, qualification verification, batching or global optimisation only when justified.
