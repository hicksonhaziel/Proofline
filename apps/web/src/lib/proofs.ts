import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CommerceSale, LedgerEntry, PaymentReceipt, ProofPacket, SchedulerHealth } from "./types";

export async function loadLedger(): Promise<LedgerEntry[]> {
  const supabase = supabaseClient();
  if (supabase) {
    const { data, error } = await supabase.from("proof_packets").select("payload, proof_card_url").order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(`Unable to load Supabase ledger: ${error.message}`);
    return (data ?? []).flatMap((row) => {
      const packet = row.payload as ProofPacket;
      return packet?.proofPacketId ? [ledgerEntryFromPacket(packet, row.proof_card_url ?? undefined)] : [];
    });
  }

  const response = await fetch(`/proofs/ledger.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load ledger: ${response.status}`);
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as LedgerEntry[]) : [];
}

export async function loadLatestProof(): Promise<ProofPacket> {
  const supabase = supabaseClient();
  if (supabase) {
    const { data, error } = await supabase.from("proof_packets").select("payload").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`Unable to load latest Supabase proof: ${error.message}`);
    if (!data?.payload) throw new Error("No Supabase proof packets found");
    return data.payload as ProofPacket;
  }

  const response = await fetch(`/proofs/latest.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load latest proof: ${response.status}`);
  return (await response.json()) as ProofPacket;
}

export async function loadProof(proofPacketId: string): Promise<ProofPacket> {
  const supabase = supabaseClient();
  if (supabase) {
    const { data, error } = await supabase.from("proof_packets").select("payload").eq("proof_packet_id", proofPacketId).maybeSingle();
    if (error) throw new Error(`Unable to load Supabase proof ${proofPacketId}: ${error.message}`);
    if (!data?.payload) throw new Error(`Supabase proof not found: ${proofPacketId}`);
    return data.payload as ProofPacket;
  }

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
  const supabase = supabaseClient();
  if (supabase) {
    const { data, error } = await supabase.from("scheduler_runs").select("payload").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`Unable to load Supabase scheduler health: ${error.message}`);
    return (data?.payload as SchedulerHealth | undefined) ?? null;
  }

  const response = await fetch(`/automation/health.json?ts=${Date.now()}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Unable to load scheduler health: ${response.status}`);
  return (await response.json()) as SchedulerHealth;
}

export async function loadCommerceSales(): Promise<CommerceSale[]> {
  const supabase = supabaseClient();
  if (!supabase) return [];
  const { data, error } = await supabase.from("commerce_sales").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(`Unable to load commerce sales: ${error.message}`);
  return (data ?? []) as CommerceSale[];
}

function supabaseClient(): SupabaseClient | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const url = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function ledgerEntryFromPacket(packet: ProofPacket, proofCard?: string): LedgerEntry {
  const paymentSummary = summarizePayments(packet.payments ?? []);
  return {
    proofPacketId: packet.proofPacketId,
    targetName: packet.targetAgent?.name ?? "unknown",
    targetAgentId: packet.targetAgent?.agentId,
    toolName: packet.targetAgent?.toolName,
    category: packet.targetAgent?.category,
    auditStatus: packet.auditStatus,
    verdict: packet.scores?.verdict,
    overallScore: packet.scores?.overall,
    riskFlags: packet.riskFlags ?? [],
    riskLevel: riskLevel(packet),
    aceServicesUsed: packet.aceAnalysis?.servicesUsed ?? [],
    paymentStatus: paymentSummary.settled > 0 ? "settled" : paymentSummary.failed > 0 ? "failed" : "skipped",
    paymentMethod: packet.payments?.[0]?.method,
    paymentIntegrity: packet.payments?.some((payment) => payment.transactionHash) ? "transaction_hash_present" : "no_transaction_hash",
    ...(paymentSummary.aceTotal > 0 ? { acePaymentTotalUsdc: paymentSummary.aceTotal } : {}),
    createdAt: packet.createdAt,
    packetHash: packet.signature?.packetHash,
    proofHtml: `/proofs/${packet.proofPacketId}`,
    proofJson: `supabase:proof_packets/${packet.proofPacketId}`,
    proofCard: proofCard ?? packet.artifacts?.proofCardPath,
  };
}

function riskLevel(packet: ProofPacket): string {
  if (packet.scores?.verdict === "failed" || (packet.riskFlags?.length ?? 0) >= 3) return "high";
  if (packet.scores?.verdict === "warning" || (packet.riskFlags?.length ?? 0) > 0) return "medium";
  return "low";
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
