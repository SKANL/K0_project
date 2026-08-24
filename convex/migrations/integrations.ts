export const integrationsMigration = {
  mode: "expand",
  tables: ["integrationConnections", "integrationInbox", "integrationOutbox"],
  flags: { integrationWrites: false, integrationWorkers: false },
  rollback: "disable-integration-writes-drain-fenced-outbox"
} as const;
