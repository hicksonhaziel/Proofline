import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export interface ProoflineConfig {
  solanaRpcUrl: string;
  synapseRpcUrl: string;
  sapKeypairPath: string;
  sentinelAgentId: string;
  aceApiKey: string;
  aceX402WalletKey: string;
  aceX402FacilitatorUrl: string | undefined;
  publicBaseUrl: string;
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
  loadDotenvFile(".env");
  loadDotenvFile(".env.local");

  const missing = requiredEnvNames().filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    solanaRpcUrl: env("SOLANA_RPC_URL"),
    synapseRpcUrl: env("SYNAPSE_RPC_URL"),
    sapKeypairPath: env("SAP_KEYPAIR_PATH"),
    sentinelAgentId: env("SENTINEL_AGENT_ID"),
    aceApiKey: env("ACE_API_KEY"),
    aceX402WalletKey: env("ACE_X402_WALLET_KEY"),
    aceX402FacilitatorUrl: optionalEnv("ACE_X402_FACILITATOR_URL"),
    publicBaseUrl: env("PROOFLINE_PUBLIC_BASE_URL"),
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
      enableAceTranslation: booleanEnv("ENABLE_ACE_TRANSLATION", false),
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
    publicBaseUrl: config.publicBaseUrl,
    auditIntervalMinutes: config.auditIntervalMinutes,
    targetAgentList: config.targetAgentList,
    limits: config.limits,
    flags: config.flags,
  };
}

function loadDotenvFile(fileName: string): void {
  const path = resolve(fileName);

  if (existsSync(path)) {
    loadDotenv({ path, override: true });
  }
}

function requiredEnvNames(): string[] {
  return [
    "SOLANA_RPC_URL",
    "SYNAPSE_RPC_URL",
    "SAP_KEYPAIR_PATH",
    "SENTINEL_AGENT_ID",
    "ACE_API_KEY",
    "ACE_X402_WALLET_KEY",
    "PROOFLINE_PUBLIC_BASE_URL",
    "TARGET_AGENT_LIST",
  ];
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

function maskSecret(value: string): string {
  return value.length > 0 ? "[set]" : "[missing]";
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
