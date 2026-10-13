#!/usr/bin/env node
// Local preview for dashboard/edge-patches/tokentracker-embed-svg.ts without
// deploying to InsForge. The render helpers (renderProfileCard, placeholderSvg,
// PALETTE) are pure — a snapshot row in, an SVG string out — so only the
// cloud-only bits (the @insforge/sdk import and Deno.env reads) need stubbing.
//
// How it works: reads the edge file, strips the single `npm:@insforge/sdk`
// import, appends an export of the render helpers, writes the patched copy to
// a temp dir, and imports it with a `Deno` global stub. Node >= 22.6 strips
// the TypeScript types natively, so no build step is needed — that floor is
// higher than the package's `engines.node` (>=20), because Node 20 cannot
// import a .ts file at all, so it is checked for explicitly below.
//
// Usage:
//   node scripts/preview-embed-svg.mjs [--theme dark|light] [--period week|month|total]
//                                      [--name "Display Name"]
//                                      [--all-providers] [--out file.svg] [--no-open]
//
// The mock row mirrors a tokentracker_leaderboard_snapshots row (12.52B total,
// Claude 60% / Codex 26% / Hermes 13%) so output matches a real badge closely.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node 20 satisfies `engines.node` but cannot strip types off a .ts import, and
// the failure it produces is an opaque ERR_UNKNOWN_FILE_EXTENSION. Fail here
// with something that names the actual cause instead.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 6)) {
  console.error(
    `preview-embed-svg.mjs needs Node >= 22.6 for native TypeScript stripping; ` +
      `this is ${process.versions.node}.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const theme = get("--theme", "dark");
const period = get("--period", "total");
const name = get("--name", "Rafi Ahmed");
const outFlag = get("--out", "embed-svg-preview.svg");
const shouldOpen = !args.includes("--no-open");

if (!["dark", "light"].includes(theme)) {
  console.error(`bad --theme: ${theme} (use dark|light)`);
  process.exit(1);
}
if (!["week", "month", "total"].includes(period)) {
  console.error(`bad --period: ${period} (use week|month|total)`);
  process.exit(1);
}
// Each theme writes its own file unless --out says otherwise, so rendering dark
// and light in a row doesn't silently overwrite one another.
const defaultOut = `embed-svg-preview-${theme}.svg`;
const out = args.includes("--out") ? outFlag : defaultOut;

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

// --all-providers spreads usage across every column so the preview shows the
// full provider panel (and every logo symbol) at once.
const mockRow = {
  user_id: "00000000-0000-0000-0000-000000000000",
  display_name: name,
  rank: 685,
  total_tokens: 12_520_000_000,
  estimated_cost_usd: 696.4,
  gpt_tokens: 3_000_000_000,
  claude_tokens: 6_900_000_000,
  gemini_tokens: 0,
  cursor_tokens: 0,
  hermes_tokens: 1_650_000_000,
  copilot_tokens: 0,
  is_public: true,
  generated_at: new Date().toISOString(),
  ...(args.includes("--all-providers")
    ? {
        gemini_tokens: 900_000_000,
        cursor_tokens: 600_000_000,
        copilot_tokens: 300_000_000,
      }
    : {}),
};

const svg = renderProfileCard({ row: mockRow, theme, period });
fs.writeFileSync(out, svg);
console.log(`wrote ${out} (theme=${theme} period=${period})`);
if (shouldOpen) {
  // execFile, not exec: the output path reaches the opener as its own argv
  // entry, so a crafted --out can't smuggle shell metacharacters through
  // JSON.stringify (which escapes nothing inside double quotes). The opener is
  // also picked per platform — `open` does not exist on Linux, and cmd's `start`
  // reads a quoted first argument as a window title rather than a file.
  const [cmd, cmdArgs] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', path.resolve(out)]]
      : process.platform === "darwin"
        ? ["open", [out]]
        : ["xdg-open", [out]];
  execFile(cmd, cmdArgs, () => {});
}
