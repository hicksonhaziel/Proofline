import { handleOptions, setCors, supabaseAdmin } from "../_lib/supabase.js";
import { latestProof, paymentCapture, recordSale, toolById } from "../_lib/proofline-commerce.js";

export default async function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const tool = toolById("get_execution_proof");
    const db = supabaseAdmin();
    const packet = await latestProof(db, {
      proofPacketId: stringQuery(req.query.proofPacketId),
      targetAgentId: stringQuery(req.query.targetAgentId),
    });
    if (!packet) {
      res.status(404).json({ error: "No matching proof packet found" });
      return;
    }

    const payment = paymentCapture(req, tool);
    const sale = await recordSale(db, req, tool, packet.proofPacketId, packet, payment);
    res.status(200).json({ status: "success", sale, payment, data: packet });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

function stringQuery(value) {
  return Array.isArray(value) ? value[0] : value;
}
