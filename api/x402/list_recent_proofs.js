import { handleOptions, setCors, supabaseAdmin } from "../_lib/supabase.js";
import { paymentCapture, recordSale } from "../_lib/proofline-commerce.js";

const tool = {
  toolId: "list_recent_proofs",
  price: "0",
  currency: "USDC",
};

export default async function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const db = supabaseAdmin();
    const limit = Math.min(Number(req.query.limit ?? 10) || 10, 25);
    const { data, error } = await db
      .from("proof_packets")
      .select("proof_packet_id, target_agent_id, audit_status, verdict, overall_score, risk_flags, packet_hash, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to list proof packets: ${error.message}`);
    const output = { proofs: data ?? [] };
    const payment = paymentCapture(req, tool);
    const sale = await recordSale(db, req, tool, null, output, payment);
    res.status(200).json({ status: "success", sale, payment, data: output });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
