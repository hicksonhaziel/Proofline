# Proofline Deployment Guide

This guide explains how to run Proofline as an online autonomous agent using:

- Supabase as the production database
- GitHub Actions as the cron runner
- Vercel as the dashboard and seller API host

## 1. Supabase Setup

Create a Supabase project, then run the schema:

1. Open Supabase dashboard.
2. Select the Proofline project.
3. Open SQL Editor.
4. Paste `supabase/schema.sql`.
5. Run it.

Required tables:

```text
sap_targets
audit_jobs
discovery_runs
payment_receipts
proof_packets
audit_runs
scheduler_runs
commerce_sales
commerce_requests
```

Get these values from Supabase:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

The service role key is server-only. Do not expose it in React or any `VITE_` variable.

## 2. Vercel Setup

Connect the GitHub repo to Vercel.

Build settings:

```text
Build command: npm run web:build
Output directory: apps/web/dist
```

These are already configured in `vercel.json`.

### Vercel Environment Variables

Add these to Vercel:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
PROOFLINE_PUBLIC_BASE_URL=https://proofline-hq.vercel.app
```

Why Vercel needs both frontend and server vars:

- `VITE_SUPABASE_*` is used by the React dashboard to read public runtime data.
- `SUPABASE_*` is used by Vercel API routes under `/x402/*` to record commerce sales and requests.

Do not add these to Vercel as frontend variables:

```env
SAP_KEYPAIR_BASE64
ACE_X402_WALLET_KEY
SOLANA_RPC_URL
SYNAPSE_RPC_URL
```

Those belong in GitHub Actions because GitHub runs the autonomous agent.

## 3. GitHub Actions Setup

Proofline uses `.github/workflows/agent-cron.yml`.

It runs:

```bash
npm ci
npm run build
npm run sap:discover
npm run agent:once
```

The workflow runs every 30 minutes and can also be triggered manually.

### GitHub Secrets

Open:

```text
GitHub repo -> Settings -> Secrets and variables -> Actions -> Secrets
```

Add:

```env
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SOLANA_RPC_URL
SYNAPSE_RPC_URL
SAP_KEYPAIR_BASE64
SENTINEL_AGENT_ID
ACE_X402_WALLET_KEY
```

Create `SAP_KEYPAIR_BASE64` from the Solana keypair JSON:

```bash
base64 -w0 /home/hickson/.config/solana/proofline-mainnet.json
```

Paste the output as the `SAP_KEYPAIR_BASE64` secret.

### GitHub Variables

Open:

```text
GitHub repo -> Settings -> Secrets and variables -> Actions -> Variables
```

Start with:

```env
PAYMENT_MODE=dry-run
PAYMENT_CONFIRM_SPEND=false
```

Keep these values until the full online dry-run has passed.

## 4. First Online Dry Run

Push the code to GitHub.

Then open:

```text
GitHub -> Actions -> Proofline Agent Cron -> Run workflow
```

Expected result:

```text
agent-once: succeeded
```

The run should:

- build the repo
- discover SAP targets
- write discovery records to Supabase
- run one audit cycle
- write scheduler state to Supabase
- write proof packets and receipts to Supabase

No funds are spent when:

```env
PAYMENT_MODE=dry-run
PAYMENT_CONFIRM_SPEND=false
```

## 5. Verify Supabase

After the GitHub Action succeeds, check Supabase table counts:

```text
discovery_runs > 0
sap_targets > 0
audit_jobs > 0
scheduler_runs > 0
payment_receipts > 0
proof_packets > 0
audit_runs > 0
```

Commerce tables may be empty until buyer demo routes are called:

```text
commerce_sales
commerce_requests
```

## 6. Verify Vercel

After Vercel redeploys, open:

```text
https://proofline-hq.vercel.app
https://proofline-hq.vercel.app/live
https://proofline-hq.vercel.app/proofs
https://proofline-hq.vercel.app/payments
https://proofline-hq.vercel.app/ace
https://proofline-hq.vercel.app/commerce
https://proofline-hq.vercel.app/health
https://proofline-hq.vercel.app/x402
```

Expected:

- dashboard loads
- `/health` shows the latest scheduler state
- `/proofs` shows Supabase proof packets
- `/commerce` shows Proofline seller activity when buyer demo has run
- `/x402` returns `merchant-ready` metadata

## 7. Phase 12 Buyer Demo

After Vercel is deployed:

```bash
npm run commerce:buyer-demo -- --tool get_execution_verdict
npm run commerce:buyer-demo -- --tool get_execution_proof
npm run commerce:buyer-demo -- --tool get_execution_verdict --send-payment-header
```

Meaning:

- without `--send-payment-header`: records a demo buyer call with `paymentStatus=skipped`
- with `--send-payment-header`: records a captured payment header with `paymentStatus=pending`

`pending` is intentional. Proofline does not yet verify inbound x402 settlement for its own seller endpoints.

## 8. Phase 13 Validation

Run:

```bash
npm run phase13:validate
```

This checks:

- scoring formulas
- proof packet validation
- Supabase readiness
- Supabase runtime records
- latest proof signature
- Vercel routes
- buyer verdict route

It does not spend funds.

## 9. Switching To Paid Ace x402 Mode

Only switch after:

- GitHub Actions dry-run succeeds
- Vercel dashboard shows Supabase data
- `/x402` routes work
- `npm run phase13:validate` passes
- Base USDC wallet has only the amount you are comfortable spending

Then update GitHub Variables:

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

Paid mode lets Proofline sign Ace Data Cloud x402 payments with:

```env
ACE_X402_WALLET_KEY
```

Do not enable paid mode if the wallet contains more funds than you are prepared to spend.

## 10. Environment Variable Reference

### Agent and GitHub Actions

```env
STORAGE_MODE=supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SOLANA_RPC_URL=
SYNAPSE_RPC_URL=
SAP_KEYPAIR_BASE64=
SENTINEL_AGENT_ID=
ACE_API_KEY=
ACE_X402_WALLET_KEY=
ACE_X402_FACILITATOR_URL=https://facilitator.acedata.cloud
PROOFLINE_PUBLIC_BASE_URL=https://proofline-hq.vercel.app
PROOFLINE_AGENT_URI=https://proofline-hq.vercel.app/agent.json
PROOFLINE_X402_ENDPOINT=https://proofline-hq.vercel.app/x402
AUDIT_INTERVAL_MINUTES=30
TARGET_AGENT_LIST=./data/targets.seed.json
MAX_SPEND_PER_AUDIT_USDC=0.35
MAX_SPEND_PER_HOUR_USDC=2.00
MAX_SPEND_PER_DAY_USDC=10.00
MIN_REAUDIT_INTERVAL_HOURS=24
ENABLE_SAP_DISCOVERY=true
ENABLE_SAP_ESCROW=false
ENABLE_ACE_IMAGE=true
ENABLE_ACE_TRANSLATION=true
ENABLE_ACE_AUDIO=false
PAYMENT_MODE=dry-run
PAYMENT_CONFIRM_SPEND=false
```

### Vercel Dashboard and API

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PROOFLINE_PUBLIC_BASE_URL=https://proofline-hq.vercel.app
```

### Local Development

Local development can use either:

```env
SAP_KEYPAIR_PATH=/home/hickson/.config/solana/proofline-mainnet.json
```

or:

```env
SAP_KEYPAIR_BASE64=
```

## 11. Troubleshooting

### GitHub Action Fails With Missing Keypair

Add `SAP_KEYPAIR_BASE64` as a GitHub secret.

### Dashboard Shows No Data

Check Vercel env:

```env
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

Then redeploy Vercel.

### `/x402/get_execution_verdict` Returns Supabase Error

Check Vercel server env:

```env
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Then redeploy Vercel.

### Commerce Page Shows Pending Payments

This is expected when `--send-payment-header` is used. Proofline currently records inbound payment headers as pending because inbound seller-side x402 settlement verification is not implemented yet.

### Ace Calls Show 402 Quotes But No Settlement

That is expected in dry-run mode:

```env
PAYMENT_MODE=dry-run
PAYMENT_CONFIRM_SPEND=false
```

Switching to send mode is required for real settlement.

### Sentinel Blocks A Target

That is expected when the target or Sentinel endpoint is unreachable. Proofline records a skipped proof instead of forcing a paid call.

## 12. Known Limitations

- Inbound Proofline seller x402 settlement verification is not implemented yet.
- Generic non-Ace x402 send mode remains blocked.
- SAP USDC escrow targets that failed simulation remain skipped.
- Paid mode should be used only for controlled tests with low wallet balances and strict spend caps.

