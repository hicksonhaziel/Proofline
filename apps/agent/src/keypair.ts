import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";

export async function loadKeypairFromFile(path: string): Promise<Keypair> {
  const fullPath = resolve(path);
  const raw = await readFile(fullPath, "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected Solana keypair JSON array at ${fullPath}`);
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

