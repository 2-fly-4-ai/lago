import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const required = [
  "AGENTS.md",
  "README.md",
  "docs/README.md",
  "docs/SERP_ARCHITECTURE.md",
  "docs/SOURCE_OF_TRUTH.md",
  "docs/SAFETY.md",
  "docs/QUALITY.md",
  "docs/plans/README.md",
  "docs/plans/active/README.md",
  "docs/plans/completed/README.md",
];
const failures = [];

async function isFile(relativePath) {
  try {
    return (await stat(path.join(root, relativePath))).isFile();
  } catch {
    return false;
  }
}

for (const file of required) {
  if (!(await isFile(file))) failures.push(`missing required harness file: ${file}`);
}

if (await isFile("AGENTS.md")) {
  const lines = (await readFile(path.join(root, "AGENTS.md"), "utf8")).split(/\r?\n/).length;
  if (lines > 120) failures.push(`AGENTS.md has ${lines} lines; maximum is 120`);
}

for (const state of ["active", "completed"]) {
  const directory = path.join(root, "docs", "plans", state);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (
      entry.isFile() &&
      entry.name !== "README.md" &&
      !/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/.test(entry.name)
    ) {
      failures.push(`invalid ${state} plan filename: ${entry.name}`);
    }
  }
}

if (failures.length) {
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Harness check passed (${required.length} required files).`);
}
