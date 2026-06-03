import { createRuntimeStore, type RuntimeStore } from "../../../packages/db/src/index.js";
import type { ProoflineConfig } from "./config.js";

export function createProoflineStore(config: ProoflineConfig): RuntimeStore {
  return createRuntimeStore({
    mode: config.storageMode,
    ...(config.supabaseUrl ? { supabaseUrl: config.supabaseUrl } : {}),
    ...(config.supabaseServiceRoleKey ? { supabaseServiceRoleKey: config.supabaseServiceRoleKey } : {}),
    filePaths: {
      targetsFile: config.targetAgentList,
      proofPacketsDir: "data/proof-packets",
      artifactsDir: "data/artifacts",
      runsDir: "data/runs",
    },
  });
}
