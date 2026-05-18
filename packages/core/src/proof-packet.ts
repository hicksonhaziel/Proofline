import { createHash } from "node:crypto";
import type { ExecutionProofPacket } from "./types.js";

export function createProofPacketId(packet: Omit<ExecutionProofPacket, "proofPacketId">): string {
  const hash = createHash("sha256");

  hash.update(packet.auditJob.auditJobId);
  hash.update(packet.targetAgent.agentId);
  hash.update(packet.targetAgent.toolId);
  hash.update(packet.createdAt);

  return `proof_${hash.digest("hex").slice(0, 16)}`;
}

export function assertProofPacket(packet: ExecutionProofPacket): void {
  if (!packet.proofPacketId) {
    throw new Error("Proof packet is missing proofPacketId");
  }

  if (!packet.targetAgent.agentId) {
    throw new Error("Proof packet is missing target agent id");
  }

  if (!packet.auditJob.auditJobId) {
    throw new Error("Proof packet is missing audit job id");
  }
}

