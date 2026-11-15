import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "frontend-sdk");
const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (metadata.name !== "metaglasses-sdk" || metadata.private === true) {
  throw new Error("Unexpected public package metadata.");
}
if (metadata.repository?.url !== "https://github.com/Adipat2003/metaglasses-backend.git") {
  throw new Error("Unexpected source repository metadata.");
}
const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageRoot,
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const [packed] = JSON.parse(result.stdout);
const files = packed.files.map(({ path }) => path);
const required = [
  "package.json",
  "README.md",
  "dist/api-types.d.ts",
  "dist/client.d.ts",
  "dist/client.js",
];
const allowed = (path) => required.includes(path);
const missing = required.filter((path) => !files.includes(path));
const unexpected = files.filter((path) => !allowed(path));
if (missing.length || unexpected.length) {
  throw new Error(
    `Unexpected package file set. Missing: ${missing.join(", ")}; unexpected: ${
      unexpected.join(", ")
    }`,
  );
}

for (const path of files.filter((file) => file !== "package.json")) {
  const contents = readFileSync(join(packageRoot, path), "utf8");
  if (/https?:\/\//i.test(contents) || /execute-api\.[a-z0-9-]+\.amazonaws\.com/i.test(contents)) {
    throw new Error(`Published file contains a URL: ${path}`);
  }
  if (path.startsWith("dist/") && /^\s{4}"\/(?:healthz|v1\/)/m.test(contents)) {
    throw new Error(`Published file contains a route listing: ${path}`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(contents)) {
    throw new Error(`Published file contains private key material: ${path}`);
  }
}

console.info(
  `Package contents checked: ${files.length} files, no backend URLs or private key material.`,
);
