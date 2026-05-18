export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(runId: string): Logger {
  return {
    info: (message, fields) => log("info", runId, message, fields),
    warn: (message, fields) => log("warn", runId, message, fields),
    error: (message, fields) => log("error", runId, message, fields),
  };
}

function log(
  level: "info" | "warn" | "error",
  runId: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const line = {
    level,
    runId,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };

  const output = JSON.stringify(line);

  if (level === "error") {
    console.error(output);
    return;
  }

  console.log(output);
}

