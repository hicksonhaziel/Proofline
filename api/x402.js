const metadata = {
  version: 1,
  agent: {
    name: "Proofline",
    agentId: "proofline",
    wallet: "E9o29VeYpaU49niLo6ynZtQpA6uNepMvo5i5vGizVvRM",
    description:
      "Autonomous paid execution auditor for SAP agents. Proofline produces receipt-backed Execution Proof Packets."
  },
  resources: [
    "https://proofline-hq.vercel.app/x402/audit_agent",
    "https://proofline-hq.vercel.app/x402/get_execution_proof",
    "https://proofline-hq.vercel.app/x402/get_execution_verdict",
    "https://proofline-hq.vercel.app/x402/list_recent_proofs"
  ],
  pricing: [
    {
      tierId: "demo",
      pricePerCall: "0",
      token: "USDC",
      tokenDecimals: 6,
      settlementMode: "x402",
      note: "Demo discovery endpoint. Paid settlement will be enabled after SAP registration and tool publishing."
    }
  ],
  instructions:
    "Proofline audits SAP agents by discovering target metadata, planning payment, executing a paid call, analyzing output with Ace Data Cloud, and returning an Execution Proof Packet.",
  status: "pre-registration"
};

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, X-Payment");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  res.status(200).json(metadata);
}
