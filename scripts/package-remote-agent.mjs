import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
  throw new Error("Usage: node scripts/package-remote-agent.mjs <version>");
}

const archivePath = path.join(rootDir, `quota-dashboard-remote-agent-${version}.tar.gz`);
const stageDir = await mkdtemp(path.join(os.tmpdir(), "quota-dashboard-remote-agent-"));
const remoteDir = path.join(stageDir, "remote");
const runtimeFiles = ["index.js", "publisher.js", "ccusage.js", "protocol.js"];

try {
  await mkdir(remoteDir, { recursive: true });
  for (const file of runtimeFiles) {
    await cp(path.join(rootDir, "src", "dist", "remote", file), path.join(remoteDir, file));
  }
  await cp(path.join(rootDir, "src", "remote", "setup.sh"), path.join(remoteDir, "setup.sh"));
  await chmod(path.join(remoteDir, "setup.sh"), 0o755);
  await cp(path.join(rootDir, "src", "remote", "package.json"), path.join(stageDir, "package.json"));
  await cp(path.join(rootDir, "src", "remote", "package-lock.json"), path.join(stageDir, "package-lock.json"));

  await execFileAsync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: stageDir });
  await rm(archivePath, { force: true });
  await execFileAsync("tar", ["-czf", archivePath, "-C", stageDir, "."]);
} finally {
  await rm(stageDir, { recursive: true, force: true });
}

console.log(`Created ${path.basename(archivePath)}.`);
