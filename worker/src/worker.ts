import "dotenv/config";
import { run, runMigrations } from "graphile-worker";
import { taskList } from "./tasks/index.js";

function getConnectionString(): string {
  const value = process.env.GRAPHILE_DATABASE_URL || process.env.DATABASE_URL;
  if (!value) {
    throw new Error("Missing GRAPHILE_DATABASE_URL (or DATABASE_URL) for Graphile worker.");
  }
  return value;
}

process.on("unhandledRejection", (err) => {
  console.error("[graphile-worker] unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[graphile-worker] uncaught exception:", err);
  process.exit(1);
});

const concurrency = Number(process.env.GRAPHILE_CONCURRENCY || 5);
const connectionString = getConnectionString();

try {
  await runMigrations({ connectionString });
} catch (err) {
  console.error("[graphile-worker] migration failed:", err);
  process.exit(1);
}

const runner = await run({
  connectionString,
  concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 5,
  pollInterval: 1000,
  taskList,
  noHandleSignals: true,
});

console.log("[graphile-worker] started (pipeline.run_stage enabled)");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`[graphile-worker] received ${signal}, stopping...`);
    try {
      await runner.stop();
    } catch (err) {
      console.error("[graphile-worker] error during shutdown:", err);
    }
    process.exit(0);
  });
}
