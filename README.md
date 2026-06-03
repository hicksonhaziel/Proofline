# Proofline

**Autonomous paid execution auditor for SAP agents.**

[![Runtime](https://img.shields.io/badge/runtime-Node.js%2022-111827)](#)
[![Frontend](https://img.shields.io/badge/frontend-React%20%2B%20Tailwind-2563eb)](#)
[![Storage](https://img.shields.io/badge/storage-Supabase-16a34a)](#)
[![Automation](https://img.shields.io/badge/automation-GitHub%20Actions-111827)](#)
[![Payments](https://img.shields.io/badge/payments-x402%20%2B%20SAP%20escrow-f59e0b)](#)
[![AI](https://img.shields.io/badge/AI-Ace%20Data%20Cloud-7c3aed)](#)

Proofline discovers Synapse Agent Protocol agents, checks them with Synapse Sentinel, pays or quotes supported payment routes, probes tool delivery, analyzes outputs with Ace Data Cloud, and publishes signed Execution Proof Packets that make autonomous agent activity easier to verify.

Built for the OOBE Protocol x Ace Data Cloud bounty. Primary category: **Ace Data Cloud Usage**.

## Links

- Live dashboard: `https://proofline-hq.vercel.app`
- SAP agent page: `https://proofline-hq.vercel.app/agent.json`
- Demo video: `TODO`
- Presentation / walkthrough: `TODO`


## Why Proofline Exists

Autonomous agents can discover tools and spend money without a human in the loop. That creates a trust problem: before one agent pays another, it needs evidence that the target tool is real, reachable, priced clearly, and able to deliver useful output after payment.

Proofline solves that by acting as an autonomous audit runner for the SAP economy. It does not only list agents. It performs paid or payment-aware execution checks and produces replayable evidence.

## What It Produces

Every audit produces an **Execution Proof Packet**: a signed JSON evidence record containing:

- target agent and tool metadata
- Sentinel preflight result
- payment receipts or x402 quotes
- probe request and response evidence
- Ace Data Cloud analysis
- score breakdown
- risk flags
- artifact references
- timestamp
- Ed25519 signature from the Proofline Solana keypair

These packets power the public dashboard and can be sold back to other agents through Proofline’s own proof-query tools.

## System Flow

```text
                    ┌──────────────────────┐
                    │ GitHub Actions Cron  │
                    │ every 30 minutes     │
                    └──────────┬───────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────┐
│                    Proofline Agent                       │
│  discover -> filter -> Sentinel -> pay/quote -> probe    │
│              -> Ace analysis -> score -> sign            │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐       ┌───────────────────────────┐
│      Supabase        │◄──────│ Vercel x402 API Routes    │
│ runtime source       │       │ proof/verdict commerce    │
│ of truth             │       └───────────────────────────┘
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Vercel Dashboard     │
│ live evidence UI     │
└──────────────────────┘
```

## Core Capabilities

- SAP agent discovery through Synapse/SAP metadata.
- Target filtering for price, endpoint quality, missing metadata, repeated audits, and unsupported routes.
- Synapse Sentinel preflight before tool execution.
- x402 payment quote capture and Ace Data Cloud x402 signing in paid mode.
- SAP escrow planning and guarded SOL escrow support where simulation is safe.
- Ace Data Cloud analysis across search, chat, translation, and image proof-card generation.
- Signed Execution Proof Packets stored in Supabase.
- Public dashboard for proofs, payments, Ace usage, system health, and commerce activity.
- Proofline seller tools for other agents to request proof/verdict data.
- GitHub Actions cron for online autonomous operation.

## Dashboard Routes

```text
/live        latest audit
/proofs      evidence ledger
/payments    payment receipts
/ace         Ace Data Cloud usage
/commerce    Proofline seller activity
/health      scheduler and automation health
/x402        Proofline tool metadata
```

## Proofline x402 Tools

Proofline exposes merchant-style proof tools:

```text
GET  /x402/get_execution_verdict
GET  /x402/get_execution_proof
POST /x402/request_fresh_audit
GET  /x402/list_recent_proofs
```

Commerce calls are recorded in Supabase. Inbound buyer `X-PAYMENT` headers are currently recorded as `pending` unless a verified transaction hash exists. Proofline does not falsely mark seller-side payments as settled before facilitator verification is implemented.

## Data Model

Supabase is the production source of truth.

Main tables:

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

The schema lives in:

```text
supabase/schema.sql
```

## Automation

The online runner lives in:

```text
.github/workflows/agent-cron.yml
```

It runs:

```bash
npm ci
npm run build
npm run sap:discover
npm run agent:once
```

The workflow is intentionally controlled by GitHub variables:

```env
PAYMENT_MODE=dry-run
PAYMENT_CONFIRM_SPEND=false
```

Paid mode must be enabled explicitly.

## Quick Start

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

Run discovery:

```bash
npm run sap:discover
```

Run one safe audit cycle:

```bash
PAYMENT_MODE=dry-run PAYMENT_CONFIRM_SPEND=false npm run agent:once
```

Run validation:

```bash
npm run test:online
```

Full deployment steps are in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Important Scripts

```bash
npm run build
npm run sap:discover
npm run agent:once
npm run audit:once -- --allow-paid --target "chainbard"
npm run ace:x402:smoke
npm run commerce:buyer-demo -- --tool get_execution_verdict
npm run commerce:buyer-demo -- --tool get_execution_proof
npm run test:online
```

## Environment Overview

Agent and cron secrets:

```env
STORAGE_MODE=supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SOLANA_RPC_URL=
SYNAPSE_RPC_URL=
SAP_KEYPAIR_BASE64=
SENTINEL_AGENT_ID=
ACE_X402_WALLET_KEY=
```

Vercel dashboard variables:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

Vercel server API variables:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PROOFLINE_PUBLIC_BASE_URL=
```

Never expose server secrets through `VITE_` variables.

## Payment Safety

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

Budget caps:

```env
MAX_SPEND_PER_AUDIT_USDC=0.35
MAX_SPEND_PER_HOUR_USDC=2.00
MAX_SPEND_PER_DAY_USDC=10.00
```

Keep the payment wallet funded only with the amount you are comfortable spending.

## Validation

The validation script checks:

- scoring behavior
- proof packet validation
- Supabase readiness
- runtime table counts
- latest proof packet signature
- Vercel dashboard routes
- Proofline buyer verdict route

Run:

```bash
npm run test:online
```

## Current Limitations

- Proofline’s own seller-side x402 routes record inbound payment headers but do not yet verify/settle them through a facilitator.
- Generic non-Ace x402 send mode is blocked until a verified settlement path is added.
- SAP escrow automation is guarded and only allowed for routes that pass simulation and safety checks.
- Dry-run mode records Ace x402 quotes but does not spend USDC.

## Submission Positioning

Proofline is not a passive agent directory. It is an autonomous proof-of-execution layer for SAP agents.

It creates legitimate activity because every run has a clear audit purpose, a stored proof packet, and a public dashboard record.
