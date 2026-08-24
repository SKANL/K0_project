export const assuranceMigration = {
  mode: "expand",
  version: "assurance-backup-v3",
  tables: ["commercialLedger", "privacyRecords", "releaseActivations", "encryptedBackupSnapshots", "backupRestoreAudit", "vaultHostApprovals"],
  indexes: ["by_tenant_snapshot", "by_tenant_restore_idempotency", "by_vault_host_platform"],
  flags: { commercialLedgerWrites: false, releaseActivation: false, encryptedBackupWrites: false, isolatedRestore: false, approvedVaultHostFactory: false },
  rollback: "disable-approved-vault-host-factories-and-encrypted-backup-writes-delete-v3-snapshots-and-restore-previous-verified-manifest"
} as const;
