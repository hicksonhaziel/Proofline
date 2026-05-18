export interface ProoflineToolDefinition {
  name: string;
  protocolId: string;
  description: string;
  category: string;
  httpMethod: "get" | "post";
  paramsCount: number;
  requiredParams: number;
}

export interface ProoflineAgentMetadata {
  name: string;
  agentId: string;
  description: string;
  protocols: string[];
  capabilities: Array<{
    id: string;
    description: string;
    protocolId: string;
    version: string;
  }>;
  tools: ProoflineToolDefinition[];
}

export const prooflineAgentMetadata: ProoflineAgentMetadata = {
  name: "Proofline",
  agentId: "proofline",
  description:
    "Autonomous paid execution auditor for SAP agents. Proofline pays to test tools, checks Sentinel, analyzes outputs with Ace Data Cloud, and publishes Execution Proof Packets.",
  protocols: ["sap", "x402", "proofline", "execution-audit"],
  capabilities: [
    {
      id: "proofline:audit_agent",
      description: "Run a paid execution audit against an SAP agent tool.",
      protocolId: "proofline",
      version: "0.1.0",
    },
    {
      id: "proofline:execution_proof",
      description: "Return replayable evidence for a previous paid execution audit.",
      protocolId: "proofline",
      version: "0.1.0",
    },
    {
      id: "proofline:execution_verdict",
      description: "Return a compact delivered, failed, warning, or re-audit-needed verdict.",
      protocolId: "proofline",
      version: "0.1.0",
    },
  ],
  tools: [
    {
      name: "audit_agent",
      protocolId: "proofline",
      description: "Request a paid execution audit for an SAP agent tool.",
      category: "audit",
      httpMethod: "post",
      paramsCount: 4,
      requiredParams: 2,
    },
    {
      name: "get_execution_proof",
      protocolId: "proofline",
      description: "Fetch an Execution Proof Packet by proof packet id or target agent id.",
      category: "proof",
      httpMethod: "get",
      paramsCount: 2,
      requiredParams: 1,
    },
    {
      name: "get_execution_verdict",
      protocolId: "proofline",
      description: "Fetch the latest execution verdict for a target SAP agent tool.",
      category: "proof",
      httpMethod: "get",
      paramsCount: 2,
      requiredParams: 1,
    },
    {
      name: "list_recent_proofs",
      protocolId: "proofline",
      description: "List recent paid execution proof packets produced by Proofline.",
      category: "proof",
      httpMethod: "get",
      paramsCount: 2,
      requiredParams: 0,
    },
  ],
};
