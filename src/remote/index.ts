import { runRemotePublisher } from "./publisher.js";
import { formatLocalTimestamp } from "../lib/daily-logger.js";

const publisher = await runRemotePublisher();
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[${formatLocalTimestamp(new Date())}] remote MQTT publisher stopping on ${signal}`);
  try {
    await publisher.stop();
  } finally {
    await publisher.closeLog(2_000);
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
