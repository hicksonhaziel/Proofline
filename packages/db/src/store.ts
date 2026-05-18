import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentTarget, ExecutionProofPacket } from "../../core/src/index.js";

export interface LocalStorePaths {
  targetsFile: string;
  proofPacketsDir: string;
  artifactsDir: string;
  runsDir: string;
}

export class LocalStore {
  constructor(private readonly paths: LocalStorePaths) {}

  async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.proofPacketsDir, { recursive: true }),
      mkdir(this.paths.artifactsDir, { recursive: true }),
      mkdir(this.paths.runsDir, { recursive: true }),
      mkdir(dirname(this.paths.targetsFile), { recursive: true }),
    ]);
  }

  async readSeedTargets(): Promise<AgentTarget[]> {
    const filePath = resolve(this.paths.targetsFile);
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error(`Seed targets file must contain an array: ${filePath}`);
    }

    return parsed.map((item, index) => parseTarget(item, index));
  }

  async writeRunState(runId: string, state: unknown): Promise<string> {
    const filePath = resolve(this.paths.runsDir, `${runId}.json`);
    await writeJson(filePath, state);
    return filePath;
  }

  async writeProofPacket(packet: ExecutionProofPacket): Promise<string> {
    const filePath = resolve(this.paths.proofPacketsDir, `${packet.proofPacketId}.json`);
    await writeJson(filePath, packet);
    return filePath;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseTarget(value: unknown, index: number): AgentTarget {
  if (!isRecord(value)) {
    throw new Error(`Seed target at index ${index} must be an object`);
  }

  return {
    agentId: requiredString(value, "agentId", index),
    name: requiredString(value, "name", index),
    toolId: requiredString(value, "toolId", index),
    toolName: requiredString(value, "toolName", index),
    description: requiredString(value, "description", index),
    category: requiredString(value, "category", index),
    price: requiredString(value, "price", index),
    currency: requiredString(value, "currency", index),
    paymentMethod: parsePaymentMethod(requiredString(value, "paymentMethod", index)),
    endpoint: requiredString(value, "endpoint", index),
    source: parseSource(requiredString(value, "source", index)),
  };
}

function requiredString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Seed target at index ${index} is missing string field "${key}"`);
  }

  return value;
}

function parsePaymentMethod(value: string): AgentTarget["paymentMethod"] {
  if (value === "x402" || value === "sap_escrow" || value === "manual_seed" || value === "unknown") {
    return value;
  }

  return "unknown";
}

function parseSource(value: string): AgentTarget["source"] {
  if (value === "manual_seed" || value === "sap_discovery") {
    return value;
  }

  throw new Error(`Unsupported target source: ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

