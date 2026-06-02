export interface LedgerEntry {
  proofPacketId: string;
  targetName: string;
  targetAgentId?: string;
  toolName?: string;
  category?: string;
  auditStatus?: string;
  verdict?: string;
  overallScore?: number;
  riskFlags?: string[];
  riskLevel?: string;
  aceServicesUsed?: string[];
  paymentStatus?: string;
  paymentMethod?: string;
  paymentIntegrity?: string;
  acePaymentTotalUsdc?: number;
  createdAt?: string;
  packetHash?: string;
  proofHtml?: string;
  proofJson?: string;
  proofCard?: string;
}

export interface PaymentReceipt {
  paymentId: string;
  auditJobId?: string;
  provider?: string;
  method?: string;
  amount?: string;
  currency?: string;
  recipient?: string;
  service?: string;
  status?: string;
  receipt?: string;
  txHash?: string;
  transactionHash?: string;
  createdAt?: string;
  confirmedAt?: string;
}

export interface ProofPacket {
  proofPacketId: string;
  version?: string;
  auditStatus?: string;
  targetAgent?: {
    agentId?: string;
    name?: string;
    toolId?: string;
    toolName?: string;
    category?: string;
    price?: string;
    currency?: string;
    paymentMethod?: string;
    endpoint?: string;
    source?: string;
  };
  auditJob?: {
    auditJobId?: string;
    status?: string;
    createdAt?: string;
    completedAt?: string;
  };
  sentinelCheck?: {
    status?: string;
    checkedAt?: string;
    warnings?: string[];
    reasons?: string[];
    raw?: unknown;
  };
  payments?: PaymentReceipt[];
  probeResult?: {
    status?: string;
    deliveryStatus?: string;
    request?: {
      method?: string;
      url?: string;
      paid?: boolean;
      purpose?: string;
      probeTypes?: string[];
    };
    outputPreview?: unknown;
    raw?: unknown;
    error?: string;
    completedAt?: string;
  };
  aceAnalysis?: {
    servicesUsed?: string[];
    outputQualityScore?: number;
    capabilityMatchScore?: number;
    summary?: string;
    riskFlags?: string[];
    raw?: {
      x402Summary?: X402Summary;
      artifacts?: Record<string, unknown>;
      servicesAttempted?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
  };
  scores?: {
    reliability?: number;
    capabilityMatch?: number;
    paymentIntegrity?: number;
    publicFootprint?: number;
    safety?: number;
    overall?: number;
    verdict?: string;
  };
  riskFlags?: string[];
  artifacts?: {
    proofCardPath?: string;
    audioPath?: string;
  };
  createdAt?: string;
  auditorAgent?: {
    name?: string;
    agentId?: string;
    publicKey?: string;
  };
  signature?: {
    packetHash?: string;
    signature?: string;
    publicKey?: string;
    signedAt?: string;
  };
}

export interface X402Summary {
  totalPayments?: number;
  settled?: number;
  quoted?: number;
  failed?: number;
  totalSettledUsdc?: number;
  services?: Array<{
    service?: string;
    status?: string;
    amount?: string;
    transactionHash?: string;
  }>;
}
