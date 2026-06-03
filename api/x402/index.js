import { handleOptions, setCors } from "../_lib/supabase.js";
import { metadata } from "../_lib/proofline-commerce.js";

export default function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  res.status(200).json(metadata(req));
}
