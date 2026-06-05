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

    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
    res.status(200).json(data.payload);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

function stringQuery(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isProofPacketId(value) {
  return typeof value === "string" && /^proof_[a-zA-Z0-9_-]+$/.test(value);
}
