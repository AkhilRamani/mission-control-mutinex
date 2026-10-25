# Recovering an interrupted mission proposal

Demo documentation for MySubscriptions. Related issue: #1. This checklist is a draft for review, not evidence of a production defect.

## After STALE_VERSION

1. Stop the write; do not retry automatically.
2. Show the mission again and inspect its history, current version, roster and consent.
3. Compare the current plan with the change you intended. A proposal replaces the whole roster; omitted pairs are withdrawn.
4. If the change is still needed and the mission is editable, make a deliberate proposal using the version you just reviewed.
5. Collect the required crew consent before submission. A changed draft can invalidate consent; a declined attempt needs a new proposal.
6. Submit only a fully accepted, eligible roster. Independent Director approval remains required.

## After a timeout or lost connection

The result may be uncertain. Inspect lists, the mission and its history before deciding whether another write is needed. Creates do not have idempotency keys, so replaying a create may duplicate work.

## State boundaries

Submitted plans are frozen. Withdrawal or rejection returns the plan to draft and resets consent. An approved mission needs cancellation and replacement for changes, with fresh consent and approval.

## Review still needed

- Walk through one stale-version response in the local seeded environment.
- Check the instructions against WALKTHROUGH.md and command help.
- Confirm that no step encourages automatic retries, consent reuse after invalidation, or bypassing approval.

References: [README](../../README.md), [CLI walkthrough](../../WALKTHROUGH.md).
