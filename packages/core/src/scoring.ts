import type { ExecutionVerdict, RiskFlag, ScoreBreakdown } from "./types.js";

export interface ScoreInput {
  reliability: number;
  capabilityMatch: number;
  paymentIntegrity: number;
  publicFootprint: number;
  safety: number;
  riskFlags: RiskFlag[];
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function verdictFor(overall: number, riskFlags: RiskFlag[]): ExecutionVerdict {
  if (riskFlags.includes("PAYMENT_FAILED") || riskFlags.includes("NO_OUTPUT_AFTER_PAYMENT")) {
    return "failed";
  }

  if (riskFlags.includes("SENTINEL_WARNING") || riskFlags.includes("CAPABILITY_MISMATCH")) {
    return "warning";
  }

  if (overall >= 80) {
    return "delivered";
  }

  if (overall >= 50) {
    return "warning";
  }

  return "re_audit_needed";
}

export function scoreExecution(input: ScoreInput): ScoreBreakdown {
  const reliability = clampScore(input.reliability);
  const capabilityMatch = clampScore(input.capabilityMatch);
  const paymentIntegrity = clampScore(input.paymentIntegrity);
  const publicFootprint = clampScore(input.publicFootprint);
  const safety = clampScore(input.safety);

  const overall = clampScore(
    reliability * 0.25 +
      capabilityMatch * 0.25 +
      paymentIntegrity * 0.25 +
      publicFootprint * 0.1 +
      safety * 0.15,
  );

  return {
    reliability,
    capabilityMatch,
    paymentIntegrity,
    publicFootprint,
    safety,
    overall,
    verdict: verdictFor(overall, input.riskFlags),
  };
}

