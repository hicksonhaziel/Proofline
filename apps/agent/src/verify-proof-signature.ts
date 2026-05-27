import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import type { ExecutionProofPacket } from "../../../packages/core/src/index.js";

async function main(): Promise<void> {
  if (process.argv.includes("--all")) {
    const proofsDir = resolve("public/proofs");
    const files = (await readdir(proofsDir)).filter((file) => file.startsWith("proof_") && file.endsWith(".json")).sort();
    const results = [];

    for (const file of files) {
      results.push(await verifyPacket(resolve(proofsDir, file)));
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          verifiedCount: results.length,
          proofs: results,
        },
        null,
        2,
      ),
    );
    return;
  }

  const packetPath = process.argv[2] ?? "public/proofs/latest.json";
  console.log(JSON.stringify(await verifyPacket(resolve(packetPath)), null, 2));
}

async function verifyPacket(packetPath: string): Promise<Record<string, string | boolean | undefined>> {
  const packet = JSON.parse(await readFile(resolve(packetPath), "utf8")) as ExecutionProofPacket;

  if (!packet.signature) {
    throw new Error(`${packetPath} is unsigned`);
  }

  const unsignedPacket: ExecutionProofPacket = { ...packet };
  delete unsignedPacket.signature;

  const signedPayload = stableJson(unsignedPacket);
  const packetHash = createHash("sha256").update(signedPayload).digest("hex");

  if (packetHash !== packet.signature.packetHash) {
    throw new Error(
      `Packet hash mismatch: calculated ${packetHash}, packet contains ${packet.signature.packetHash}`,
    );
  }

  if (packet.signature.signedPayload !== `sha256:${packetHash}`) {
    throw new Error(`Signed payload mismatch: ${packet.signature.signedPayload}`);
  }

  const publicKeyBytes = new PublicKey(packet.signature.publicKey).toBytes();
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyBytes)]),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(packet.signature.signatureBase64, "base64");
  const verified = cryptoVerify(null, Buffer.from(signedPayload, "utf8"), publicKey, signature);

  if (!verified) {
    throw new Error(`Signature verification failed for ${packet.proofPacketId}`);
  }

  return {
    ok: true,
    proofPacketId: packet.proofPacketId,
    auditStatus: packet.auditStatus,
    packetHash,
    publicKey: packet.signature.publicKey,
    signedAt: packet.signature.signedAt,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
