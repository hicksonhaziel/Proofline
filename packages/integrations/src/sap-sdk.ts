import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SapSdk {
  SapClient: new (opts: { rpcUrl: string; commitment?: string }) => SapClientLike;
  Pdas: {
    getAgentPDA(wallet: unknown): [unknown, number];
    getAgentStatsPDA(wallet: unknown): [unknown, number];
    getGlobalPDA(): [unknown, number];
    getToolPDA(agent: unknown, toolName: string): [unknown, number];
  };
  Utils?: {
    sha256(input: string | Buffer | Uint8Array): Uint8Array;
    hashToArray(hash: Uint8Array): number[];
  };
  PROGRAM_ID: string;
}

export interface SapClientLike {
  connection: {
    getBalance(publicKey: unknown): Promise<number>;
    getSignatureStatuses(signatures: string[]): Promise<{
      value: Array<{
        confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
        err?: unknown;
      } | null>;
    }>;
    simulateTransaction(transaction: unknown, config?: unknown): Promise<{
      value: {
        err: unknown;
        logs?: string[] | null;
        accounts?: Array<{ lamports?: number } | null> | null;
      };
    }>;
    sendTransaction(transaction: unknown, opts?: unknown): Promise<string>;
    getAccountInfo(publicKey: unknown): Promise<unknown | null>;
  };
  agent: {
    registerAgent(ctx: Record<string, unknown>): Promise<unknown>;
  };
  tools: {
    publishTool(ctx: Record<string, unknown>): Promise<unknown>;
  };
  escrow: {
    createEscrow(ctx: Record<string, unknown>): Promise<unknown>;
    createEscrowV2(ctx: Record<string, unknown>): Promise<unknown>;
  };
  buildTransaction(instructions: unknown[], payer: unknown): Promise<{
    sign(signers: unknown[]): void;
  }>;
}

export function loadSapSdk(): SapSdk {
  return require("@oobe-protocol-labs/synapse-sap-sdk") as SapSdk;
}
