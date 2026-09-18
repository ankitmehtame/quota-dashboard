import { runRemotePublisher } from "./publisher.js";

const publisher = await runRemotePublisher();
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[${new Date().toISOString()}] remote MQTT publisher stopping on ${signal}`);
  await publisher.stop();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
