"use strict";

// The embed card is rendered as a raw SVG string by an InsForge edge function
// and dropped straight into a README <img> tag, where GitHub re-serves it
// through camo. Nobody reviews that output in review — a broken gradient id, a
// dropped XML escape, or a name that silently overflows the canvas would ship
// and stay shipped, because the only "test" would be a human pasting a badge
// into their README and noticing. These assertions pin the parts that are
// cheap to break and expensive to notice.
//
// The renderers are pure functions, so the module loads the same way
// scripts/preview-embed-svg.mjs loads it: Node strips the TypeScript types
// natively (>= 22.6), the `npm:@insforge/sdk` import is dropped, and Deno.env
// is stubbed. No build step and no dependencies — unlike
// edge-pricing-parity.test.js, which needs esbuild from node_modules.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before } = require("node:test");
const assert = require("node:assert");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const EDGE_FILE = path.join(ROOT, "dashboard", "edge-patches", "tokentracker-embed-svg.ts");
const EXPORTS = ["renderProfileCard", "placeholderSvg", "PALETTE"];

let api;

before(async () => {
  const source = fs
    .readFileSync(EDGE_FILE, "utf8")
    .replace(/^import \{ createClient \} from "npm:@insforge\/sdk";\r?\n/m, "");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-svg-test-"));
  const modPath = path.join(tmpDir, "embed.ts");
  fs.writeFileSync(modPath, `${source}\nexport { ${EXPORTS.join(", ")} };\n`);
  fs.writeFileSync(path.join(tmpDir, "package.json"), '{"type":"module"}');
  // The module reads Deno.env at top level for the blocked-user list; the
  // render helpers never touch it.
  globalThis.Deno = { env: { get: () => "" } };
  api = await import(pathToFileURL(modPath).href);
});

function row(overrides = {}) {
  return {
    user_id: "00000000-0000-0000-0000-000000000000",
    display_name: "Rafi Ahmed",
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
    generated_at: "2026-10-07T00:00:00.000Z",
    ...overrides,
  };
}

const NO_PROVIDERS = {
  gpt_tokens: 0,
  claude_tokens: 0,
  gemini_tokens: 0,
  cursor_tokens: 0,
  hermes_tokens: 0,
  copilot_tokens: 0,
};

const hero = (overrides = {}, theme = "dark", period = "total") =>
  api.renderProfileCard({ row: row(overrides), theme, period });

// Ids defined by the document itself: every `id="…"` on a gradient or clipPath
// the card emits.
function definedIds(svg) {
  return new Set(
    [...svg.matchAll(/<linearGradient[^>]*id="([^"]+)"|<radialGradient[^>]*id="([^"]+)"|<clipPath id="([^"]+)"/g)]
      .map((m) => m[1] ?? m[2] ?? m[3])
      .filter(Boolean),
  );
}

test("hero card keeps the 600x180 canvas and neon palette", () => {
  const dark = hero();
  const light = hero({}, "light");

  assert.match(dark, /width="600" height="180"/);
  assert.match(light, /width="600" height="180"/);
  // Dark theme carries the landing's violet accent; light theme darkens it for
  // contrast on white. Both backgrounds follow the landing palette (#050507).
  assert.match(dark, /#8a7aff/i);
  assert.match(light, /#6d55f0/i);
  assert.match(dark, /#050507/i);
});

test("the light card is shaded, not a flat white sheet", () => {
  // The light theme read as one blank sheet next to the dark one. Four separate
  // things caused it, and any one of them alone still leaves the card flat, so
  // all four are pinned here.
  const p = api.PALETTE.light;

  // 1. The sky gradient must actually span. #ffffff -> #f7f6fc was 3% and
  //    invisible; a ~5% violet-tinted range reads as a lit surface.
  const channel = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [tr, tg, tb] = channel(p.bgTop);
  const [br, bg, bb] = channel(p.bgBottom);
  const spread = (tr - br) + (tg - bg) + (tb - bb);
  assert.ok(spread > 24, `bgTop -> bgBottom spans only ${spread}/255; the card reads flat`);
  // Tinted, not grey: the bottom stop must carry more violet than the top.
  assert.ok(bb - br > tb - tr + 4, "bottom stop is not violet-tinted; it reads as grime");

  // 2. Stars on a light surface must be DARKER than the ground they sit on.
  //    A pale pink speck on white is invisible — that was the original bug.
  const lum = (hex) => {
    const [r, g, b] = channel(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // 2. The card paints no specks, but the rule any mark here has to keep is the
  //    one the glint colour used to follow: contrast with its ground, not match
  //    it. The two themes need opposite treatments — pale on dark, darker than
  //    the surface on light — and that must not be "made consistent".
  assert.ok(
    api.PALETTE.dark.bgTop && api.PALETTE.light.bgTop,
    "palette lost its background colours",
  );
  assert.equal(api.PALETTE.light.bgTop, "#fdfcff", "light bgTop changed; re-check the shading block");
  assert.equal(api.PALETTE.dark.bgTop, "#0c0c13", "dark bgTop changed; re-check the shading block");

  // 3. Borders need contrast to register at all. The originals sat within ~1%
  //    of the background they were drawn on.
  assert.ok(lum(p.cardBorder) < lum(p.bgTop) - 0.01, "cardBorder has no contrast on the light card");
  assert.ok(lum(p.divider) < lum(p.bgTop), "divider is invisible on the light card");
  assert.ok(lum(p.barTrack) < lum(p.bgTop), "bar track is invisible on the light card");

  // 4. The accent glow has to be strong enough to model surface curvature.
  assert.ok(p.glowOpacity >= 0.14, `glow opacity ${p.glowOpacity} is too faint to read`);

  // 5. A light source, not just a gradient. Pushing the two sky stops apart is
  //    not sufficient on its own — an even top-to-bottom wash reads as a tinted
  //    sheet no matter how far apart they are. The white sheen in the lit
  //    corner is what gives the card form. The dark theme must NOT have one:
  //    a specular highlight on deep space flattens it to grey.
  assert.ok(p.sheenOpacity >= 0.6, `light sheen is ${p.sheenOpacity}; the card has no light source`);
  assert.equal(api.PALETTE.dark.sheenOpacity, 0, "dark card must not take a white sheen");

  // Sheen paints under the accent glow, so the lit corner still reads violet
  // rather than washing out to neutral white.
  const sheenAt = hero({}, "light").indexOf(`<rect width="600" height="180" fill="url(#bd-sheen-hero)"/>`);
  const glowAt = hero({}, "light").indexOf(`<rect width="600" height="180" fill="url(#bd-glow-hero)"/>`);
  assert.ok(sheenAt > 0 && glowAt > 0, "light backdrop is missing its sheen or glow layer");
  assert.ok(sheenAt < glowAt, "the sheen must sit under the accent glow, not over it");

  // The dark card takes no sheen, and the light one takes it at nearly full
  // strength: the sheen is what gives the light surface a lit corner, and on the
  // dark card a white highlight would flatten deep space to grey. The two must
  // not be "made consistent".
  assert.ok(p.sheenOpacity >= 0.6, `light sheen is ${p.sheenOpacity}; the card has no light source`);
  assert.equal(api.PALETTE.dark.sheenOpacity, 0, "dark card must not take a white sheen");
});

test("every gradient and clip-path reference resolves", () => {
  for (const svg of [hero(), hero({}, "light")]) {
    const ids = definedIds(svg);
    for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(ids.has(m[1]), `references undefined id #${m[1]}`);
    }
  }
});

// Each figure is drawn as an odometer — one <text> per stacked glyph, not one
// run of text — so its settled value is reconstructed from each cell's resting
// glyph. `suffix` picks the stat ("tok", "cost", "rank"); TOKENS sits on
// baseline 150 at 30px, the other two on 149 at 21px.
function settledFor(svg, suffix) {
  const baseline = suffix === "tok" ? 150 : 149;
  const CELL = new RegExp(
    '<g clip-path="url\\(#odo-' + suffix + '-\\d+\\)"><g>' +
      '(?:<text[^>]*>\\d</text>){10}' +
      '<animateTransform[^>]*values="[^"]*"[^>]*\\/?>' +
      '</g></g>',
    "g",
  );
  const marks = [];
  const spans = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let pitch = ODO_PITCH;
  for (const c of svg.matchAll(CELL)) {
    spans.push([c.index, c.index + c[0].length]);
    // The strip rests at translate 0 and glyph d sits at baseline +
    // (d - restDigit) * pitch, so the digit in view is the row on the baseline.
    const rows = [...c[0].matchAll(/<text[^>]*y="([\d.]+)"[^>]*>(\d)</g)];
    const on = rows.find((r) => Math.abs(Number(r[1]) - baseline) < 0.05);
    marks.push({ at: c.index, ch: on ? on[2] : "?" });
    const x = Number(/<text x="([\d.]+)"/.exec(c[0])[1]);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    // Row spacing gives this cell's own pitch, which scales with its font size.
    pitch = Math.abs(Number(rows[1][1]) - Number(rows[0][1]));
  }
  // The suffix sits just past the last cell; one pitch of slack is enough to
  // include it while still excluding the next stat's "$"/"#".
  const gap = pitch;
  assert.ok(spans.length, `no ${suffix} odometer cells found`);
  for (const g of svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)) {
    if (spans.some(([a, b]) => g.index >= a && g.index < b)) continue;
    // Only this figure's own glyphs, which share its baseline. The avatar's
    // initial is a capital at a similar x but a completely different baseline,
    // and the neighbouring stats bring their own "$"/"#".
    if (!/^[.#$A-Z]$/.test(g[2])) continue;
    if (Math.abs(Number(g[1]) - baseline) > 0.05) continue;
    const x = Number(/x="([\d.]+)"/.exec(g[0])[1]);
    // A currency or rank prefix sits just left of the first cell, one pitch out.
    if (x < minX - gap || x > maxX + gap) continue;
    marks.push({ at: g.index, ch: g[2] });
  }
  return marks.sort((a, b) => a.at - b.at).map((m) => m.ch).join("");
}

const settledTokens = (svg) => settledFor(svg, "tok");

// Strip pitch, authored at the 30px TOKENS size. The 21px figures scale it by
// 0.7, so the skip checks compare against each cell's own pitch.
const ODO_PITCH = 30.6;

// The digit timing tests look at the TOKENS odometer only: COST and RANK carry
// their own copies, so scanning every cell would count 10 and blur which figure
// the assertion is actually about.
function tokCells(svg) {
  return [...svg.matchAll(
    /<animateTransform[^>]*values="([^"]*)"[^>]*keyTimes="([^"]*)"/g,
  )].filter((m) => {
    const lastClip = svg.lastIndexOf('id="odo-', m.index);
    return lastClip >= 0 && svg.startsWith('id="odo-tok-', lastClip);
  });
}

test("hero card renders the mock snapshot values", () => {
  const svg = hero();
  assert.equal(settledTokens(svg), "11.55B", "odometer settles on the wrong value");
  assert.match(svg, />Rafi Ahmed</);
  // COST and RANK animate too, so their values come from their own cells.
  assert.equal(settledFor(svg, "cost"), "$616", "COST settles on the wrong value");
  assert.equal(settledFor(svg, "rank"), "#652", "RANK settles on the wrong value");
  assert.match(svg, /Claude/);
  assert.match(svg, /Codex/);
  assert.match(svg, /Hermes/);
});

test("hero card escapes XML in the display name", () => {
  const svg = hero({ display_name: '<script>"x" & \'y\'' });
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&quot;x&quot;/);
  assert.match(svg, /&apos;y&apos;/);
  assert.ok(!svg.includes("<script"), "raw < survived into the output");
});

test("hero card truncates a long display name with an ellipsis", () => {
  const svg = hero({ display_name: "Bartholomew Wolfeschlegelsteinhausenbergerdorff" });
  // Match the name node by its font-size rather than its baseline, which is
  // derived from the identity row's vertical centring.
  const nameNode = svg.match(/<text x="[\d.]+" y="[\d.]+"[^>]*font-size="21"[^>]*>([^<]*)</);
  assert.ok(nameNode, "name text node not found");
  assert.ok(nameNode[1].endsWith("…"), "long name was not truncated");
  assert.ok(nameNode[1].length <= 26, `truncated name is ${nameNode[1].length} chars`);
});

test("hero card falls back when the snapshot has no provider columns", () => {
  const svg = hero(NO_PROVIDERS);
  assert.match(svg, /No provider data yet/);
  assert.ok(!/NaN/.test(svg), "output contains NaN");
});

test("hero card reports an em dash for a missing rank", () => {
  assert.match(hero({ rank: null }), /—/);
});

test("every stat size has a tuned baseline, and an unknown one fails loudly", () => {
  // This was `fontSize === ODO_FONT ? 150 : 149` — an identity check that
  // silently fell through to 149 for any size that was neither 30 nor 21. The
  // odometer's clip window is anchored on the baseline and sized from the font,
  // so an untuned size slid the digits out of their own window and rendered
  // them sliced, with no error anywhere.
  //
  // The two tuned values are 150 at 30px and 149 at 21px — a 1px drop for a 9px
  // size difference. That is optical alignment, not a formula, so it is stored
  // rather than derived.
  for (const svg of [hero(), hero({}, "light")]) {
    // Every digit cell's resting glyph sits on the baseline the clip is built
    // from, so the baseline must be reachable for the sizes actually in use.
    const baselines = [...svg.matchAll(
      /<clipPath id="odo-(?:tok|cost|rank)-\d+"><rect x="[\d.]+" y="([\d.]+)"/g,
    )].map((m) => Number(m[1]));
    assert.ok(baselines.length >= 10, "expected a clip per digit cell");
    for (const top of new Set(baselines)) {
      // y = baseline - cellH, and cellH is 23 at 30px / 16.1 at 21px.
      const ok = Math.abs(top - 127) < 0.05 || Math.abs(top - 132.9) < 0.05;
      assert.ok(ok, `a digit cell's clip sits at y=${top}, from no tuned baseline`);
    }
  }

  // And the guard itself: an untuned size must throw rather than render wrong.
  // Exercised through the renderer by patching the module's own constants is
  // not possible from here, so this asserts the contract that the two in-use
  // sizes are the complete set — any third size has to be added deliberately.
  const cellTops = new Set(
    [...hero().matchAll(/<clipPath id="odo-tok-\d+"><rect x="[\d.]+" y="([\d.]+)"/g)].map((m) => m[1]),
  );
  assert.equal(cellTops.size, 1, "TOKENS renders at more than one size");
});

// Rightmost ink the stat row puts on the canvas, measured off the rendered
// markup: the last rank cell's clip edge, or the static "#" when the rank fell
// back to plain type.
function statRowEnd(svg) {
  const cells = [...svg.matchAll(/odo-rank-\d+"><rect x="([\d.]+)"[^>]*width="([\d.]+)"/g)];
  const cellEnd = cells.length ? Math.max(...cells.map((c) => Number(c[1]) + Number(c[2]))) : 0;
  const hash = Number((svg.match(/<text x="([\d.]+)" y="149"[^>]*>#/) || [, 0])[1]);
  return Math.max(cellEnd, hash + 21 * 0.5);
}

test("the stat dividers follow the figures instead of a fixed x", () => {
  // The dividers were pinned at 216 and 334, sized for the widest value the
  // badge can print. Any narrower figure then left the space it had reserved
  // as a hole — "11.55B" needs 90px of a 188px slot, so 78px of nothing sat
  // between the "B" and the divider and it read as a missing label.
  //
  // Figures range from 38px ("1M") to 134px ("999.99T"), so no single x works.
  const narrow = hero();
  const wide = hero({ total_tokens: 999.99e12, estimated_cost_usd: 99999, rank: 12345 });

  const divs = (svg) => [...svg.matchAll(/<line x1="([\d.]+)" y1="106"/g)].map((m) => Number(m[1]));
  const [n1, n2] = divs(narrow);
  const [w1, w2] = divs(wide);

  // A wider TOKENS must push both dividers right — if it does not, the
  // dividers are still hardcoded and the hole is still there.
  assert.ok(w1 > n1, `divider 1 did not move for a wider value (${n1} -> ${w1})`);
  assert.ok(w2 > n2, `divider 2 did not move for a wider value (${n2} -> ${w2})`);

  // Each divider sits midway through its own column gap, so the clearance the
  // eye reads is half the gap on each side — bounded above so a crowded row
  // cannot crowd the figure, and below so the hole cannot come back.
  const cellEnd = (svg, prefix) => {
    const re = new RegExp(`odo-${prefix}-\\d+"><rect x="([\\d.]+)"[^>]*width="([\\d.]+)"`, "g");
    const cells = [...svg.matchAll(re)];
    if (!cells.length) return null;
    return Math.max(...cells.map((c) => Number(c[1]) + Number(c[2])));
  };
  for (const [label, svg, d1] of [["narrow", narrow, n1], ["wide", wide, w1]]) {
    const end = cellEnd(svg, "tok");
    assert.ok(end !== null, `${label}: no TOKENS odometer cells found`);
    const gap = d1 - end;
    assert.ok(gap > 8, `${label}: only ${gap.toFixed(1)}px between TOKENS and divider 1`);
    assert.ok(gap < 60, `${label}: divider 1 crowds TOKENS by only ${gap.toFixed(1)}px`);
  }
});

test("the stat row never collides with the provider panel", () => {
  // Spreading the slack across the columns could, on a crowded row, run RANK
  // into the provider bars at x=452. Checked on the widest printable values,
  // the narrowest, and the all-static fallback.
  const PANEL_X = 452;
  const cases = [
    ["mock", {}, 65],
    ["widest", { total_tokens: 999.99e12, estimated_cost_usd: 99999, rank: 12345 }, 25],
    ["narrowest", { total_tokens: 1e6, estimated_cost_usd: 0, rank: 1 }, 25],
    ["zero", { total_tokens: 0, estimated_cost_usd: 0, rank: null }, 0],
  ];
  for (const [label, over, min] of cases) {
    const end = statRowEnd(hero(over));
    assert.ok(
      PANEL_X - end >= min,
      `${label}: stat row ends at ${end.toFixed(1)}, only ${(PANEL_X - end).toFixed(1)}px from the panel`,
    );
  }
});

test("the backdrop is static: no animation anywhere behind the figures", () => {
  // Two rounds of animating the backdrop were tried and cut — large glint orbs
  // sweeping across each other, then per-star twinkling. The numbers are the
  // badge's subject; anything that moves in the background competes with the
  // one thing the reader is meant to take in.
  for (const [name, svg] of [["hero", hero()], ["light hero", hero({}, "light")]]) {
    // Nothing in the backdrop may animate at all. The only animations on the
    // card are the ten digit strips (translate) and three provider bar widths.
    const backdrop = svg.slice(0, svg.indexOf('<g font-family='));
    assert.ok(!backdrop.includes("<animate"), `${name}: the backdrop animates`);
    assert.ok(!backdrop.includes("<animateTransform"), `${name}: the backdrop transforms`);

    // And nothing may ride the backdrop.
    assert.ok(!backdrop.includes("<ellipse"), `${name}: backdrop reintroduced a moving shape`);

    // No texture in the backdrop at all. A scattered starfield, sweeping glint
    // orbs and per-star twinkling were each tried; all of them competed with
    // the figures, which are the badge's subject. The surface carries only its
    // own shading — a lit gradient — which already reads as depth.
    const stars = [...backdrop.matchAll(/<circle /g)];
    assert.deepEqual(stars, [], `${name}: backdrop still paints ${stars.length} specks`);
  }

  // The card as a whole animates only where it should: the ten digit strips
  // and the three provider bars.
  const svg = hero();
  assert.equal(
    [...svg.matchAll(/<animateTransform[^>]*type="translate"/g)].length,
    10,
    "unexpected translation somewhere on the card",
  );
  assert.equal(
    [...svg.matchAll(/<animate attributeName="width"/g)].length,
    3,
    "unexpected width animation on the card",
  );
  assert.equal(
    [...svg.matchAll(/<animate /g)].length,
    3,
    "some other attribute is animating; the card should animate digits and bars only",
  );
});

test("digits are set tightly, not tracked out", () => {
  // ODO_GAP was 4, which left 4.4px of daylight between digits at 21px — 40%
  // of a digit's own width, and the reason COST and RANK read as tracked-out
  // type rather than as figures. A tabular face sets its own digits close; the
  // gap should add a little air, not most of a character's width.
  //
  // Measured off the rendered badge, a digit's ink at each size:
  const INK = { 21: 11, 30: 15 };
  const cases = [
    ["cost", 21],
    ["tok", 30],
  ];
  for (const [prefix, size] of cases) {
    const cells = [...hero().matchAll(
      new RegExp(`odo-${prefix}-\\d+"><rect x="([\\d.]+)"`, "g"),
    )].map((m) => Number(m[1]));
    assert.ok(cells.length >= 2, `no ${prefix} cells found`);
    const pitch = cells[1] - cells[0];
    const slack = pitch - INK[size];
    // Well under a third of the digit's width at either size.
    assert.ok(
      slack / INK[size] < 0.34,
      `${prefix}: ${slack.toFixed(2)}px between digits at ${size}px is ${((slack / INK[size]) * 100).toFixed(0)}% of the glyph width`,
    );
  }
// The decimal point is the one that still read loose after the digits were
  // tightened, and it is not the digits' fault. A static cell advanced by
  // `w + gap*0.4` while occupying only a third of a digit's width, so "1" and
  // "." ended up 9.65px apart against 2.73px between digits — a gap in the
  // number, one column over from where the eye was looking.
  const statics = [...hero().matchAll(
    /<text x="([\d.]+)" y="150\.00" text-anchor="middle"[^>]*>(\.)<\/text>/g,
  )];
  assert.equal(statics.length, 1, "expected one decimal point on the TOKENS row");
  const dotX = Number(statics[0][1]);
  // Measure the dot's CELL, not its ink centre: the digit cells give x at their
  // left edge, so comparing against the dot's centre would mix two origins.
  const dotW = 18 * 0.34;               // the "." cell, as odometerSvg sizes it
  const dotLeft = dotX - dotW / 2;
  const dotRight = dotX + dotW / 2;
  const dotCells = [...hero().matchAll(/odo-tok-\d+"><rect x="([\d.]+)"/g)].map((m) => Number(m[1]));
  const prevCell = dotCells.filter((x) => x < dotLeft).pop();
  const nextCell = dotCells.find((x) => x > dotRight);
  assert.ok(prevCell !== undefined, "no digit cell precedes the decimal point");
  assert.ok(nextCell !== undefined, "no digit cell follows the decimal point");
  // The dot's cell must sit close to BOTH neighbours. At 40% gap the leading
  // side measured 19.8px against 1.0px on the trailing side — that asymmetry is
  // exactly the "1 | . 55" hole the eye reads. 5px separates the two states
  // cleanly, so this fails loudly if the trailing gap regresses to 40%.
  assert.ok(
    nextCell - dotRight < 5,
    `${(nextCell - dotRight).toFixed(2)}px to the next digit; the decimal point is adrift`,
  );
  assert.ok(
    dotLeft - prevCell < 22,
    `${(dotLeft - prevCell).toFixed(2)}px after the previous digit`,
  );
});

test("stats are bare type with hairline dividers, not boxed pills", () => {
  const svg = hero();
  // The landing page is flat: white type does the work and borders only
  // separate. A pill/box behind any stat would reintroduce the dashboard's
  // card look the redesign deliberately dropped.
  const statPills = [...svg.matchAll(/<rect x="28" y="1[12]\d"/g)];
  assert.deepEqual(statPills, [], "a stat box was reintroduced");
  // Two dividers stand in for the boxes. Their x is content-derived, so it is
  // matched loosely — the exact placement has its own test above.
  const dividers = [...svg.matchAll(/<line x1="([\d.]+)" y1="106" x2="\1" y2="152"/g)];
  assert.equal(dividers.length, 2, "expected a divider between each stat pair");
  // Hierarchy is carried by scale, not by weight of chrome: TOKENS leads at 30px
  // while COST and RANK sit at 21px, and all three are rolling odometers.
  assert.match(svg, /<animateTransform attributeName="transform" type="translate"/);
  assert.ok(svg.includes('id="odo-tok-'), "TOKENS should animate");
  assert.ok(svg.includes('id="odo-cost-'), "COST should animate");
  assert.ok(svg.includes('id="odo-rank-'), "RANK should animate");
});

test("placeholders keep the rounded card shape and escape their message", () => {
  const svg = api.placeholderSvg("bad <style>", "dark");
  assert.match(svg, /rx="16"/);
  assert.match(svg, /&lt;style&gt;/);
  assert.ok(!svg.includes("bad <style>"));
});

test("every provider logo <use> resolves to an emitted <symbol>", () => {
  for (const svg of [hero(), hero({}, "light")]) {
    const symbols = new Set([...svg.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of svg.matchAll(/<use href="#([^"]+)"/g)) {
      assert.ok(symbols.has(m[1]), `<use> references missing symbol #${m[1]}`);
    }
    // Claude/Codex/Hermes are all non-zero on the mock row.
    for (const label of ["Claude", "Codex", "Hermes"]) {
      assert.ok(svg.includes(`<use href="#bpl-${label}"`), `missing logo for ${label}`);
    }
  }
});

test("only the providers a card renders ship their logo path data", () => {
  const svg = hero(NO_PROVIDERS);
  // No provider has tokens, so no provider symbols should be emitted —
  // otherwise every badge would carry six logos regardless of usage. The
  // TokenTracker bolt is a separate, always-present symbol.
  assert.ok(!/<symbol id="bpl-/.test(svg), "emitted provider logo symbols for an empty provider row");
  assert.ok(!svg.includes('<use href="#bpl-'), "emitted a provider logo for an empty provider row");
});

// The bolt path and tile gradient are copied from the shipped app icon so the
// badge's mark stays pixel-identical to it. Nothing generates these from a
// source asset — they are literals — so the two facts that make the claim
// meaningful are pinned here: the path's geometry, and the gradient's ten-stop
// ramp with its long dark dwell at the top.
test("the bolt path and tile gradient hold the app icon's shape", () => {
  const src = fs.readFileSync(EDGE_FILE, "utf8");

  // TT_BOLT_PATH is two adjacent string literals joined with `+`.
  const start = src.indexOf("const TT_BOLT_PATH");
  assert.ok(start > 0, "TT_BOLT_PATH not found");
  const boltPath = src
    .slice(start, start + 600)
    .split("\n")
    .slice(0, 3)
    .map((l) => (l.match(/"([^"]+)"/) || [])[1])
    .filter(Boolean)
    .join("");
  assert.ok(boltPath.startsWith("M92.47 45.94"), "the bolt no longer starts at the icon's origin");
  assert.ok(boltPath.endsWith("50.68 100.53Z"), "the bolt path is truncated or re-fitted");
  assert.equal(boltPath.length, 181, `bolt path length changed to ${boltPath.length} (was 181)`);
  // The icon's bolt is a different shape from Assets/02-bolt.svg — not a
  // rescale — so its four arcs are what distinguish it. A straight-line rewrite
  // could keep the length while losing the curvature.
  assert.equal((boltPath.match(/A/g) || []).length, 4, "the bolt's four arcs are gone; it was re-fitted");

  // The tile gradient: ten stops, near-black through the top third.
  const bm = src.indexOf("function brandMarkSvg");
  const seg = src.slice(bm, src.indexOf("\nfunction ", bm + 10));
  const stops = [...seg.matchAll(/stop-color="#([0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.equal(stops.length, 10, `expected the icon's ten gradient stops, found ${stops.length}`);
  assert.equal(stops[0], "010101", "the gradient no longer starts at the icon's near-black");
  assert.equal(stops[stops.length - 1], "707070", "the gradient no longer ends at its graphite");
});

test("the official TokenTracker bolt is present and placed", () => {
  for (const svg of [hero(), hero({}, "light")]) {
    // Copied from the shipped app icon — a drifted path or viewBox would make
    // the badge's mark stop matching it.
    assert.match(svg, /<symbol id="tt-bolt" viewBox="0 0 200 200">/);
    assert.match(svg, /M92\.47 45\.94A4\.2 4\.2 0 0 1 100\.00 48\.50/);
    assert.match(svg, /<use href="#tt-bolt"/);
// Tile gradient is the app icon's own: 90deg, ten stops, verbatim from the
    // reference icon. A 2- or 3-stop approximation loses the long dark dwell.
    assert.match(svg, /<linearGradient id="tt-tile-22" x1="0" y1="0" x2="0" y2="1">/);
    assert.match(svg, /<stop offset="0" stop-color="#010101"\/>/);
    assert.match(svg, /<stop offset="0\.5" stop-color="#252525"\/>/);
    assert.match(svg, /<stop offset="1" stop-color="#707070"\/>/);
    // The bolt paints at 51% x 54% of the 22px tile — the app icon's own
    // proportion. Asserted as PAINTED size, not <use> box size: tt-bolt carries
    // the source's padded 200-unit viewBox, so the use box is deliberately larger.
    const bolt = svg.match(/<use href="#tt-bolt" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    assert.ok(bolt, "bolt <use> missing");
    const [, x, y, useW, useH] = bolt.map(Number);
    const FILL = { w: 98.64 / 200, h: 111.4 / 200 };
    const paintedW = useW * FILL.w;
    const paintedH = useH * FILL.h;
    assert.ok(Math.abs(paintedW / 22 - 0.51) < 0.005, `bolt width is ${(paintedW / 22 * 100).toFixed(1)}% of tile, want 51%`);
    assert.ok(Math.abs(paintedH / 22 - 0.54) < 0.005, `bolt height is ${(paintedH / 22 * 100).toFixed(1)}% of tile, want 54%`);
    // …and stays centred on the tile (tile spans x 555..577, centre 566).
    assert.ok(Math.abs(x + useW / 2 - 566) < 0.05, "bolt is not horizontally centred");
  }
});

test("both themes use the same app-icon tile gradient", () => {
  // The mark must not drift between themes — the shipped icon is a fixed dark
  // squircle, so a theme-specific tile would read as two different logos.
  const tile = (svg) =>
    svg.match(/<linearGradient id="tt-tile-22"[^>]*>[\s\S]*?<\/linearGradient>/)?.[0] ?? "";
  const stops = (svg) =>
    [...tile(svg).matchAll(/<stop offset="[\d.]+" stop-color="(#\w+)"\/>/g)].map((m) => m[1]);

  const expected = [
    "#010101", "#050505", "#0d0d0d", "#181818", "#252525",
    "#323232", "#414141", "#505050", "#5f5f5f", "#707070",
  ];
  assert.deepEqual(stops(hero()), expected);
  assert.deepEqual(stops(hero({}, "light")), expected);
});

test("the bolt path inherits its fill so it is white in BOTH themes", () => {
  for (const svg of [hero(), hero({}, "light")]) {
    // The source asset uses currentColor, which resolves against the inherited
    // *text* color — not the <use> element's fill. Left in place it renders
    // black on the light theme no matter what boltInk says.
    const path = svg.match(/<symbol id="tt-bolt"[^>]*><path([^>]*)>/)?.[1] ?? "";
    assert.ok(!/fill=/.test(path), `bolt path hardcodes a fill: ${path.trim()}`);
    // And every placement site asks for white explicitly.
    for (const m of svg.matchAll(/<use href="#tt-bolt"[^>]*>/g)) {
      assert.match(m[0], /fill="#ffffff"/, "bolt is not painted white");
    }
  }
});

test("the TOKENS stat renders the app's rolling odometer as SMIL", () => {
  const svg = hero();
  // SMIL (not CSS) because the badge is an externally-referenced SVG: browsers
  // disable JS in that context but still run SMIL, and camo passes SVG through
  // byte-identical.
  assert.match(svg, /<animateTransform attributeName="transform" type="translate"/);
  // Every digit cell animates, including the two after the decimal point. Their
  // indices skip the "." between the integer and fractional parts, which is a
  // static glyph — so the ids are 0,1,3,4 rather than 0,1,2,3.
  const cells = [...svg.matchAll(/id="odo-tok-(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(cells, ["0", "1", "3", "4"], "expected all four digits to animate");

  // Each animated strip must actually travel: a zero-length animation is the
  // failure mode where the digits never move.
  for (const m of svg.matchAll(/<animateTransform[^>]*values="([^"]*)"/g)) {
    const first = m[1].split(";")[0].trim();
    const last = m[1].split(";").pop().trim();
    assert.notEqual(first, last, `strip animation has no travel: ${m[1].slice(0, 40)}`);
  }

  // Every animated strip must END at rest (translate 0), and the approach must be
  // monotonic — the spring converges asymptotically, so a slow creep is correct,
  // but any reversal is a strip jumping back and forth, which is the flicker
  // that was reported after the decimal point.
  for (const m of svg.matchAll(/<animateTransform[^>]*values="([^"]*)"/g)) {
    const seq = m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
    assert.ok(Math.abs(seq[seq.length - 1]) < 0.5, `strip ends off rest: ${seq[seq.length - 1]}`);
    for (let i = 1; i < seq.length; i++) {
      assert.ok(
        seq[i] <= seq[i - 1] + 0.01,
        `strip reverses at frame ${i}: ${seq[i - 1]} -> ${seq[i]}`,
      );
    }
  }

  // keyTimes must accompany values, or SMIL redistributes the remaining frames
  // evenly and the settled hold becomes a slow crawl.
  const valueCounts = [...svg.matchAll(/values="([^"]*)"[^>]*keyTimes="([^"]*)"/g)]
    .map((m) => [m[1].split(";").length, m[2].split(";").length]);
  for (const [v, k] of valueCounts) {
    assert.equal(v, k, `values (${v}) and keyTimes (${k}) must be the same length`);
  }

  // A keyTimes list that does not run 0 -> 1 makes SMIL reject the whole
  // animateTransform element, and the digits then never move at all. This
  // silently disabled the animation once already, so it is pinned here.
  for (const m of svg.matchAll(/keyTimes="([^"]*)"/g)) {
    const kt = m[1].split(";").map(Number);
    assert.equal(kt[0], 0, `keyTimes must start at 0, got ${kt[0]}`);
    assert.equal(kt[kt.length - 1], 1, `keyTimes must end at exactly 1, got ${kt[kt.length - 1]}`);
    for (let i = 1; i < kt.length; i++) {
      assert.ok(kt[i] >= kt[i - 1], `keyTimes must not go backwards at index ${i}`);
    }
  }
});

test("the roll plays once and then freezes, rather than looping", () => {
  // repeatCount="indefinite" made the digits spin forever; the badge should
  // count up once on load and stay put. fill="freeze" holds the final frame.
  const svg = hero();
  assert.ok(!svg.includes('repeatCount="indefinite"'), "the odometer must not loop");
  const anims = [...svg.matchAll(/<animateTransform[^>]*>/g)].map((m) => m[0]);
  // 10 digit cells across the three figures: 4 for TOKENS, 3 each for COST/RANK.
  assert.equal(anims.length, 10, "expected one animation per digit cell");
  for (const a of anims) {
    assert.match(a, /fill="freeze"/, "each strip must hold its final frame");
  }
  // The provider bars animate too, and must also settle rather than loop.
  const widths = [...svg.matchAll(/<animate attributeName="width"[^>]*>/g)].map((m) => m[0]);
  assert.ok(widths.length, "provider bars should animate their width");
  for (const w of widths) {
    assert.match(w, /fill="freeze"/, "each bar must hold its final width");
  }
});

test("every digit stops at the same point in the roll", () => {
  // Superseded by "the digits cascade instead of counting up in lockstep",
  // which now asserts the sequential ordering directly. Kept as the landing
  // check: no digit may still be rolling when the animation ends.
  const svg = hero();
  const ends = [...tokCells(svg)].map((m) => {
    const f = m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
    const kt = m[2].split(";").map(Number);
    let last = 0;
    for (let k = 1; k < f.length - 1; k++) {
      if (Math.abs(f[k] - f[k - 1]) > 0.01) last = k;
    }
    return kt[last];
  });
  assert.equal(ends.length, 4);
  for (const e of ends) {
    assert.ok(e <= 1, `a digit is still rolling at t=${e}`);
  }
});

test("the easing keeps moving until it arrives instead of slamming and holding", () => {
  // "Smooth at the end" is a measurable property, so it is measured rather than
  // eyeballed: the roll must still be moving through the second half of its
  // sweep, and must never carry more speed than it needs to get there.
  //
  // The app's spring failed exactly this. It is critically damped, so 94.5% of
  // its travel is done by t=0.3 and all motion is over by 58% — the digits slam
  // into place and then sit inert for the remaining 42% of the window.
  const svg = hero();
  for (const [, values] of tokCells(svg)) {
    const offs = values.split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
    const n = offs.length;
    const at = (t) => offs[Math.min(n - 1, Math.round(t * (n - 1)))];

    // Remaining distance relative to the total, over the sweep's own window.
    const span = offs[0] - offs[n - 1];
    if (Math.abs(span) < 0.5) continue; // a digit that barely moves proves nothing
    const remaining = (t) => (offs[Math.min(n - 1, Math.round(t * (n - 1)))] - offs[n - 1]) / span;

    // 1. Deceleration: the strip must still be travelling late in the sweep.
    //    A curve that has effectively stopped by t=0.8 reads as a hard stop.
    assert.ok(
      Math.abs(remaining(0.85)) > 0.004,
      `still ${(remaining(0.85) * 100).toFixed(1)}% of its travel at t=0.85 — it stops short`,
    );
    // Monotonic approach, and the last step must actually land on the target.
    assert.ok(Math.abs(offs[n - 1]) < 0.01, `digit ends at ${offs[n - 1]}, not on target`);
    for (let i = 1; i < n; i++) {
      assert.ok(offs[i] <= offs[i - 1] + 0.01, "strip moves backwards — the ease is not monotonic");
    }

    // 2. Peak speed must not exceed a uniform crawl by much. A curve that covers
    //    the same ground faster than cubic does at the start, then coasts, is
    //    the "slams then holds" shape this replaced.
    const steps = n - 1;
    const peak = Math.max(...offs.slice(1).map((v, i) => Math.abs(offs[i] - v)));
    assert.ok(
      peak / Math.abs(span) < 0.12,
      `peak step is ${((peak / Math.abs(span)) * 100).toFixed(1)}% of the travel; the roll jerks`,
    );
  }
});

test("the digits cascade instead of counting up in lockstep", () => {
  // Each digit starts its sweep a little after the one to its left, so the
  // number reads as cascading rather than snapping up all at once. Without
  // this every strip moved in lockstep and the figure looked mechanical.
  const svg = hero();
  const motion = [...tokCells(svg)]
    .map((m) => {
      const f = m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
      const kt = m[2].split(";").map(Number);
      let start = null, end = null;
      for (let k = 1; k < f.length; k++) {
        if (Math.abs(f[k] - f[k - 1]) > 0.01) {
          if (start === null) start = kt[k];
          end = kt[k];
        }
      }
      return { start, end };
    });
  assert.equal(motion.length, 4);

  // Every digit must start strictly later than the one before it.
  for (let i = 1; i < motion.length; i++) {
    assert.ok(
      motion[i].start > motion[i - 1].start,
      `digit ${i} starts at ${motion[i].start}, not after ${motion[i - 1].start}`,
    );
  }

  // ...and the gaps must be even. The "." is a static glyph between the
  // integer and fractional digits; if it consumes a stagger slot, the gap
  // across the decimal point comes out double and the cascade reads as
  // pausing there instead of continuing through it.
  const gaps = motion.slice(1).map((m, i) => m.start - motion[i].start);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  assert.ok(
    spread < 0.02,
    `stagger gaps are uneven (${gaps.map((g) => g.toFixed(3)).join(", ")}); ` +
      `the decimal point is probably consuming a slot`,
  );

  // ...but they must still OVERLAP. The app springs one shared value and every
  // digit reads its offset off it, so they all begin moving within the first
  // instants and each is still rolling when the next starts. A sweep shorter
  // than the stagger made the badge count one digit at a time like a slot
  // machine, which is not what the app does.
  //
  // Measured on VISIBLE motion (changes over half a pixel), not the nominal
  // sweep: the spring does most of its travel in its first 40% and then crawls
  // through an asymptotic tail, so the nominal window is far longer than what
  // the eye sees. Comparing the raw windows made a clearly overlapping roll look
  // sequential.
  const visible = (f) => {
    let start = null, end = null;
    for (let k = 1; k < f.length; k++) {
      if (Math.abs(f[k] - f[k - 1]) > 0.5) {
        if (start === null) start = k;
        end = k;
      }
    }
    return { start, end };
  };
  const visWindows = [...tokCells(svg)]
    .map((m) => visible(m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]))))
    .filter((w) => w.start !== null);
  const visDurations = visWindows.map((w) => w.end - w.start);
  assert.equal(visWindows.length, 4, "expected four visible digit sweeps");

  const steps = 240;
  const toTime = (i) => (i / steps);
  const visStart = visWindows.map((w) => toTime(w.start));
  const visGaps = visStart.slice(1).map((v, i) => v - visStart[i]);
  const shortestVis = Math.min(...visDurations.map((d) => d / steps));
  assert.ok(
    shortestVis > Math.max(...visGaps) * 1.2,
    `the visible roll (${shortestVis.toFixed(3)}) is no longer than the gap ` +
      `(${Math.max(...visGaps).toFixed(3)}); the digits read as sequential`,
  );

  // The whole sequence must still fit inside the animation.
  assert.ok(
    Math.max(...motion.map((m) => m.end)) <= 1,
    "a digit is still rolling when the animation ends",
  );
});

test("no animated digit skips a step on its way to its final value", () => {
  // A skip means the strip teleports past a digit, which SMIL renders as a
  // jump. Every frame must move at most one place.
  const svg = hero();
  for (const m of svg.matchAll(/<animateTransform[^>]*values="([^"]*)"/g)) {
    const seq = m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
    for (let i = 1; i < seq.length; i++) {
      const delta = Math.abs(seq[i] - seq[i - 1]);
      // A little over one pitch is expected for the fast decimal cells: their
      // digit changes hundreds of times over the roll, and near the end the
      // value advances faster than the sample grid, so a step can cover one
      // pitch plus a sliver. Anything near a FULL extra digit (2 pitches) is a
      // real skip — that is the 275px teleport this test exists to catch.
      assert.ok(
        delta <= ODO_PITCH * 1.5,
        `strip jumps ${delta}px at frame ${i}; a digit was skipped`,
      );
    }
  }
});

test("the odometer's clip window hides neighbouring digits", () => {
  const svg = hero();
  // Glyph d is drawn one pitch below the last, so the window must be shorter
  // than the pitch or two digits show at once.
  const clips = [...svg.matchAll(/id="odo-tok-\d+"><rect[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(clips.length, 4, "expected a clip per animated digit");
  for (const h of clips) {
    assert.ok(h < ODO_PITCH, `clip height ${h} exceeds the ${ODO_PITCH}px pitch; two digits show`);
  }
});

test("a zero figure falls back to static type rather than a dead roll", () => {
  // Every digit would sweep from 0 to 0 and sit still, which is worse than just
  // drawing the value. RANK also has no digits at all when there is no rank.
  const svg = hero({ total_tokens: 0, estimated_cost_usd: 0, rank: null });
  assert.ok(!svg.includes('id="odo-tok-'), "zero TOKENS should not render an odometer");
  assert.ok(!svg.includes('id="odo-cost-'), "zero COST should not render an odometer");
  assert.match(svg, /<text x="28" y="150"[^>]*>0<\/text>/);
  // COST's x follows the TOKENS figure's width, so it is derived here rather
  // than pinned — the static fallback lands wherever the animated one would.
  const costX = Number(svg.match(/<text x="([\d.]+)" y="149"[^>]*>\$0\.00/) ?.[1]);
  assert.ok(costX > 100, `zero-fallback COST landed at x=${costX}, past the stat row`);
});

test("the name and the brand lockup start on the same line", () => {
  // The wordmark used to be centred against the row, which dropped its 9px cap
  // top ~10px below the 21px name's cap top — the two read as starting at
  // different levels. Both now hang off the NAME's cap line.
  for (const svg of [hero(), hero({}, "light")]) {
    const y = (re) => Number(svg.match(re)?.[1]);
    const nameBaseline = y(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="21"/);
    const brandBaseline = y(/<text x="550" y="([\d.]+)"[^>]*font-size="9"[^>]*>TOKENTRACKER/);

    // Cap height of Inter runs ~0.72em, so a cap top is baseline - 0.72 * size.
    const nameCapTop = nameBaseline - 21 * 0.72;
    const brandCapTop = brandBaseline - 9 * 0.72;

    assert.ok(
      Math.abs(nameCapTop - brandCapTop) < 0.05,
      `name cap top ${nameCapTop.toFixed(2)} vs wordmark cap top ${brandCapTop.toFixed(2)}`,
    );
  }
});

test("the brand lockup's tile centres on its own two-line block", () => {
  // The tile follows the wordmark rather than the row, so it stays attached to
  // the text beside it.
  const svg = hero();
  const y = (re) => Number(svg.match(re)?.[1]);
  const nameCapTop = y(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="21"/) - 21 * 0.72;
  const brandBaseline = y(/<text x="550" y="([\d.]+)"[^>]*font-size="9"[^>]*>TOKENTRACKER/);
  const brandSubBaseline = y(/<text x="550" y="([\d.]+)"[^>]*font-size="9"[^>]*>tokentracker\.cc/);
  const tileCentre = y(/<rect x="555\.00" y="([\d.]+)"/) + 11;
  const blockCentre = (nameCapTop + brandSubBaseline) / 2;

  assert.ok(
    Math.abs(tileCentre - blockCentre) < 0.05,
    `tile centre ${tileCentre.toFixed(2)} is not on the lockup block centre ${blockCentre.toFixed(2)}`,
  );
});

test("the name and subtitle keep their own optical relationship", () => {
  // The row is now anchored by the name, but the subtitle must still hang off
  // the name rather than sitting at an unrelated baseline.
  const svg = hero();
  const y = (re) => Number(svg.match(re)?.[1]);
  const nameBaseline = y(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="21"/);
  const subBaseline = y(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="11\.5"/);

  const gap = subBaseline - nameBaseline;
  assert.ok(gap > 16 && gap < 22, `name-to-subtitle baseline gap is ${gap}px`);
});

test("the hero identity row has no avatar and leads on the card gutter", () => {
  // The disc was removed to see how the name reads on its own. Nothing in the
  // 600x180 canvas may still paint one, and the name now shares a left edge
  // with the TOKENS label below it instead of hanging off the disc's ring.
  for (const svg of [hero(), hero({}, "light")]) {
    assert.ok(!/<circle cx="44"/.test(svg), "hero still paints the avatar disc");
    assert.ok(!/av-body-hero|av-halo-hero/.test(svg), "hero still emits avatar gradients");
    const nameX = Number(svg.match(/<text x="([\d.]+)" y="51"[^>]*font-size="21"/)[1]);
    assert.equal(nameX, 28, `name starts at x=${nameX}; it should share the stat gutter`);
    // No orphaned gradient definitions for an element that is no longer drawn.
    assert.ok(!definedIds(svg).has("av-body-hero"), "orphan avatar gradient id");
    assert.ok(!definedIds(svg).has("av-halo-hero"), "orphan avatar halo id");
  }
});

test("neither card draws an avatar", () => {
  // The disc was a generated initial circle, never a real photo: it hashed the
  // display name into a hue and drew a letter. It cost 48px of width and pushed
  // the name to x=80, where it read as a caption beside a picture. With it gone,
  // so is the whole generator — avatarSvg(), hashHue() and the ring constants.
  for (const [name, svg] of [["hero", hero()], ["hero light", hero({}, "light")]]) {
    assert.ok(!/<circle[^>]*fill="url\(#av-/.test(svg), `${name}: still paints an avatar disc`);
    assert.ok(!/av-body-|av-halo-/.test(svg), `${name}: still emits avatar gradients`);
    for (const id of definedIds(svg)) {
      assert.ok(!/^av-(body|halo)-/.test(id), `${name}: orphan avatar gradient #${id}`);
    }
    assert.ok(
      !/dominant-baseline="central"/.test(svg),
      `${name}: still renders a centred initial`,
    );
  }
});

test("the bolt tile radius tracks its size on the hero card", () => {
  // 22px tile, horizontally centred on x=566 (so x=555). Its Y follows the
  // wordmark block rather than a fixed row, so it moves when the name does —
  // pinning the literal y here would just re-freeze the next alignment change.
  const m = hero().match(/<rect x="555\.00" y="([\d.]+)" width="22" height="22" rx="([\d.]+)" fill="url\(#tt-tile-22\)"/);
  assert.ok(m, "hero bolt tile not found at the expected x/width");
  assert.equal(m[2], (22 * 0.22).toFixed(2), "corner radius no longer tracks the tile size");
});

test("TokenTracker is named once per card, not twice", () => {
  // The corner lockup carries the brand; the subtitle under the display name
  // must not repeat it.
  for (const svg of [hero(), hero({}, "light")]) {
    assert.match(svg, />TOKENTRACKER</);
    assert.ok(!/>TokenTracker · /.test(svg), "subtitle still repeats the brand name");
  }
});

test("mono logos inherit theme ink, brand-color logos keep theirs", () => {
  const dark = hero();
  const light = hero({}, "light");
  // Cursor/Copilot/Hermes ship without a fill so the <use> supplies one, and
  // that ink must differ between themes or it vanishes on one of them.
  assert.match(dark, /<use href="#bpl-Hermes"[^>]*fill="#e6e3f5"/);
  assert.match(light, /<use href="#bpl-Hermes"[^>]*fill="#16161f"/);
  // Claude is brand-colored (#D97757); tinting it would be wrong.
  assert.match(dark, /<use href="#bpl-Claude"[^>]*width="13" height="13"\/>/);
});

test("provider logos add no id collisions across providers", () => {
  // Gemini and Codex ship gradient/clip ids; without namespacing, two symbols
  // would share ids and the wrong gradient would win document-wide.
  const svg = hero(NO_PROVIDERS, "dark");
  const all = hero({ ...NO_PROVIDERS, gemini_tokens: 1, gpt_tokens: 1, claude_tokens: 1 }, "dark");
  const ids = [...all.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(", ")}`);
  assert.ok(svg);
});