const PROOFLINE_WALLET = "E9o29VeYpaU49niLo6ynZtQpA6uNepMvo5i5vGizVvRM";

export const prooflineTools = [
  {
    toolId: "get_execution_verdict",
    method: "GET",
    price: "0.001",
    currency: "USDC",
    path: "/x402/get_execution_verdict",
    description: "Return a compact verdict and score for a target agent or proof packet.",
  },
  {
    toolId: "get_execution_proof",
    method: "GET",
    price: "0.003",
    currency: "USDC",
    path: "/x402/get_execution_proof",
    description: "Return the full signed Execution Proof Packet.",
  },
  {
    toolId: "request_fresh_audit",
    method: "POST",
    price: "0.01",
    currency: "USDC",
    path: "/x402/request_fresh_audit",
    description: "Request that Proofline queue a fresh audit for an SAP target.",
  },
  {
    toolId: "list_recent_proofs",
    method: "GET",
    price: "0",
    currency: "USDC",
    path: "/x402/list_recent_proofs",
    description: "List recent Proofline proof packet summaries.",
  },
];

export function toolById(toolId) {
  return prooflineTools.find((tool) => tool.toolId === toolId);
}

export function publicBaseUrl(req) {
  return process.env.PROOFLINE_PUBLIC_BASE_URL ?? `https://${req.headers.host ?? "proofline-hq.vercel.app"}`;
}

export function metadata(req) {
  const baseUrl = publicBaseUrl(req);
  return {
    version: 1,
    agent: {
      name: "Proofline",
      agentId: "proofline",
      wallet: PROOFLINE_WALLET,
      description:
        "Autonomous paid execution auditor for SAP agents. Proofline sells receipt-backed Execution Proof Packets and compact verdicts to buyer agents.",
    },
    protocols: ["sap", "x402", "proofline", "execution-audit"],
    resources: prooflineTools.map((tool) => `${baseUrl}${tool.path}`),
    pricing: prooflineTools.map((tool) => ({
      tierId: tool.toolId,
      pricePerCall: tool.price,
      token: tool.currency,
      tokenDecimals: 6,
      settlementMode: "x402",
      payTo: PROOFLINE_WALLET,
      method: tool.method,
      endpoint: `${baseUrl}${tool.path}`,
      note:
        "Proofline records buyer requests and X-PAYMENT headers. Inbound facilitator settlement verification is not claimed unless paymentStatus is settled with a transaction hash.",
    })),
    tools: prooflineTools,
    status: "merchant-ready",
  };
}

export function paymentCapture(req, tool) {
  const xPayment = req.headers["x-payment"] ?? req.headers["x-payment".toLowerCase()];
  if (!xPayment) {
    return {
      paymentStatus: "skipped",
      receipt: "No X-PAYMENT header supplied; Proofline served this as a discovery/demo query.",
    };
  }
  return {
    paymentStatus: "pending",
    receipt: "X-PAYMENT header captured but inbound facilitator verification is not implemented in this deployment.",
    xPaymentPreview: String(xPayment).slice(0, 80),
  };
}

export async function recordSale(db, req, tool, proofPacketId, output, payment) {
  const buyerWallet = firstHeader(req, ["x-buyer-wallet", "x-wallet", "x-payer"]);
  const { data, error } = await db
    .from("commerce_sales")
    .insert({
      buyer_wallet: buyerWallet,
      tool_id: tool.toolId,
      proof_packet_id: proofPacketId ?? null,
      amount: tool.price,
      currency: tool.currency,
      payment_method: "x402",
      payment_status: payment.paymentStatus,
      transaction_hash: null,
      receipt: payment,
      output,
    })
    .select("sale_id, created_at")
    .single();

  if (error) throw new Error(`Failed to record commerce sale: ${error.message}`);
  return data;
}

export async function latestProof(db, query) {
  let request = db.from("proof_packets").select("payload, proof_packet_id, created_at").order("created_at", { ascending: false }).limit(1);
  if (query.proofPacketId) request = request.eq("proof_packet_id", query.proofPacketId);
  if (query.targetAgentId) request = request.eq("target_agent_id", query.targetAgentId);
  const { data, error } = await request.maybeSingle();
  if (error) throw new Error(`Failed to read proof packet: ${error.message}`);
  return data?.payload ?? null;
}

export function verdictFromPacket(packet) {
  return {
    proofPacketId: packet.proofPacketId,
    targetAgent: packet.targetAgent,
    auditStatus: packet.auditStatus,
    verdict: packet.scores?.verdict,
    overallScore: packet.scores?.overall,
    riskFlags: packet.riskFlags ?? [],
    paymentStatus: packet.payments?.[0]?.status ?? "unknown",
    packetHash: packet.signature?.packetHash,
    createdAt: packet.createdAt,
  };
}

function firstHeader(req, names) {
  for (const name of names) {
    const value = req.headers[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
