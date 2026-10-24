# Assumptions and design deviations

Through completion/review, **24 October 2026**. [DESIGN.md](DESIGN.md) is the preserved pre-implementation blueprint; its “implementation has not started” wording is historical. See [README](README.md) for operation, [SCHEMA](SCHEMA.md) for storage and [WALKTHROUGH](WALKTHROUGH.md) for examples. Future product changes require agreement and an entry here.

## Agreed decisions

- **Baseline consolidation:** user-approved immutable ownership, session deletion, direct matching, composite skill keys and simple CLI/events were incorporated before implementation.
- **Late cancellation:** user-approved cancellation until explicit completion is already in the baseline. It releases the whole booking/workload, including elapsed hours.
- **Empty submission (step 5 clarification):** requires ≥1 active position; empty drafts remain valid. Empty/incomplete rosters return `INCOMPLETE_ROSTER`; missing acceptance returns `CONSENT_REQUIRED`.

## Implementation choices and limits

These fill implementation details, not new product approvals.

| Area | Choice / trade-off |
| --- | --- |
| Accounts | One tenant/role; manual provisioning/password sharing; no forced reset/account disable. Crew deactivation affects staffing only. Independence compares approver with creator, not roster: an assigned Director may approve another account’s mission. Distinct accounts are trusted as distinct people. |
| Authentication | Login/password changes share ten attempts/minute/process, bounding hashing without a shared store. Restart clears the shared budget. Sessions expire after 24 hours; expired rows have no cleanup job. |
| CLI | One session/config directory; separate directories allow parallel sessions, otherwise logout/login to switch. Unix ownership/permissions, no keychain; Windows protection unverified. |
| Concurrency | Mission/assignment writes require reviewed versions; locked profile edits use last-write-wins. Offset lists expose `nextOffset`, no totals or cross-page snapshot; concurrent edits can shift pages. |
| Recovery | Availability permits overlapping/adjacent/duplicate windows, using their union. No creation idempotency keys or automatic write retries; inspect lists/history after uncertain responses. |
| Matching | Maximum coverage, not optimal workload/fairness; suggestions do not pin existing choices. API supports empty replacement rosters; CLI removes assignments individually. |
| Time | Real PostgreSQL time after locks guards writes; API host time displays phases. Clocks are assumed aligned. Tests inject seed dates/adjust fixtures; no production clock override. |
| Seeds | Stable IDs, dates relative to seed UTC midnight; demos age. Focused tests use smaller fixed fixtures. Historical missions/events are inserted atomically because live approval rejects past starts. Nonempty databases are refused; no reset flag. |
| Operation | Loopback API/database, separate migration/runtime roles, resets restricted to the named local test database. Remote CLI requires HTTPS; deployment, TLS termination, backups and production identity are excluded. |

## Implementation departures

- Four blueprint slices became [seven verifiable steps](IMPLEMENTATION-PLAN.md), with unchanged scope/workflow.
- Tenant/relationship indexes support scoped access, but substring search scans tenant rows without text/trigram indexes. This narrows “index search” to keep storage simple; large-tenant performance is unverified.
- Mission code follows workflows: `shared.ts` owns reads/permissions; `changes.ts` owns consent/snapshots/events. Shared validators and clearer helper names added no services, dependencies, persistence layers or business rules.

No other workflow/isolation departure was identified. Independent approval, frozen plans, consent invalidation, atomic booking exclusion and private Crew history remain as designed. RLS, configurable workflows, partial capacity and global matching optimisation remain baseline exclusions.

## Verification

**114 tests, typecheck and build passed** after the final refactor. Coverage includes PostgreSQL isolation/references, ownership, consent, approval, booking races, rollback and lifecycle boundaries; exhaustive small-graph matcher comparisons; real CLI decline/rejection/conflict recovery and persistence. Fresh setup and compiled API/CLI checks also verified API/PostgreSQL restarts.

Verification was local and functional/concurrent; production security, load and cross-platform certification remain unverified.
