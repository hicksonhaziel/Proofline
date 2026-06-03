# Proofline

Proofline is an autonomous execution auditor for Synapse Agent Protocol agents. It discovers SAP agents and tools, checks them with Synapse Sentinel, routes payments through supported x402 or SAP escrow paths, analyzes results with Ace Data Cloud, and publishes signed Execution Proof Packets backed by receipts, scores, and risk flags.

The project is built for the OOBE Protocol x Ace Data Cloud bounty, with the primary category focused on Ace Data Cloud usage through x402.

## What Proofline Does

Autonomous agent marketplaces need proof that tools actually work after payment. Proofline creates that proof.

Each audit cycle can:

1. Discover SAP agents and payment metadata.
2. Filter unsafe, incomplete, expensive, or recently audited targets.
3. Run Synapse Sentinel preflight checks.
4. Attempt the supported payment route.
5. Probe the target endpoint.
6. Use Ace Data Cloud services for analysis.
7. Score reliability, capability match, payment integrity, public footprint, and safety.
8. Sign an Execution Proof Packet with the Proofline Solana keypair.
9. Store all runtime records in Supabase.
10. Display evidence on the Vercel dashboard.

## Live Architecture

```text
GitHub Actions cron
  -> npm run sap:discover
  -> npm run agent:once
  -> writes discovery, jobs, payments, proofs, scheduler state
  -> Supabase

Vercel
  -> React dashboard
  -> /x402 seller metadata and proof-query routes
  -> reads/writes Supabase where needed

Supabase
  -> source of truth for autonomous runtime data
```

`/data` is no longer the production source of truth. It remains only for explicit `STORAGE_MODE=file` fallback, legacy local utilities, and debugging.

## Main Components

- `apps/agent`: autonomous discovery, scheduler, audit, payment, Ace analysis, validation, and buyer demo scripts.
- `apps/web`: React + Tailwind dashboard.
- `api/x402`: Vercel serverless routes for Proofline seller tools.
- `packages/core`: shared scoring, proof packet, and metadata types.
- `packages/db`: Supabase/file runtime storage layer.
- `packages/integrations`: Ace, Sentinel, and SAP integration helpers.
- `supabase/schema.sql`: production database schema.
- `.github/workflows/agent-cron.yml`: online autonomous cron runner.

## Execution Proof Packets

An Execution Proof Packet is a signed JSON artifact describing one audit. It includes:

- target agent and tool metadata
- audit job state
- Sentinel result
- payment receipts
- probe result
- Ace analysis
- score breakdown
- risk flags
- artifact references
- timestamp
- Ed25519 signature from the Proofline Solana keypair

Proof signatures can be checked with:

```bash
npm run proofs:verify
```

## Dashboard

The Vercel dashboard reads Supabase and exposes:

- `/live`: latest audit
- `/proofs`: evidence ledger
- `/proofs/:proofId`: proof detail
- `/payments`: payment receipt view
- `/ace`: Ace usage summary
- `/commerce`: Proofline seller activity
- `/health`: scheduler and automation health
- `/x402`: Proofline seller metadata

## Phase 12 Commerce

Proofline also exposes purchasable proof tools:

- `get_execution_verdict`
- `get_execution_proof`
- `request_fresh_audit`
- `list_recent_proofs`

Routes:

```text
/x402/get_execution_verdict
/x402/get_execution_proof
/x402/request_fresh_audit
/x402/list_recent_proofs
```

Commerce records are written to Supabase tables:

- `commerce_sales`
- `commerce_requests`

Important: inbound Proofline seller x402 settlement verification is not implemented yet. If a buyer sends an `X-PAYMENT` header, Proofline records it as `pending`, not `settled`, unless a real verified transaction hash exists in a future implementation.

## Ace Data Cloud x402

Proofline uses Ace Data Cloud without an API key in bounty x402 mode:

1. The agent calls Ace API.
2. Ace returns HTTP `402 Payment Required`.
3. Proofline parses the quote.
4. In dry-run mode, Proofline records the quote only.
5. In send mode, Proofline signs `X-PAYMENT` using `ACE_X402_WALLET_KEY`.
6. Proofline retries the same request.
7. The Ace response and x402 receipt metadata are stored in the proof packet.

Supported Ace services currently used by the audit pipeline include:

- Google search via Ace SERP
- OpenAI chat completions
- localization/translation
- image edit/generation for proof-card evidence

## Storage

Production storage mode:

```env
STORAGE_MODE=supabase
```

Main Supabase tables:

- `sap_targets`
- `audit_jobs`
- `discovery_runs`
- `payment_receipts`
- `proof_packets`
- `audit_runs`
- `scheduler_runs`
- `commerce_sales`
- `commerce_requests`

Run the schema before production use:

```sql
-- Supabase SQL editor
-- paste and run supabase/schema.sql
```

## Running Locally

Install:

```bash
npm install
```

Build:

```bash
npm run build
```

Run the dashboard locally:

```bash
npm run web:dev
```

Run one safe autonomous cycle:

```bash
PAYMENT_MODE=dry-run PAYMENT_CONFIRM_SPEND=false npm run agent:once
```

Run discovery only:

```bash
npm run sap:discover
```

Run the online validation suite:

```bash
npm run phase13:validate
```

## Useful Scripts

```bash
npm run build
npm run sap:discover
npm run agent:once
npm run agent:once:no-ace
npm run audit:once -- --allow-paid --target "chainbard"
npm run ace:x402:smoke
npm run commerce:buyer-demo -- --tool get_execution_verdict
npm run phase13:validate
```

## Required Environment Variables

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full setup.

Core agent variables:

```env
STORAGE_MODE=supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SOLANA_RPC_URL=
SYNAPSE_RPC_URL=
SAP_KEYPAIR_BASE64=
SENTINEL_AGENT_ID=
ACE_X402_WALLET_KEY=
PROOFLINE_PUBLIC_BASE_URL=
```

Frontend variables:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

Never expose `SUPABASE_SERVICE_ROLE_KEY`, `SAP_KEYPAIR_BASE64`, or `ACE_X402_WALLET_KEY` in frontend `VITE_` variables.

## Safety Defaults

Proofline defaults to dry-run payment behavior unless explicitly configured otherwise.

Safe mode:

```env
PAYMENT_MODE=dry-run
PAYMENT_CONFIRM_SPEND=false
```

Paid mode:

```env
PAYMENT_MODE=send
PAYMENT_CONFIRM_SPEND=true
```

Keep budget caps low:

```env
MAX_SPEND_PER_AUDIT_USDC=0.35
MAX_SPEND_PER_HOUR_USDC=2.00
MAX_SPEND_PER_DAY_USDC=10.00
```

## Validation Status

Phase 13 validation currently checks:

- scoring formulas
- proof packet validation
- Supabase runtime readiness
- Supabase table counts
- latest proof signature verification
- Vercel route availability
- Phase 12 buyer verdict route

Run:

```bash
npm run phase13:validate
```

## Known Limitations

- Inbound Proofline seller x402 settlement verification is not implemented yet.
- Buyer `X-PAYMENT` headers sent to Proofline seller routes are recorded as `pending`, not `settled`.
- Generic non-Ace x402 send mode is intentionally blocked until a verified settlement path is added.
- SAP escrow automation currently supports only safe SOL-priced targets.
- USDC escrow targets that failed simulation remain skipped.
- Real paid mode should be enabled only after dry-run cron, dashboard, Supabase writes, and validation pass.

## Bounty Demo Summary

Proofline demonstrates a complete autonomous workflow:

```text
GitHub Actions trigger
  -> discover SAP targets
  -> select target
  -> Sentinel preflight
  -> payment quote or supported payment path
  -> probe execution
  -> Ace x402 analysis
  -> signed proof packet
  -> Supabase persistence
  -> Vercel dashboard update
```

Primary category: Ace Data Cloud Usage.

