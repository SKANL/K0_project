export const memoryMigration = {
  mode: "expand",
  tables: ["memoryRecords", "memoryConflicts", "embeddingRebuildJobs", "memoryAuditEvents", "memoryInvalidations"],
  rollback: "disable-memory-writes-and-remove-derived-embeddings-and-rebuild-jobs"
} as const;
