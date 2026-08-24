export const automationMigration = {
  mode: "expand",
  tables: ["automationSchedules", "automationRuns", "automationBeats", "workerLeases"],
  flags: { automationWrites: false, automationWorkers: false },
  rollback: "disable-automation-workers-drain-leases-reconcile-beats"
} as const;
