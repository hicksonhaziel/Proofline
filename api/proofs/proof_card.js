import { handleOptions, setCors, supabaseAdmin } from "../_lib/supabase.js";

export default async function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const proofPacketId = stringQuery(req.query.proofPacketId);
  if (!isProofPacketId(proofPacketId)) {
    res.status(400).json({ error: "Invalid proofPacketId" });
    return;
  }

  try {
    const db = supabaseAdmin();
    const { data, error } = await db.from("proof_packets").select("payload").eq("proof_packet_id", proofPacketId).maybeSingle();
    if (error) throw new Error(`Failed to load proof packet: ${error.message}`);
    if (!data?.payload) {
      res.status(404).json({ error: "Proof packet not found" });
      return;
    }

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).send(buildProofCardSvg(data.payload));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

function buildProofCardSvg(packet) {
  const title = shortCardText(packet.targetAgent?.name ?? "unknown", 34);
  const verdict = String(packet.scores?.verdict ?? "unknown").toUpperCase();
  const score = String(packet.scores?.overall ?? 0);
  const services = Array.isArray(packet.aceAnalysis?.servicesUsed) && packet.aceAnalysis.servicesUsed.length > 0
    ? packet.aceAnalysis.servicesUsed.slice(0, 3).join(" / ")
    : "none";
  const paymentSummary = ledgerPaymentSummary(packet);
  const risks = Array.isArray(packet.riskFlags) && packet.riskFlags.length > 0 ? packet.riskFlags.slice(0, 4).join(" / ") : "none";
  const created = typeof packet.createdAt === "string" ? packet.createdAt.slice(0, 10) : "unknown";
  const hash = typeof packet.signature?.packetHash === "string" ? packet.signature.packetHash.slice(0, 20) : "unsigned";
  const proofPacketId = typeof packet.proofPacketId === "string" ? packet.proofPacketId : "unknown";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img" aria-label="Proofline execution proof card">
  <rect width="1200" height="675" fill="#101215"/>
  <rect x="36" y="36" width="1128" height="603" rx="18" fill="#17191c" stroke="#4d4637" stroke-width="2"/>
  <text x="72" y="96" fill="#ffe08d" font-family="monospace" font-size="24" font-weight="700">PROOFLINE EXECUTION PROOF</text>
  <text x="72" y="154" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="48" font-weight="700">${escapeSvg(title)}</text>
  <text x="72" y="206" fill="#cac6bd" font-family="monospace" font-size="20">Proof ID ${escapeSvg(proofPacketId)} / ${escapeSvg(created)}</text>
  <rect x="72" y="254" width="270" height="160" rx="12" fill="#1f2022" stroke="#4d4637"/>
  <text x="96" y="302" fill="#cac6bd" font-family="monospace" font-size="18">VERDICT</text>
  <text x="96" y="360" fill="#ffdf8a" font-family="Arial, sans-serif" font-size="40" font-weight="700">${escapeSvg(verdict)}</text>
  <rect x="378" y="254" width="210" height="160" rx="12" fill="#1f2022" stroke="#4d4637"/>
  <text x="402" y="302" fill="#cac6bd" font-family="monospace" font-size="18">SCORE</text>
  <text x="402" y="370" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="72" font-weight="700">${escapeSvg(score)}</text>
  <text x="510" y="370" fill="#cac6bd" font-family="monospace" font-size="24">/100</text>
  <rect x="624" y="254" width="468" height="160" rx="12" fill="#1f2022" stroke="#4d4637"/>
  <text x="648" y="302" fill="#cac6bd" font-family="monospace" font-size="18">PAYMENT</text>
  <text x="648" y="350" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="30" font-weight="700">${escapeSvg(paymentSummary.status)}</text>
  <text x="648" y="388" fill="#cac6bd" font-family="monospace" font-size="18">Ace ${escapeSvg(paymentSummary.acePaymentTotalUsdc)} USDC settled</text>
  <text x="72" y="480" fill="#cac6bd" font-family="monospace" font-size="20">ACE SERVICES</text>
  <text x="72" y="522" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="28">${escapeSvg(shortCardText(services, 60))}</text>
  <text x="72" y="580" fill="#cac6bd" font-family="monospace" font-size="20">RISKS</text>
  <text x="72" y="616" fill="#e3e2e5" font-family="Arial, sans-serif" font-size="24">${escapeSvg(shortCardText(risks, 78))}</text>
  <text x="812" y="616" fill="#8f918f" font-family="monospace" font-size="18">sha256:${escapeSvg(hash)}</text>
</svg>
`;
}

function ledgerPaymentSummary(packet) {
  const payments = Array.isArray(packet.payments) ? packet.payments : [];
  const targetPayment = payments.find((payment) => payment.provider !== "ace_data_cloud");
  const acePayments = payments.filter((payment) => payment.provider === "ace_data_cloud");
  const settledAcePayments = acePayments.filter((payment) => payment.status === "settled" || payment.status === "confirmed");
  const failedPayments = payments.filter((payment) => payment.status === "failed");
  const acePaymentTotalUsdc = settledAcePayments.reduce((sum, payment) => {
    const amount = Number(payment.amount);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  const status =
    failedPayments.length > 0
      ? "failed"
      : settledAcePayments.length > 0 && targetPayment?.status === "skipped"
        ? "ace settled / target skipped"
        : settledAcePayments.length > 0
          ? "settled"
          : targetPayment?.status ?? "unsettled";

  return {
    status,
    acePaymentTotalUsdc: acePaymentTotalUsdc.toFixed(6),
  };
}

function stringQuery(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isProofPacketId(value) {
  return typeof value === "string" && /^proof_[a-zA-Z0-9_-]+$/.test(value);
}

function shortCardText(value, maxLength) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1))}.`;
}

function escapeSvg(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
