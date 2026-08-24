export const assuranceMigration = {
  mode: "expand",
  tables: ["commercialLedger", "privacyRecords", "releaseActivations"],
  flags: { commercialLedgerWrites: false, releaseActivation: false },
  rollback: "disable-release-activation-and-restore-previous-verified-manifest"
} as const;
