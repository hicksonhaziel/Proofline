import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";

export async function loadKeypairFromFile(path: string): Promise<Keypair> {
  const raw = process.env.SAP_KEYPAIR_JSON ?? decodeBase64(process.env.SAP_KEYPAIR_BASE64) ?? (await readKeypairFile(path));
  const parsed: unknown = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Expected Solana keypair JSON array from SAP_KEYPAIR_JSON, SAP_KEYPAIR_BASE64, or SAP_KEYPAIR_PATH");
  }

  const secretKey = Uint8Array.from(
    parsed.map((value, index) => {
      if (typeof value !== "number") {
        throw new Error(`Invalid keypair byte at index ${index}`);
      }

      return value;
    }),
  );

  return Keypair.fromSecretKey(secretKey);
}

async function readKeypairFile(path: string): Promise<string> {
  const fullPath = resolve(path);
  return readFile(fullPath, "utf8");
}

function decodeBase64(value: string | undefined): string | undefined {
  return value ? Buffer.from(value, "base64").toString("utf8") : undefined;
}
