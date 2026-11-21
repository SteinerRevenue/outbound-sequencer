# outbound-sequencer

The cold email system behind my campaigns: one Cloudflare Worker on a five-minute cron, a D1 database and sending inboxes driven through an inbox API. I built it to control when mail goes out, when it stops and what happens to every reply.

**My campaigns run at a 9.7% reply rate, a 5.3% positive reply rate and a 25% close rate.**

> Sanitized public copy. Brand names, addresses, phone numbers, domains and credentials are replaced with placeholders. This repository shows the system; it is not a hosted product.

## What it handles

| Stage | Guardrails and actions |
| --- | --- |
| Before sending | Approved batches only. Check suppression, prior contact and verification status for every prospect. |
| Scheduling | Recipient-local business hours, excluding weekends and public holidays. Per-inbox daily and hourly caps, ramp steps and randomized gaps. |
| Replies | Poll inbound mail, match it to a prospect, classify opt-outs, auto-replies, complaints and real replies, then route real replies to the operator. Matching handles address variants, forwarded copies and company-name matches. |
| Stops | Suppress opt-outs and hard bounces. Pause a lane or all cold sending on complaint language. Halt an inbox after too many bounces. |
| Oversight | Market-specific footer and legal address, placement seeds, and alerts for replies, holds and exceptions. |

## Architecture

```text
approved batch -> prospects + steps (D1)
                        |
five-minute cron -> slot planner -> guards -> inbox API -> sends + events (D1)
                        |           |
                        |           + window, ramp, gap, suppression, verification
                        |
                        + reply poller -> matcher -> classifier -> stop / hold / alert
```

The D1 schema covers inboxes, credentials, prospects, steps, attempts, sends, slots, inbound mail, suppression, events and seeds.

## Repository map

- `src/index.js`: Worker scheduler, guards, sender, reply poller, classifier and admin endpoints
- `schema.sql`: D1 schema
- `wrangler.example.jsonc`: deployment config template

## Deploy outline

1. Create a D1 database and apply `schema.sql`.
2. Copy `wrangler.example.jsonc` to `wrangler.jsonc` and add the database ID.
3. Add inbox OAuth credentials as Worker secrets.
4. Run `wrangler deploy`.

Production changes pass a test gate before deployment.

Built by [Nick Steiner](https://steinerrevenue.com) | Steiner Revenue
