export const assuranceMigration = {
  mode: "expand",
  version: "assurance-backup-v2",
  tables: ["commercialLedger", "privacyRecords", "releaseActivations", "encryptedBackupSnapshots", "backupRestoreAudit"],
  indexes: ["by_tenant_snapshot", "by_tenant_restore_idempotency"],
  flags: { commercialLedgerWrites: false, releaseActivation: false, encryptedBackupWrites: false, isolatedRestore: false },
  rollback: "disable-encrypted-backup-writes-delete-v2-snapshots-and-restore-previous-verified-manifest"
} as const;
