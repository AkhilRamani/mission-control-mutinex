# Assumptions and design deviations

Through completion/review, **24 October 2026**. [DESIGN.md](DESIGN.md) is the preserved pre-implementation blueprint; its “implementation has not started” wording is historical. Future product changes require agreement and an entry here.

## Agreed clarification

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

Independent approval, frozen plans, consent invalidation, atomic booking exclusion and private Crew history remain as designed. Late cancellation was agreed before implementation and is already in the blueprint, not a departure.

For verification commands and limits, see [README](README.md#verify-and-maintain). This record does not imply production security, load or cross-platform certification.
