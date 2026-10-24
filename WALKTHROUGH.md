# CLI walkthrough

Start the API using [README.md](README.md#run-locally). All seeded passwords are `Local-mission-123!`. Run commands from the repository root. Replace angle-bracket placeholders with values printed by the CLI, not fixture IDs. Each successful change prints the new mission version; always review the latest version before writing.

## 1. Plan and match

```sh
npm run mc -- login --org atlas --username lead
npm run mc -- missions list --search 'Supply flight' --state draft
npm run mc -- missions show --mission <mission-id>
npm run mc -- missions match --mission <mission-id>
npm run mc -- missions propose --mission <mission-id> --version <version> --suggested
npm run mc -- logout
```

This draft starts four days after the seed date and already has Pilot and Medic positions. Matching assigns Sam to Pilot and Alex to Medic, preserving the scarce medical skill. Explanations identify unavailable/underqualified crew. To build a new plan instead, choose future timestamps within crew availability:

```sh
npm run mc -- missions create --title 'New supply run' --brief 'Deliver supplies' --start <future-start> --end <future-end>
npm run mc -- positions add --mission <new-id> --version 1 --label Pilot --requires piloting:3
npm run mc -- positions add --mission <new-id> --version 2 --label Medic --requires medical:3
```

Run these creation commands while logged in as Lead, then match/propose as above. Dates must include an offset, such as `2027-01-10T09:00:00Z`; use dates appropriate to your current clock.

## 2. Obtain personal consent

```sh
npm run mc -- login --org atlas --username sam
npm run mc -- assignments list --mine
npm run mc -- assignments show --assignment <assignment-id>
npm run mc -- assignments accept --assignment <assignment-id>
npm run mc -- logout
```

Select the proposed assignment for your mission, not a historical attempt. Repeat as `alex`. Interactive acceptance displays the exact plan and asks for confirmation. Scripts must supply the version returned by `assignments show` using `--version <version>`. Each response changes the mission version. Acceptance does not reserve time.

## 3. Submit and independently approve

```sh
npm run mc -- login --org atlas --username lead
npm run mc -- missions show --mission <mission-id>
npm run mc -- missions submit --mission <mission-id> --version <version>
npm run mc -- logout
npm run mc -- login --org atlas --username director
npm run mc -- missions approve --mission <mission-id>
npm run mc -- missions history --mission <mission-id>
```

Interactive approval displays the plan before confirmation. Scripts must review `missions show` and pass its version. Approval rechecks eligibility and reserves the entire roster atomically. A Director who created a mission must use `director2` for independent review.

## 4. Operate and close

`missions show` reports `scheduled`, then automatically `active`, then `awaiting_completion`. No activation command or background job is needed. After the scheduled end, the owner or a Director can complete it:

```sh
npm run mc -- missions show --mission <mission-id>
npm run mc -- missions complete --mission <mission-id> --version <version> --yes
npm run mc -- missions history --mission <mission-id>
```

For an immediate demonstration, discover the seeded **Awaiting completion** mission with `missions list --search 'Awaiting completion'`, then show/complete that ID. New missions cannot be completed early. An aborted mission can instead be cancelled before explicit completion, even if recorded late:

```sh
npm run mc -- missions cancel --mission <mission-id> --version <version> --reason 'Flight aborted' --yes
```

Completion retains bookings/workload; cancellation releases the whole booking. Both are final. Approved plans cannot be edited: cancel and create a replacement with fresh consent and approval. Restart the API or run `docker compose restart postgres`; show/history remain persisted. A temporary database restart can return 503; retry reads once healthy.

## Failures and recovery

| Try | Result and recovery |
| --- | --- |
| Crew uses `assignments decline --assignment <id> --version <version>` before submission | Submission fails `INCOMPLETE_ROSTER`. Lead reviews the mission, reproposes with `--suggested` (new attempt for declined crew), obtains consent, then submits. |
| Director uses `missions reject --mission <id> --version <version> --reason 'Revise plan' --yes` | Returns to draft and resets all consent. Lead revises if needed, obtains fresh acceptance and resubmits. |
| Approve seeded **Awaiting review** in Atlas | `CREW_CONFLICT`: **Scheduled supply flight** already reserves the same crew/time. Lead uses `missions withdraw --mission <id> --version <version> --reason 'Reschedule' --yes`, then `missions update --mission <id> --version <new-version> --start <free-future-start> --end <free-future-end>`. Match again, obtain fresh consent, submit and approve. Seed day +12 is free. |
| Match **Partial rescue** | Explained partial result: nobody qualifies for expert medical support. `--suggested` refuses incomplete teams. Revise the actual requirement or provision qualified, available crew; do not fabricate consent. |
| Repeat a command with an old version | `STALE_VERSION`: show the mission/assignment, inspect history, then explicitly retry only if still needed. Never blindly increment versions. |
| Creator approves their mission | `FORBIDDEN`: an independent Director must approve. |
| Crew accesses a peer profile, or Boreal uses an Atlas ID | `NOT_FOUND`, indistinguishable from a missing record. Use own/visible resources; changing IDs cannot bypass permissions. |
| Change an approved plan | `MISSION_FROZEN`: cancel and replace it. An early completion returns `MISSION_NOT_ENDED`. |

After an uncertain create response, inspect lists before retrying to avoid duplicates. On expired credentials, logout/login. The local authentication budget is ten attempts per minute across users; wait if switching roles repeatedly returns 429.

## Seed examples

Times are relative to midnight UTC on the seed date; normal missions run 09:00–17:00. Seeding refuses existing data. Rerunning it does not refresh old demos.

| Atlas mission | Day | Initial condition |
| --- | --- | --- |
| Supply flight | +4 | Empty roster, Pilot + Medic draft |
| Awaiting review / Scheduled supply flight | +2 | Submitted plan conflicts with approved booking |
| Adjacent return flight | +2, 17:00–21:00 | Approved pilot-only booking touches the earlier end without overlap |
| Active patrol | 0, full UTC day | Approved and active on seed day |
| Awaiting completion / Completed training | −1 / −3 | Ended approved mission / completed pilot-only mission |
| Cancelled survey | −2 | Late cancellation, released bookings |
| Consent pending / Declined survey | +5 / +6 | Accepted + proposed / declined + proposed |
| Partial rescue / Rejected plan | +7 / +8 | Unfillable expert position / rejected to draft, consent reset |

Boreal has its own **Supply flight** draft and **Awaiting review** submitted plan, each with one position requiring piloting and survival. Their matching crew and same-named records remain isolated. Atlas has five crew profiles, Boreal two; both have all three roles. Confirmed intervals, including completed work, drive the UTC start-month workload heuristic; totals depend on the seed date’s month boundary.
