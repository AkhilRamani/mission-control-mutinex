# Design deviations

## 2026-10-24: simplifications consolidated

At the user's explicit request, the agreed amendments were incorporated into `DESIGN.md`: one immutable owner field, deletion-based session revocation, direct matching queries, deterministic tie-breaking without a redundant key, composite skill keys, simple event/CLI handling, and four implementation slices. Product behaviour and security requirements are unchanged.

`DESIGN.md` is now the consolidated baseline; there are no outstanding amendments. No application implementation or runtime verification has occurred.

Record future departures here with date, affected rule, reason, change, impact, and verification. Obtain agreement for product behaviour changes; do not silently rewrite the baseline to match code.
