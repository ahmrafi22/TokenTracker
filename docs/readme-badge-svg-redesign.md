# README badge SVG redesign — master plan

Date: 2026-10-07 · Branch: `Readme-batch` · Scope: `tokentracker-embed-svg` edge function (+ optional modal options)

## Goal

Redesign the embeddable profile card — the 600×180 SVG served by
`https://srctyff5.us-east.insforge.app/functions/tokentracker-embed-svg` that the
"Copy README badge" button on the leaderboard profile copies into user READMEs.
The current card is functional but flat: three equal-weight stat chips, a
plain-text provider list, and unused visual potential. The redesign gives it a
distinct "hero" hierarchy (tokens as the headline number), draws the provider
split as mini progress bars, and adds a gradient/glow treatment consistent with
the dashboard's emerald-on-slate brand. A second, opt-in compact variant
("statusline", 600×120) is included behind a new `style` param for users who
want a shorter badge.

Everything lives in one edge file; no database, RLS, or API-contract changes.
Existing embeds update automatically after deploy because the URL is unchanged
(60s cache). Contributor preview requires no deployment (pure-function trick +
`scripts/preview-embed-svg.mjs`, added on this branch).

## Current state — where every relevant piece lives

| Piece | Location (main @ c2661239) |
|---|---|
| Card SVG renderer (the thing we redesign) | `dashboard/edge-patches/tokentracker-embed-svg.ts` |
| Theme palettes (light/dark color maps) | same file, lines 40–58 (`PALETTE`, `BRAND_GREEN`) |
| Avatar (colored initial circle) | same file, `hashHue()` 103–107, `avatarSvg()` 109–122 |
| Card layout: chips, provider text, URL, TT mark | same file, `renderProfileCard()` 179–257 |
| Placeholder cards (private/blocked/error) | same file, `placeholderSvg()` 124–130 — **unchanged by this plan** |
| Query params (`user_id`, `theme`, `period`) | same file, handler 259–320 |
| Copied markdown snippet | `dashboard/src/components/leaderboard/LeaderboardProfileModal.jsx` 465–467 (`badgeSnippet`) |
| Copy buttons ("Copy profile URL" / "Copy README badge") | same file, `CopyAction` 409–433, rendered at 613–614 |
| Button label strings | `dashboard/src/content/copy.csv` keys `leaderboard.profile_modal.badge.*` (lines 1172–1174) |
| Related-but-untouched compact shield endpoint | `dashboard/edge-patches/tokentracker-badge-svg.ts` (already live; documented in `README.md:586-588`) |
| Existing pattern for testing edge TS in Node | `test/edge-pricing-parity.test.js` (esbuild `transformSync` + `node:vm`) |

Data available inside `renderProfileCard` comes from a
`tokentracker_leaderboard_snapshots` row (`SnapshotRow`, lines 132–146):
`display_name, rank, total_tokens, estimated_cost_usd, gpt_tokens,
claude_tokens, gemini_tokens, cursor_tokens, hermes_tokens, copilot_tokens,
is_public, generated_at`. Provider shares are computed from the six
per-provider columns; `windowBounds()` (149–177) resolves week/month/total
windows and stays untouched.

## Hard constraints (do not violate)

1. **Self-contained SVG only.** GitHub re-serves README images through its
   camo proxy; external fonts, `<image href>`, CSS imports, and scripts are
   unavailable. All text uses `font-family` stacks with system fallbacks
   (already the case). This rules out webfonts like Geist in the badge — stick
   to `Inter, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
   and a mono stack for the statusline variant.
2. **XML-escape every dynamic string** (`escapeXml`, lines 71–78) — display
   names are user input.
3. **Privacy gates stay exactly as-is**: `is_public === false` → 403
   placeholder, blocked-user env list → 404, bad params → 400 placeholders.
   `placeholderSvg()` is not redesigned.
4. **Keep `role="img"`, `aria-label`, and `<title>`** for accessibility.
5. **Cache headers stay 60s** (`svgResponse`) — deploy propagation is fast and
   CDN keys are per-URL, so the new `style` param gets its own cache entries.
6. **Deterministic avatar**: same display name must always render the same
   color (existing `hashHue` contract).
7. Canvas stays 600×180 for the default style so existing embeds keep their
   aspect ratio; the statusline variant opts into 600×120 explicitly.

## Chosen design

**Primary (default): Variant A "hero"** — drop-in replacement of
`renderProfileCard`, same 600×180 canvas. Layout (dark theme; light mirrors via
`PALETTE`):

- Background: vertical gradient `#111c33 → #0b1120`, 16px radius, 1px border
  `#1e2a44`, plus a radial emerald glow anchored top-right
  (`#10b981` at 14% → 0% opacity).
- Avatar: 48px gradient circle at (44,54) — two-stop `hsl()` gradient seeded
  by the existing `hashHue(displayName)`, initial centered.
- Header: name 21px/700 `#f8fafc` at (80,48); subtitle "TokenTracker ·
  All-time usage" 11.5px `#94a3b8` at (80,67); `www.tokentracker.cc` 11px
  `#64748b` right-aligned at (572,40).
- Stats row: `TOKENS` label 10px letter-spaced `#64748b` + value 30px/800
  `#f8fafc` (the hero); `COST` + value 20px/700; `RANK` + value 20px/700 in
  accent `#34d399`; 1px vertical dividers `#1e293b` at x=232 and x=332.
- Right panel "PROVIDER SPLIT": top-3 providers as label + percent +
  58px mini progress bars (track `#1e293b`, fill `#34d399` at opacity
  1 / 0.65 / 0.40 by rank).
- Mockups on this branch: `docs/design/readme-badge/mockup-a-dark.svg`,
  `mockup-a-light.svg` (baseline for comparison: `current-dark.svg`).

**Alternative (opt-in): Variant B "statusline"** — 600×120 strip, monospace,
served when `?style=statusline`. Single stats row (`11.55B tok │ $616 │
#652`), stacked full-width provider bar with color-coded segments and a
legend, small `TOKENTRACKER` / `tokentracker.cc` header row. Mockup:
`docs/design/readme-badge/mockup-b-dark.svg`. Default stays `hero`, so the
copied snippet URL works unchanged.

## Change 1 — `dashboard/edge-patches/tokentracker-embed-svg.ts` (the full SVG)

### 1.1 Replace `PALETTE` (lines 40–58)

```ts
const BRAND_GREEN = "#059669";
const PALETTE = {
  light: {
    bgTop: "#ffffff", bgBottom: "#f1f5f9", cardBorder: "#e5e7eb",
    fg: "#0f172a", muted: "#64748b", faint: "#94a3b8",
    accent: BRAND_GREEN, glowOpacity: 0.09,
    divider: "#e5e7eb", track: "#e2e8f0", pct: "#334155",
  },
  dark: {
    bgTop: "#111c33", bgBottom: "#0b1120", cardBorder: "#1e2a44",
    fg: "#f8fafc", muted: "#64748b", faint: "#94a3b8",
    accent: "#34d399", glowOpacity: 0.14,
    divider: "#1e293b", track: "#1e293b", pct: "#cbd5e1",
  },
};
```

### 1.2 Add two helpers (next to `compactNumber`, ~line 92)

```ts
// Name area runs x=80..440 (provider panel starts at 440); at 21px/700 that
// fits ~29 glyphs. Truncate to be safe — the current card overflows instead.
function truncateName(name: string, max = 26): string {
  return name.length > max ? name.slice(0, max - 1).trimEnd() + "…" : name;
}

// Top-3 providers by tokens with bar widths scaled to a 58px track.
function providerBars(row: SnapshotRow): Array<{ label: string; pct: number; width: number }> {
  const providers = [
    { label: "Claude", val: Number(row.claude_tokens ?? 0) },
    { label: "Codex", val: Number(row.gpt_tokens ?? 0) },
    { label: "Gemini", val: Number(row.gemini_tokens ?? 0) },
    { label: "Cursor", val: Number(row.cursor_tokens ?? 0) },
    { label: "Copilot", val: Number(row.copilot_tokens ?? 0) },
    { label: "Hermes", val: Number(row.hermes_tokens ?? 0) },
  ];
  const total = providers.reduce((s, x) => s + x.val, 0);
  return providers
    .filter((x) => x.val > 0)
    .sort((a, b) => b.val - a.val)
    .slice(0, 3)
    .map((x) => ({
      label: x.label,
      pct: total > 0 ? Math.round((x.val / total) * 100) : 0,
      width: total > 0 ? Math.round((x.val / total) * 58 * 10) / 10 : 0,
    }));
}
```

### 1.3 Replace `avatarSvg()` (lines 109–122)

Same shape/position contract, now a two-stop gradient seeded by `hashHue`
(light theme: 65%→55% lightness, white initial — mirrors today's contrast
rule; dark theme: 68%→58%, `#0f172a` initial):

```ts
function avatarSvg(displayName: string, theme: "light" | "dark"): string {
  const seed = (displayName || "anon").trim() || "anon";
  const hue = hashHue(seed);
  const initial = seed.charAt(0).toUpperCase();
  const stops = theme === "dark"
    ? [`hsl(${hue} 70% 68%)`, `hsl(${hue} 65% 58%)`]
    : [`hsl(${hue} 65% 48%)`, `hsl(${hue} 60% 38%)`];
  const fg = theme === "dark" ? "#0f172a" : "#ffffff";
  return `<g transform="translate(44 54)">
    <defs><linearGradient id="av" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${stops[0]}"/>
      <stop offset="1" stop-color="${stops[1]}"/>
    </linearGradient></defs>
    <circle r="24" fill="url(#av)"/>
    <text x="0" y="0" font-size="22" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="${fg}">${escapeXml(initial)}</text>
  </g>`;
}
```

(`font-family` is inherited from the enclosing `<g>` in the card body.)

### 1.4 Replace `renderProfileCard()` (lines 179–257) — Variant A

Full body (ready to paste; matches `mockup-a-dark.svg` / `mockup-a-light.svg`):

```ts
function renderProfileCard(opts: {
  row: SnapshotRow;
  theme: "light" | "dark";
  period: string;
}): string {
  const { row, theme, period } = opts;
  const p = PALETTE[theme];
  const FONT = "Inter, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const displayName = truncateName(row.display_name || "Anonymous");
  const tokens = compactNumber(Number(row.total_tokens ?? 0));
  const cost = formatCost(Number(row.estimated_cost_usd ?? 0));
  const rank = row.rank ? `#${row.rank}` : "—";
  const periodLabel = period.charAt(0).toUpperCase() + period.slice(1);
  const bars = providerBars(row);

  const barRows = bars.length
    ? bars
        .map((b, i) => {
          const y = 120 + i * 17;
          return `<text x="440" y="${y}" font-size="10.5" fill="${p.faint}">${escapeXml(b.label)}</text>
    <text x="492" y="${y}" font-size="10.5" fill="${p.pct}" text-anchor="end">${b.pct}%</text>
    <rect x="498" y="${y - 6}" width="58" height="5" rx="2.5" fill="${p.track}"/>
    <rect x="498" y="${y - 6}" width="${b.width}" height="5" rx="2.5" fill="${p.accent}" fill-opacity="${[1, 0.65, 0.4][i]}"/>`;
        })
        .join("\n    ")
    : `<text x="440" y="120" font-size="10.5" fill="${p.faint}">No provider data yet</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="180" viewBox="0 0 600 180" role="img" aria-label="${escapeXml(row.display_name || "Anonymous")} on TokenTracker">
  <title>${escapeXml(row.display_name || "Anonymous")} — ${tokens} tokens, ${cost}, rank ${rank}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.bgTop}"/><stop offset="1" stop-color="${p.bgBottom}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.05" r="0.7">
      <stop offset="0" stop-color="${p.accent}" stop-opacity="${p.glowOpacity}"/>
      <stop offset="1" stop-color="${p.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="180" rx="16" fill="url(#bg)" stroke="${p.cardBorder}"/>
  <rect width="600" height="180" rx="16" fill="url(#glow)"/>
  ${avatarSvg(row.display_name || "Anonymous", theme)}
  <g font-family="${FONT}">
    <text x="80" y="48" font-size="21" font-weight="700" fill="${p.fg}">${escapeXml(displayName)}</text>
    <text x="80" y="67" font-size="11.5" fill="${p.muted}">TokenTracker · ${escapeXml(periodLabel)} usage</text>
    <text x="572" y="40" font-size="11" fill="${p.muted}" text-anchor="end">www.tokentracker.cc</text>
    <line x1="232" y1="98" x2="232" y2="152" stroke="${p.divider}"/>
    <line x1="332" y1="98" x2="332" y2="152" stroke="${p.divider}"/>
    <text x="80" y="112" font-size="10" letter-spacing="2" fill="${p.muted}">TOKENS</text>
    <text x="80" y="146" font-size="30" font-weight="800" fill="${p.fg}">${escapeXml(tokens)}</text>
    <text x="252" y="112" font-size="10" letter-spacing="2" fill="${p.muted}">COST</text>
    <text x="252" y="146" font-size="20" font-weight="700" fill="${p.fg}">${escapeXml(cost)}</text>
    <text x="352" y="112" font-size="10" letter-spacing="2" fill="${p.muted}">RANK</text>
    <text x="352" y="146" font-size="20" font-weight="700" fill="${p.accent}">${escapeXml(rank)}</text>
    <text x="440" y="102" font-size="10" letter-spacing="1.5" fill="${p.muted}">PROVIDER SPLIT</text>
  </g>
  <g font-family="${FONT}">
    ${barRows}
  </g>
</svg>`;
}
```

Behavior notes vs. today: the `TOP PROVIDERS` heading + text list and the
`TT` mark are replaced by the bar panel (the URL text carries attribution);
the period subtitle gains the word "usage" (`Week usage` / `Month usage` /
`Total usage` — matches the mockups).

### 1.5 Variant B — `renderStatuslineCard()` (new function, opt-in param)

Add a renderer producing `mockup-b-dark.svg` (600×120): header row
`TOKENTRACKER` / `tokentracker.cc` (9px, `#475569`), avatar 30px at (40,58),
name 15px mono, right-aligned stats `11.55B tok │ $616 │ #652` (13px mono,
accent on rank), stacked provider bar x=24..576 y=86 h=8 (segments colored
per provider — Claude `#10b981`, Codex `#6366f1`, Gemini `#f59e0b`, Cursor
`#ef4444`, Copilot `#8b5cf6`, Hermes `#f472b6` — widths proportional to
share over a `#1e293b` track, clipped to `rx=4`), legend dots+labels for the
top-3 at y=110. Light theme: bg `#ffffff`, border `#e5e7eb`, track
`#e2e8f0`, same provider hues. Mono stack:
`ui-monospace, 'JetBrains Mono', 'Cascadia Code', Consolas, monospace`.

### 1.6 Handler wiring (lines 259–320)

- Parse: `const style = (url.searchParams.get("style") || "hero").toLowerCase();`
- Validate: allow `hero | statusline`, else `placeholderSvg("bad style", theme)` 400.
- Select: `const svg = style === "statusline" ? renderStatuslineCard({...}) : renderProfileCard({...});`
- `aria-label`/`<title>` for B: `${name} — ${tokens} tokens, ${cost}, rank ${rank} on TokenTracker`.
- Everything else (blocked list, privacy gate, `windowBounds`, cache headers) untouched.

## Change 2 (optional, frontend-only — no deploy needed to ship)

Wire the already-live params into the copy UI in
`dashboard/src/components/leaderboard/LeaderboardProfileModal.jsx`:

1. Replace the single `badgeSnippet` (lines 465–467) with a builder:
   `buildBadgeSnippet({ style, theme, period })` → for `hero` keep the current
   URL shape (`…/tokentracker-embed-svg?user_id=…&theme=…&period=…`); for
   `statusline` use `…/tokentracker-embed-svg?user_id=…&theme=…&period=…&style=statusline`.
2. Render a small segmented control (theme: Dark/Light · period: All-time/
   This month/This week · style: Big card/Statusline) above the copy row at
   lines 613–614; the existing `CopyAction` copies whatever the controls
   select. Show the badge image itself above the buttons (already-rendered
   preview) with the same params.
3. New copy keys in `dashboard/src/content/copy.csv` (same format as
   `leaderboard.profile_modal.badge.copy` on line 1173), e.g.
   `leaderboard.profile_modal.badge.theme_dark` = "Dark",
   `…badge.theme_light` = "Light", `…badge.period_total` = "All-time",
   `…badge.period_month` = "This month", `…badge.period_week` = "This week",
   `…badge.style_card` = "Big card", `…badge.style_statusline` = "Statusline".
   `npm run ci:local` runs `validate-copy-registry` / `validate-locale-coverage`
   — if they flag the new keys, add the missing locale strings the same way
   existing rows handle it.
4. This part is independently verifiable with zero deployment: the modal's
   badge image is fetched from production, which already renders every param.

## Change 3 — golden test `test/edge-embed-svg.test.js` (new)

Follow the `test/edge-pricing-parity.test.js` execution pattern (esbuild
`transformSync` + `node:vm`, with the `npm:@insforge/sdk` import stripped and
`globalThis.Deno` stubbed — `scripts/preview-embed-svg.mjs` shows the exact
loader). Assert:

- Dark output contains `#34d399`; light output contains `#059669`; both
  contain `width="600" height="180"`.
- Mock row renders `11.55B`, `$616`, `#652`, and the display name.
- A 60-char display name renders truncated with `…` and no raw newline inside
  `<text>`.
- `<`, `>`, `&`, quotes in the display name come back XML-escaped.
- Empty provider columns render `No provider data yet`.
- `?style=statusline` output contains `height="120"` (assert via
  `renderStatuslineCard` once added).

Gate: `npm run ci:local` must pass (tests + copy/architecture validation +
builds).

## Verification workflow (contributor, no deploy)

1. `node scripts/preview-embed-svg.mjs --theme dark` and `--theme light` —
   renders the current edge file with a realistic mock row and opens the SVG.
   Iterate: edit `tokentracker-embed-svg.ts`, re-run, refresh.
2. Open `docs/design/readme-badge/*.svg` side by side with the preview output
   (or the temp-dir `index.html` gallery from the design session).
3. Paste the copied markdown into a GitHub README/gist to confirm camo
   rendering (fonts fall back per-machine — expected; layout must hold).
4. `npm run ci:local` for the full gate.

## Deployment & rollout (maintainer)

1. Merge PR → deploy the touched function per the InsForge CLI workflow
   (`insforge functions deploy tokentracker-embed-svg`, project configured in
   `.insforge/project.json` on the maintainer side — same step CLAUDE.md
   requires after edge edits).
2. No DB migration, no RLS change, no new secrets. `LEADERBOARD_BLOCKED_USER_IDS`
   behavior unchanged.
3. Existing embeds pick up the new design automatically (same URL; 60s
   `max-age`/`s-maxage`). The added `style` param is purely additive.
4. Rollback = revert + redeploy; worst case is a 60s stale window.

## Risks & mitigations

- **Font metric drift** across renderers (GitHub camo rasterizes SVG) —
  mitigated by conservative truncation (`truncateName`), fixed positions, and
  no `textLength` stretching on the hero card.
- **Percent rounding** may not sum to exactly 100 — acceptable (already true
  today); displayed as independent percentages.
- **Provider totals ignore unmapped providers** — same as current card; noted
  in the card copy as "provider split", not "all usage".
- **Light-theme contrast** of `hsl(h 60% 38%)` avatar + white initial —
  matches the contrast rule the current light avatar already uses.
- **`id` collisions** in `<defs>` (`bg`, `glow`, `av`) — safe: GitHub serves
  one SVG per `<img>`; ids are document-scoped per image.

## Out of scope

Real avatar images, webfonts, animations/SMIL, shields.io proxying, DB/API
changes, the compact `tokentracker-badge-svg` endpoint (already live and
documented), and any change to the privacy/blocked gating.

## Checklist

- [ ] 1.1–1.4 Variant A implemented in `tokentracker-embed-svg.ts`
- [ ] 1.5–1.6 `style=statusline` renderer + handler param
- [ ] Change 2 modal pickers + copy.csv keys (optional, separate commit)
- [ ] Change 3 golden test added; `npm run ci:local` green
- [ ] Local previews captured for dark/light × hero/statusline
- [ ] PR opened with before/after SVGs from `docs/design/readme-badge/`
- [ ] Maintainer deploys `tokentracker-embed-svg` after merge
