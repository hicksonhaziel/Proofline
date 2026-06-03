create extension if not exists pgcrypto;

create table if not exists public.sap_targets (
  target_key text primary key,
  agent_id text not null,
  tool_id text not null,
  name text not null,
  status text,
  priority_score integer,
  payment_method text,
  currency text,
  endpoint text,
  source text,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create table if not exists public.audit_jobs (
  audit_job_id text primary key,
  target_key text,
  status text not null,
  max_spend_usdc numeric,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create table if not exists public.discovery_runs (
  discovery_run_id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null,
  total_candidates integer not null default 0,
  unique_targets integer not null default 0,
  provider_counts jsonb not null default '{}'::jsonb,
  provider_errors jsonb not null default '[]'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  payload jsonb not null
);

create table if not exists public.payment_receipts (
  payment_id text primary key,
  audit_job_id text not null,
  provider text not null,
  method text not null,
  amount text not null,
  currency text not null,
  recipient text,
  service text not null,
  status text not null,
  transaction_hash text,
  created_at timestamptz not null,
  confirmed_at timestamptz,
  payload jsonb not null
);

create table if not exists public.proof_packets (
  proof_packet_id text primary key,
  audit_job_id text not null,
  target_agent_id text not null,
  target_tool_id text not null,
  audit_status text not null,
  verdict text not null,
  overall_score integer not null,
  risk_flags text[] not null default '{}',
  proof_card_url text,
  packet_hash text,
  created_at timestamptz not null,
  payload jsonb not null
);

create table if not exists public.audit_runs (
  audit_job_id text primary key,
  proof_packet_id text,
  audit_status text,
  target_agent_id text,
  target_name text,
  verdict text,
  overall_score integer,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create table if not exists public.scheduler_runs (
  scheduler_run_id text primary key,
  status text not null,
  mode text,
  payment_mode text,
  current_cycle integer not null default 0,
  started_at timestamptz,
  updated_at timestamptz not null,
  stopped_at timestamptz,
  payload jsonb not null
);

create table if not exists public.commerce_sales (
  sale_id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  buyer_wallet text,
  tool_id text not null,
  proof_packet_id text,
  amount text not null,
  currency text not null,
  payment_method text not null,
  payment_status text not null,
  transaction_hash text,
  receipt jsonb,
  output jsonb
);

create table if not exists public.commerce_requests (
  request_id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  buyer_wallet text,
  requested_tool text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  status text not null,
  error text
);

create index if not exists sap_targets_status_idx on public.sap_targets (status);
create index if not exists sap_targets_agent_tool_idx on public.sap_targets (agent_id, tool_id);
create index if not exists audit_jobs_created_at_idx on public.audit_jobs (created_at desc);
create index if not exists payment_receipts_audit_job_idx on public.payment_receipts (audit_job_id);
create index if not exists payment_receipts_created_at_idx on public.payment_receipts (created_at desc);
create index if not exists proof_packets_created_at_idx on public.proof_packets (created_at desc);
create index if not exists scheduler_runs_updated_at_idx on public.scheduler_runs (updated_at desc);
create index if not exists commerce_sales_created_at_idx on public.commerce_sales (created_at desc);

do $$
declare
  realtime_table text;
begin
  foreach realtime_table in array array[
    'scheduler_runs',
    'audit_jobs',
    'payment_receipts',
    'proof_packets',
    'audit_runs'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = realtime_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', realtime_table);
    end if;
  end loop;
end $$;
