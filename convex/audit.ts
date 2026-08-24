const sensitiveKey = /authorization|secret|token|password/i;
export function redactMetadata(metadata: Record<string, string>) { return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : value])); }
