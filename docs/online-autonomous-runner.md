# Online Autonomous Runner

Proofline uses GitHub Actions as the cron runner and Supabase as the runtime database.

## GitHub Secrets

Add these repository secrets:

```bash
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SOLANA_RPC_URL
SYNAPSE_RPC_URL
SAP_KEYPAIR_BASE64
SENTINEL_AGENT_ID
ACE_X402_WALLET_KEY
```

`SAP_KEYPAIR_BASE64` should be the base64 encoding of the Solana keypair JSON file:

```bash
base64 -w0 /home/hickson/.config/solana/proofline-mainnet.json
```

## GitHub Variables

Keep these dry-run values until you intentionally allow spending:

```bash
PAYMENT_MODE=dry-run
PAYMENT_CONFIRM_SPEND=false
```

For a real paid run, set:

```bash
PAYMENT_MODE=send
PAYMENT_CONFIRM_SPEND=true
```

## Vercel Env

Frontend dashboard:

```bash
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

Server API routes for Phase 12 commerce:

```bash
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
PROOFLINE_PUBLIC_BASE_URL
```

Do not create any `VITE_` variable containing the service role key.

## Phase 12 Buyer Demo

After Vercel is deployed:

```bash
npm run commerce:buyer-demo -- --tool get_execution_verdict
npm run commerce:buyer-demo -- --tool get_execution_proof
npm run commerce:buyer-demo -- --tool get_execution_verdict --send-payment-header
```

`--send-payment-header` records a captured buyer payment header for the commerce demo. It is not claimed as settled unless a real transaction hash is present.
