import type { LedgerEntry, PaymentReceipt, ProofPacket, SchedulerHealth } from "./types";

export async function loadLedger(): Promise<LedgerEntry[]> {
  const response = await fetch(`/proofs/ledger.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load ledger: ${response.status}`);
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as LedgerEntry[]) : [];
}

export async function loadLatestProof(): Promise<ProofPacket> {
  const response = await fetch(`/proofs/latest.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load latest proof: ${response.status}`);
  return (await response.json()) as ProofPacket;
}

export async function loadProof(proofPacketId: string): Promise<ProofPacket> {
  const response = await fetch(`/proofs/${encodeURIComponent(proofPacketId)}.json?ts=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Unable to load proof ${proofPacketId}: ${response.status}`);
  return (await response.json()) as ProofPacket;
}

export async function loadProofs(entries: LedgerEntry[]): Promise<ProofPacket[]> {
  const proofs = await Promise.allSettled(entries.map((entry) => loadProof(entry.proofPacketId)));
  return proofs.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

export async function loadSchedulerHealth(): Promise<SchedulerHealth | null> {
  const response = await fetch(`/automation/health.json?ts=${Date.now()}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Unable to load scheduler health: ${response.status}`);
  return (await response.json()) as SchedulerHealth;
}

export function parseReceipt(receipt?: string): Record<string, unknown> | null {
  if (!receipt) return null;
  try {
    const parsed = JSON.parse(receipt) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function proofCardPath(proof: ProofPacket, ledgerEntry?: LedgerEntry): string | null {
  const fromPacket = proof.artifacts?.proofCardPath;
  const fromLedger = ledgerEntry?.proofCard;
  return typeof fromPacket === "string" ? fromPacket : fromLedger ?? null;
}

export function summarizePayments(payments: PaymentReceipt[] = []): {
  total: number;
  settled: number;
  failed: number;
  aceTotal: number;
  targetFailed: boolean;
} {
  return payments.reduce<{
    total: number;
    settled: number;
    failed: number;
    aceTotal: number;
    targetFailed: boolean;
  }>(
    (summary, payment) => {
      const amount = Number(payment.amount ?? 0);
      return {
        total: summary.total + 1,
        settled: summary.settled + (payment.status === "settled" || payment.status === "confirmed" ? 1 : 0),
        failed: summary.failed + (payment.status === "failed" ? 1 : 0),
        aceTotal:
          summary.aceTotal +
          (payment.provider === "ace_data_cloud" && Number.isFinite(amount) && payment.status === "settled" ? amount : 0),
        targetFailed: summary.targetFailed || (payment.provider !== "ace_data_cloud" && payment.status === "failed"),
      };
    },
    { total: 0, settled: 0, failed: 0, aceTotal: 0, targetFailed: false },
  );
}

export function formatDate(value?: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(date);
}

export function formatDateTime(value?: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function shortId(value?: string, prefix = 10, suffix = 6): string {
  if (!value) return "unknown";
  if (value.length <= prefix + suffix + 3) return value;
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

export function statusTone(status?: string): "good" | "warn" | "bad" | "neutral" {
  const value = (status ?? "").toLowerCase();
  if (["settled", "confirmed", "delivered", "healthy", "passed", "completed"].some((item) => value.includes(item))) return "good";
  if (["warning", "skipped", "partial", "quoted"].some((item) => value.includes(item))) return "warn";
  if (["failed", "blocked", "error", "unreachable"].some((item) => value.includes(item))) return "bad";
  return "neutral";
}
