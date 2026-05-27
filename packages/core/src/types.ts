export type PaymentMethod = "x402" | "sap_escrow" | "manual_seed" | "unknown";

export type AuditStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type ExecutionVerdict =
  | "delivered"
  | "failed"
  | "warning"
  | "re_audit_needed"
  | "untested";

export type RiskFlag =
  | "NO_OUTPUT_AFTER_PAYMENT"
  | "PAYMENT_FAILED"
  | "TOOL_ENDPOINT_UNREACHABLE"
  | "CAPABILITY_MISMATCH"
  | "GENERIC_RESPONSE"
  | "SENTINEL_WARNING"
  | "MISSING_PUBLIC_FOOTPRINT"
  | "PRICE_TOO_HIGH"
  | "REPEATED_IDENTICAL_OUTPUT";

export interface AgentTarget {
  agentId: string;
  name: string;
  toolId: string;
  toolName: string;
  description: string;
  category: string;
  price: string;
  currency: string;
  paymentMethod: PaymentMethod;
  endpoint: string;
  source: "manual_seed" | "sap_discovery";
}

export interface AuditJob {
  auditJobId: string;
  target: AgentTarget;
  status: AuditStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  maxSpendUsdc: number;
}

export interface PaymentReceipt {
  paymentId: string;
  auditJobId: string;
  provider: "ace_data_cloud" | "sap" | "unknown";
  method: PaymentMethod;
  amount: string;
  currency: string;
  recipient?: string;
  service: string;
  status: "pending" | "settled" | "failed" | "skipped";
  receipt?: string;
  transactionHash?: string;
  createdAt: string;
  confirmedAt?: string;
}

export interface SentinelCheck {
  status: "not_run" | "healthy" | "warning" | "failed";
  sentinelAgentId: string;
  checkedAt?: string;
  raw?: unknown;
  message?: string;
}

export interface ProbeResult {
  probeId: string;
  auditJobId: string;
  targetAgentId: string;
  targetToolId: string;
  request: unknown;
  response?: unknown;
  status: "not_run" | "success" | "failed" | "timeout";
  latencyMs?: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AceAnalysisResult {
  analysisId: string;
  auditJobId: string;
  servicesUsed: string[];
  outputQualityScore?: number;
  capabilityMatchScore?: number;
  summary?: string;
  riskFlags: RiskFlag[];
  raw?: unknown;
  createdAt: string;
}

export interface ScoreBreakdown {
  reliability: number;
  capabilityMatch: number;
  paymentIntegrity: number;
  publicFootprint: number;
  safety: number;
  overall: number;
  verdict: ExecutionVerdict;
}

export interface ExecutionProofPacket {
  proofPacketId: string;
  version: "0.1";
  auditStatus: AuditStatus;
  targetAgent: AgentTarget;
  auditJob: AuditJob;
  sentinelCheck: SentinelCheck;
  payments: PaymentReceipt[];
  probeResult: ProbeResult;
  aceAnalysis: AceAnalysisResult;
  scores: ScoreBreakdown;
  riskFlags: RiskFlag[];
  artifacts: {
    proofCardPath?: string;
    audioPath?: string;
  };
  createdAt: string;
  auditorAgent: {
    name: "Proofline";
    sapAgentId?: string;
  };
  signature?: {
    algorithm: "ed25519";
    publicKey: string;
    packetHash: string;
    signedPayload: string;
    signatureBase64: string;
    signedAt: string;
  };
}
