# Long comment investigation — 2026-10-23

Reported behavior: a POST body longer than about 90 characters copies the previous comment.

Inspected installation baseline: `289df81cd1afe64033fe9df3e5aabb883d22bbb0` from `/opt/paperclip`. The separate `/root/repos/paperclip-fork` checkout is a different revision.

The recovery presentation helper only reads the submitted body to derive a title and returns presentation metadata. The normal route passes `req.body.body` to `issueService.addComment`, which inserts the redacted submitted body. No evidence supports changing that helper.

## Live verification

On HU-3261, authenticated POST and subsequent GET both preserved exact bodies of 91, 161, and 1,024 characters. Each had a distinct ID and exactly one matching stored row:

| Characters | Comment ID |
| --- | --- |
| 91 | 4dbe44fc-e4d7-458d-b511-aec399495070 |
| 161 | d342d326-50f1-4cbe-b0f8-48abb9a69687 |
| 1024 | 0ed4fd82-1a4a-42ed-b3b6-c9e433bb65af |

The readback contained five comments: the original routing comment, a substantive progress comment (also preserved exactly), and the three length checks. No extra rows were returned.

## Regression coverage

Added a database-backed route test in `server/src/__tests__/issue-comment-redaction.test.ts`. It posts a previous-comment sentinel, then distinct bodies of 89, 90, 91, 160, 1,024, and 8,192 characters plus multiline text. It checks HTTP 201, exact returned bodies, unique IDs, exact database row count and bodies, and absence of soft deletions.

Initial sandbox execution skipped all five tests because embedded Postgres support was unavailable; a skip is not a passing regression result.

## Remaining evidence

ALG-3357 returns `Issue not found` to this company-scoped run. Its 22 reported soft-deleted duplicates and original requests could not be inspected. Need JARVIS to supply the original client request construction, raw request/response bodies with credentials removed, actor/run context, and cleanup evidence in the authorized issue. The live normal-agent route currently does not reproduce the reported failure. No speculative server fix was made.
