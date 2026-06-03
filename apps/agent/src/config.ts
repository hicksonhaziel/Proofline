import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

export interface ProoflineConfig {
  storageMode: "supabase" | "file";
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  solanaRpcUrl: string;
  synapseRpcUrl: string;
  sapKeypairPath: string;
  sentinelAgentId: string;
  aceApiKey: string | undefined;
  aceX402WalletKey: string | undefined;
  aceX402FacilitatorUrl: string | undefined;
  publicBaseUrl: string;
  prooflineAgentUri: string | undefined;
  prooflineX402Endpoint: string | undefined;
  auditIntervalMinutes: number;
  targetAgentList: string;
  limits: {
    maxSpendPerAuditUsdc: number;
    maxSpendPerHourUsdc: number;
    maxSpendPerDayUsdc: number;
    minReauditIntervalHours: number;
  };
  flags: {
    enableSapDiscovery: boolean;
    enableSapEscrow: boolean;
    enableAceImage: boolean;
    enableAceTranslation: boolean;
    enableAceAudio: boolean;
  };
}

export function loadConfig(): ProoflineConfig {
  const protectedEnv = new Set(Object.keys(process.env));
  loadDotenvFile(".env", protectedEnv);
  loadDotenvFile(".env.local", protectedEnv);

  const missing = requiredEnvNames().filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    storageMode: storageModeEnv(),
    supabaseUrl: optionalEnv("SUPABASE_URL"),
    supabaseServiceRoleKey: optionalEnv("SUPABASE_SERVICE_ROLE_KEY"),
    solanaRpcUrl: env("SOLANA_RPC_URL"),
    synapseRpcUrl: env("SYNAPSE_RPC_URL"),
    sapKeypairPath: optionalEnv("SAP_KEYPAIR_PATH") ?? "",
    sentinelAgentId: env("SENTINEL_AGENT_ID"),
    aceApiKey: optionalEnv("ACE_API_KEY"),
    aceX402WalletKey: optionalEnv("ACE_X402_WALLET_KEY"),
    aceX402FacilitatorUrl: optionalEnv("ACE_X402_FACILITATOR_URL"),
    publicBaseUrl: env("PROOFLINE_PUBLIC_BASE_URL"),
    prooflineAgentUri: optionalEnv("PROOFLINE_AGENT_URI"),
    prooflineX402Endpoint: optionalEnv("PROOFLINE_X402_ENDPOINT"),
    auditIntervalMinutes: numberEnv("AUDIT_INTERVAL_MINUTES", 30),
    targetAgentList: env("TARGET_AGENT_LIST"),
    limits: {
      maxSpendPerAuditUsdc: numberEnv("MAX_SPEND_PER_AUDIT_USDC", 0.25),
      maxSpendPerHourUsdc: numberEnv("MAX_SPEND_PER_HOUR_USDC", 2),
      maxSpendPerDayUsdc: numberEnv("MAX_SPEND_PER_DAY_USDC", 10),
      minReauditIntervalHours: numberEnv("MIN_REAUDIT_INTERVAL_HOURS", 24),
    },
    flags: {
      enableSapDiscovery: booleanEnv("ENABLE_SAP_DISCOVERY", false),
      enableSapEscrow: booleanEnv("ENABLE_SAP_ESCROW", false),
      enableAceImage: booleanEnv("ENABLE_ACE_IMAGE", true),
      enableAceTranslation: booleanEnv("ENABLE_ACE_TRANSLATION", true),
      enableAceAudio: booleanEnv("ENABLE_ACE_AUDIO", false),
    },
  };
}

export function safeConfigSummary(config: ProoflineConfig): Record<string, unknown> {
  return {
    solanaRpcUrl: maskUrl(config.solanaRpcUrl),
    synapseRpcUrl: maskUrl(config.synapseRpcUrl),
    sapKeypairPath: config.sapKeypairPath,
    sentinelAgentId: config.sentinelAgentId,
    aceApiKey: maskSecret(config.aceApiKey),
    aceX402WalletKey: maskSecret(config.aceX402WalletKey),
    aceX402FacilitatorUrl: config.aceX402FacilitatorUrl ? maskUrl(config.aceX402FacilitatorUrl) : undefined,
    storageMode: config.storageMode,
    supabaseUrl: config.supabaseUrl ? maskUrl(config.supabaseUrl) : undefined,
    supabaseServiceRoleKey: maskSecret(config.supabaseServiceRoleKey),
    publicBaseUrl: config.publicBaseUrl,
    prooflineAgentUri: config.prooflineAgentUri,
    prooflineX402Endpoint: config.prooflineX402Endpoint ? maskUrl(config.prooflineX402Endpoint) : undefined,
    auditIntervalMinutes: config.auditIntervalMinutes,
    targetAgentList: config.targetAgentList,
    limits: config.limits,
    flags: config.flags,
  };
}

function loadDotenvFile(fileName: string, protectedEnv: Set<string>): void {
  const path = resolve(fileName);

  if (existsSync(path)) {
    const parsed = parseDotenv(readFileSync(path, "utf8"));

    for (const [name, value] of Object.entries(parsed)) {
      if (protectedEnv.has(name)) continue;
      process.env[name] = value;
    }
  }
}

function requiredEnvNames(): string[] {
  const names = [
    "SOLANA_RPC_URL",
    "SYNAPSE_RPC_URL",
    "SENTINEL_AGENT_ID",
    "PROOFLINE_PUBLIC_BASE_URL",
    "TARGET_AGENT_LIST",
  ];
  if (!process.env.SAP_KEYPAIR_PATH && !process.env.SAP_KEYPAIR_JSON && !process.env.SAP_KEYPAIR_BASE64) {
    names.push("SAP_KEYPAIR_PATH");
  }
  if (storageModeEnv() === "supabase") {
    names.push("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
  }
  return names;
}

function env(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }

  return parsed;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

function storageModeEnv(): ProoflineConfig["storageMode"] {
  const value = process.env.STORAGE_MODE?.toLowerCase();
  if (!value) return "supabase";
  if (value === "supabase" || value === "file") return value;
  throw new Error("Environment variable STORAGE_MODE must be either supabase or file");
}

function maskSecret(value: string | undefined): string {
  return value && value.length > 0 ? "[set]" : "[missing]";
}

function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.search.length > 0) {
      url.search = "?...";
    }

    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }

    return url.toString();
  } catch {
    return maskSecret(value);
  }
}
