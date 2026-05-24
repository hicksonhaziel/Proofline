export interface IntegrationPlaceholder {
  name: "sap" | "synapse" | "ace" | "x402" | "sentinel";
  phase: number;
}

export * from "./ace-client.js";
export * from "./sap-sdk.js";
