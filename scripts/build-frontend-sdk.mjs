import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repoRoot, "frontend-sdk");
const output = resolve(packageRoot, "dist");
rmSync(output, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    resolve(packageRoot, "node_modules/typescript/bin/tsc"),
    "-p",
    resolve(packageRoot, "tsconfig.json"),
  ],
  { cwd: packageRoot, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(output, { recursive: true });
const generatedTypes = readFileSync(resolve(packageRoot, "api-types.d.ts"), "utf8");
const packageTypes = generatedTypes.replace(/^export interface paths \{[\s\S]*?^\}\n/m, "");
if (packageTypes === generatedTypes) {
  throw new Error("Generated OpenAPI path types were not found.");
}
writeFileSync(resolve(output, "api-types.d.ts"), packageTypes);
