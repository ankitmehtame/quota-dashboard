import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const outputPath = join(projectRoot, "dist", "version.json");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const description = git(["describe", "--tags", "--long", "--always", "--match", "v[0-9]*"]);
const described = description.match(/^v?(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)$/);

let version;
let commit;

if (described) {
  const [, baseVersion, distance, shortCommit] = described;
  commit = shortCommit;
  version = distance === "0" ? baseVersion : `${baseVersion}-dev.${distance}+g${shortCommit}`;
} else {
  commit = git(["rev-parse", "--short=12", "HEAD"]) || null;
  const commitCount = git(["rev-list", "--count", "HEAD"]) || "0";
  version = `0.0.0-dev.${commitCount}${commit ? `+g${commit}` : ""}`;
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ version, commit }, null, 2)}\n`);
console.log(`Build version: ${version}`);
