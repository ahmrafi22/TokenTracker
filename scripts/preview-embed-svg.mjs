#!/usr/bin/env node
// Local preview for dashboard/edge-patches/tokentracker-embed-svg.ts without
// deploying to InsForge. The render helpers (renderProfileCard, PALETTE,
// avatarSvg) are pure — a snapshot row in, an SVG string out — so only the
// cloud-only bits (the @insforge/sdk import and Deno.env reads) need stubbing.
//
// How it works: reads the edge file, strips the single `npm:@insforge/sdk`
// import, appends an export of the render helpers, writes the patched copy to
// a temp dir, and imports it with a `Deno` global stub. Node >= 22.6 strips
// the TypeScript types natively, so no build step is needed.
//
// Usage:
//   node scripts/preview-embed-svg.mjs [--theme dark|light] [--period week|month|total]
//                                      [--name "Display Name"] [--out file.svg] [--no-open]
//
// The mock row mirrors a tokentracker_leaderboard_snapshots row (11.55B total,
// Claude 60% / Codex 26% / Hermes 13%) so output matches a real badge closely.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const theme = get("--theme", "dark");
const period = get("--period", "total");
const name = get("--name", "Rafi Ahmed");
const out = get("--out", "embed-svg-preview.svg");
const shouldOpen = !args.includes("--no-open");

if (!["dark", "light"].includes(theme)) {
  console.error(`bad --theme: ${theme} (use dark|light)`);
  process.exit(1);
}
if (!["week", "month", "total"].includes(period)) {
  console.error(`bad --period: ${period} (use week|month|total)`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edgePath = path.join(root, "dashboard", "edge-patches", "tokentracker-embed-svg.ts");
let source = fs.readFileSync(edgePath, "utf8");
if (!/export \{ renderProfileCard/.test(source)) {
  source = source
    .replace(/^import \{ createClient \} from "npm:@insforge\/sdk";\r?\n/m, "")
    .concat("\nexport { renderProfileCard, placeholderSvg, PALETTE };\n");
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-svg-"));
const patchedPath = path.join(tmpDir, "embed.ts");
fs.writeFileSync(patchedPath, source);
fs.writeFileSync(path.join(tmpDir, "package.json"), '{"type":"module"}');

// The edge module reads Deno.env at top level (blocked-user list); the render
// helpers never touch it, so an always-empty stub is enough for previews.
globalThis.Deno = { env: { get: () => "" } };
const { renderProfileCard } = await import(pathToFileURL(patchedPath).href + `?v=${Date.now()}`);

const mockRow = {
  user_id: "00000000-0000-0000-0000-000000000000",
  display_name: name,
  rank: 652,
  total_tokens: 11_550_000_000,
  estimated_cost_usd: 616.4,
  gpt_tokens: 3_000_000_000,
  claude_tokens: 6_900_000_000,
  gemini_tokens: 0,
  cursor_tokens: 0,
  hermes_tokens: 1_650_000_000,
  copilot_tokens: 0,
  is_public: true,
  generated_at: new Date().toISOString(),
};

const svg = renderProfileCard({ row: mockRow, theme, period });
fs.writeFileSync(out, svg);
console.log(`wrote ${out} (theme=${theme} period=${period})`);
if (shouldOpen) {
  exec(`${process.platform === "win32" ? "start" : "open"} ${JSON.stringify(out)}`);
}
