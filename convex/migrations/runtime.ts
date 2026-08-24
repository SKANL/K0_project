export const runtimeMigration = {
  mode: "expand",
  contracts: ["versioned-runs", "lineage-edges", "rdd-receipts"],
  backfill: "derive deterministic snapshot and receipt bytes before enabling runtime writes",
  rollback: "disable runtime writes; retain immutable receipts and existing command/outbox records"
} as const;
