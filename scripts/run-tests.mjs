import { build } from "esbuild";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const output = mkdtempSync(join(tmpdir(), "ai-context-sync-tests-"));
try {
  await build({ entryPoints: ["sync.ts"], outfile: join(output, "sync.cjs"), bundle: true, platform: "node", format: "cjs", target: "node20" });
  const bundle = spawnSync(process.execPath, ["esbuild.config.mjs", "production"], { stdio: "inherit" });
  if (bundle.status !== 0) throw new Error("Production bundle failed");
  copyFileSync("main.js", join(output, "plugin.cjs"));
  const tests = readdirSync("tests").filter(file => file.endsWith(".test.cjs")).sort().map(file => join("tests", file));
  const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit", env: { ...process.env, AI_CONTEXT_SYNC_TEST_OUTPUT: output } });
  process.exitCode = result.status ?? 1;
} finally { rmSync(output, { recursive: true, force: true }); }
