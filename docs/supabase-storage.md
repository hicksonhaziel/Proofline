# Supabase Runtime Storage

Proofline uses Supabase as the production source of truth for autonomous runtime data.

## Setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run `supabase/schema.sql`.
4. Set these environment variables for the agent:

```bash
STORAGE_MODE=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

5. Set these environment variables for the Vercel dashboard:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Do not expose `SUPABASE_SERVICE_ROLE_KEY` to React or Vercel client-side code.

## Stored Runtime Records

- `sap_targets`: discovered SAP targets.
- `audit_jobs`: queued audit jobs.
- `discovery_runs`: discovery snapshots.
- `payment_receipts`: SAP, Ace, skipped, failed, and settled payment receipts.
- `proof_packets`: signed execution proof packets.
- `audit_runs`: audit run state and summaries.
- `scheduler_runs`: automation health and scheduler decisions.
- `commerce_sales`: future Phase 12 Proofline tool sales.
- `commerce_requests`: future Phase 12 buyer requests.

## File Mode

`STORAGE_MODE=file` remains available for local fallback and migration checks only. Production automation should use `STORAGE_MODE=supabase`.
