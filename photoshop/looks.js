// Shared by the Photoshop panel (require("./looks.js")) and the Illustrator settings window (inlined at build time):
// the default settings, the built-in looks and the line icons, so both apps always offer the same things.
(function (root) {
  // Order = glass_core::Params (42 values). Lengths are px in Photoshop and pt in Illustrator.
  const DEFAULTS = [-45, 0.6, 80, 16, 20, 12, 30, 0.06, 1.2, 1, 1, 1, 0, 0.25, 24, 8, 0, 1.5, 0, 40, 24, 0.32, 1.2, 1.5, 1, 0, 12, 1, 1, 1,
    0, 0, 1, 0.2, 0, -45, 1, 1, 1, 1, 1, 1];
  // Looks restyle the glass but keep its size-dependent settings: edge width (3) and merge (20).
  const KEEP = [3, 20];
  // The looks designers reach for most. Each lists only what differs from the default Liquid Glass.
  const LOOKS = [
    ["Liquid Glass", {}],
    ["Clear", { 1: 0.7, 2: 90, 4: 25, 5: 0, 7: -0.08, 8: 1.05, 13: 0.15 }],
    ["Frosted", { 1: 0.5, 2: 30, 4: 5, 5: 24, 7: 0.18, 8: 1.05, 25: 0.25, 26: 10 }],
    ["Glassmorphism", { 1: 0.4, 2: 10, 4: 0, 5: 20, 6: 60, 7: 0.25, 8: 1.3, 13: 0.18, 14: 30, 15: 12, 21: 0.1, 22: 1,
      31: 1, 32: 0.7, 33: 0.1, 34: 1, 35: -45 }],
    ["Ice", { 4: 30, 5: 16, 7: 0.12, 9: 0.75, 10: 0.9, 11: 1, 12: 0.35, 16: 0.12, 17: 1, 25: 0.4, 26: 14, 27: 0.8, 28: 0.95, 29: 1, 30: 1 }],
    ["Smoked", { 1: 0.7, 5: 18, 7: -0.45, 8: 0.9, 9: 0.1, 10: 0.1, 11: 0.12, 12: 0.3, 13: 0.35 }],
    ["Crystal", { 1: 0.8, 2: 140, 4: 60, 5: 0, 6: 15, 21: 0.45, 22: 0.8, 23: 1.9, 24: 1.4 }],
    ["Bubble", { 1: 0.7, 2: 110, 4: 80, 5: 0, 6: 100, 7: 0.02, 21: 0.15, 24: 1.8, 25: 0.25, 26: 20, 27: 0.85, 28: 0.9, 29: 1, 30: 1 }],
    ["Film frost", { 2: 40, 5: 20, 7: 0.1, 16: 0.3, 17: 1.2 }],
  ].map(([name, o]) => ({ name, values: DEFAULTS.map((v, i) => (i in o ? o[i] : v)) }));

  // Older saves have fewer values (16, 21, 25, 30): the new ones get defaults. Anything else is rejected (null).
  const pad = (a) => (Array.isArray(a) && a.length >= 16 && a.length <= DEFAULTS.length && a.every(Number.isFinite)
    ? a.concat(DEFAULTS.slice(a.length)) : null);

  // Applies a look to `params`, keeping the size-dependent values.
  const applyLook = (params, look) => look.values.map((v, i) => (KEEP.includes(i) ? params[i] : v));

  // The look `params` currently matches (ignoring the kept values), or "".
  const lookOf = (params, looks) => (looks.find((l) => l.values.every((v, i) => KEEP.includes(i) || Math.abs(v - params[i]) < 1e-4)) || {}).name || "";

  // 16 × 16 line icons, stroked: each one draws what its setting does.
  const ICONS = {
    presets: '<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>',
    frost: '<path d="M8 1.8v12.4M2.6 4.9l10.8 6.2M2.6 11.1l10.8-6.2M6.4 2.6 8 4.2l1.6-1.6M6.4 13.4 8 11.8l1.6 1.6"/>',
    lens: '<circle cx="6.8" cy="6.8" r="4.6"/><path d="M10.2 10.2 14 14M4.6 6.2a2.4 2.4 0 0 1 1.8-1.8"/>',
    edge: '<path d="M2.5 14V8a6 6 0 0 1 6-6H14M5.5 14V8.5a3 3 0 0 1 3-3H14"/>',
    soft: '<path d="M2 13c5.5 0 4.5-10 12-10"/><path d="M2 13h12" stroke-dasharray="1.5 2"/>',
    prism: '<path d="M6 2.5 11 12H1Z"/><path d="M8.6 7.6 15 5.5M9.2 8.6 15 8.4M9.8 9.8 15 11.4"/>',
    merge: '<circle cx="5" cy="8" r="3.4"/><circle cx="11.4" cy="8" r="2.8"/><path d="M8.2 6.6c.6.3 1.1.3 1.6 0M8.2 9.4c.6-.3 1.1-.3 1.6 0"/>',
    advanced: '<path d="M2 4h7M12 4h2M2 8h2M7 8h7M2 12h9"/><circle cx="10.5" cy="4" r="1.5"/><circle cx="5.5" cy="8" r="1.5"/><circle cx="12.5" cy="12" r="1.5"/>',
    emboss: '<circle cx="8" cy="8" r="5.8"/><path d="M4 9.5A4.3 4.3 0 0 1 9.5 4"/>',
    rim: '<rect x="2" y="3.5" width="12" height="9" rx="3"/><rect x="4" y="5.5" width="8" height="5" rx="1.6" stroke-dasharray="1.2 1.6"/>',
    diamond: '<path d="M4.5 2.5h7l3 3.6L8 14 1.5 6.1Z"/><path d="M1.5 6.1h13M6 2.5 5 6.1 8 14l3-7.9-1-3.6"/>',
    sheen: '<path d="M3 12.5A7 7 0 0 1 12.5 3"/><path d="M5.5 13A5 5 0 0 1 13 5.5" opacity=".5"/>',
    sun: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
    direction: '<circle cx="8" cy="8" r="6"/><path d="M8 8 11.5 4.5M9 4.4l2.6.1-.1 2.6"/>',
    sparkle: '<path d="M8 1.8c.5 3.2 2.6 5.3 5.8 5.8-3.2.5-5.3 2.6-5.8 5.8-.5-3.2-2.6-5.3-5.8-5.8 3.2-.5 5.3-2.6 5.8-5.8Z"/>',
    bright: '<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2M8 4.5h2.6M8 7h3.4M8 9.5h3.2M8 12h2"/>',
    drop: '<path d="M8 2s4.6 5 4.6 8.1A4.6 4.6 0 0 1 3.4 10.1C3.4 7 8 2 8 2Z"/><path d="M5.8 10.4a2.2 2.2 0 0 0 1.6 1.9"/>',
    palette: '<path d="M8 2a6 6 0 1 0 0 12c1 0 1.3-.9.8-1.6-.5-.7 0-1.7.9-1.7H11a3 3 0 0 0 3-3C14 4.6 11.3 2 8 2Z"/><circle cx="5" cy="7.5" r=".6"/><circle cx="7.4" cy="4.8" r=".6"/><circle cx="10.6" cy="5.4" r=".6"/>',
    amount: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M2.5 13.5 13.5 2.5M2 9l7-7M7 14l7-7"/>',
    shadow: '<rect x="2" y="2" width="8.5" height="8.5" rx="2"/><path d="M12.5 5.5V12a1.5 1.5 0 0 1-1.5 1.5H5.5" opacity=".6"/>',
    blur: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="4.2" stroke-dasharray="1.4 1.6"/><circle cx="8" cy="8" r="6.3" stroke-dasharray="0.8 2.2" opacity=".6"/>',
    down: '<rect x="3" y="2" width="10" height="5" rx="1.5"/><path d="M8 9v5M5.8 11.8 8 14l2.2-2.2"/>',
    moon: '<path d="M13 10.2A5.6 5.6 0 0 1 5.8 3 5.6 5.6 0 1 0 13 10.2Z"/>',
    spread: '<rect x="5.5" y="5.5" width="5" height="5" rx="1"/><path d="M1.8 8h2M12.2 8h2M8 1.8v2M8 12.2v2"/>',
    glow: '<rect x="2" y="2" width="12" height="12" rx="3.5"/><rect x="4.5" y="4.5" width="7" height="7" rx="1.8" stroke-dasharray="1.2 1.4" opacity=".7"/>',
    inward: '<rect x="2" y="2" width="12" height="12" rx="3.5"/><path d="M5 8h2.4M11 8H8.6M5.9 6.7 7.2 8 5.9 9.3M10.1 6.7 8.8 8l1.3 1.3"/>',
    blend: '<circle cx="6" cy="8" r="4.2"/><circle cx="10" cy="8" r="4.2"/>',
    grain: '<circle cx="4" cy="4" r=".7"/><circle cx="9" cy="3.5" r=".9"/><circle cx="12.5" cy="6" r=".6"/><circle cx="5.5" cy="8.5" r=".9"/><circle cx="10" cy="9" r=".7"/><circle cx="3.5" cy="12.5" r=".6"/><circle cx="8" cy="12.8" r=".8"/><circle cx="12.6" cy="12" r=".9"/>',
    film: '<rect x="3" y="1.8" width="10" height="12.4" rx="1.2"/><path d="M5.5 1.8v12.4M10.5 1.8v12.4M3 4.5h2.5M3 8h2.5M3 11.5h2.5M10.5 4.5H13M10.5 8H13M10.5 11.5H13"/>',
    size: '<circle cx="5" cy="11" r="1.4"/><circle cx="10.5" cy="5.5" r="3"/>',
    stroke: '<rect x="2.5" y="3" width="11" height="10" rx="3"/><rect x="4.4" y="4.9" width="7.2" height="6.2" rx="1.6" opacity=".5"/>',
    width: '<path d="M2 3.5h12" stroke-width="0.9"/><path d="M2 7.5h12" stroke-width="1.8"/><path d="M2 12h12" stroke-width="3"/>',
    fill: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M5 14 14 5M8.5 14 14 8.5M11.8 14 14 11.8" opacity=".7"/>',
    opacity: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M2 8h12M8 2v12M2.4 5h2.6M5 2.4V5M11 8v3h3M8 11h3" opacity=".6"/>',
    gradient: '<rect x="2" y="4" width="12" height="8" rx="2"/><path d="M5 4v8M8 4v8M11 4v8" opacity=".55" stroke-dasharray="1 1.2"/>',
    angle: '<path d="M2 13.5h12M2 13.5 11 4.5"/><path d="M6.5 13.5a4.5 4.5 0 0 0-1.3-3.2"/>',
    pen: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3Z"/><path d="M9 4l3 3"/>',
    glass: '<rect x="2" y="3" width="12" height="10" rx="3.5"/><path d="M4.5 6.5a2 2 0 0 1 2-2"/>',
    finish: '<path d="M3 13 9.5 6.5M11 2.5v2M11 8.5v2M8 5.5h-2M15 5.5h-2M3 13l-1 1"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    left: '<path d="M10 3 5 8l5 5"/>',
    right: '<path d="M6 3l5 5-5 5"/>',
  };
  // Stroke attributes sit on the <svg> itself, so they work without CSS (Photoshop panels) too.
  const icon = (name, color) => `<svg class="i" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="${color || "currentColor"}" ` +
    `stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;

  const api = { DEFAULTS, KEEP, LOOKS, ICONS, icon, pad, applyLook, lookOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SudoLooks = api;
})(typeof window !== "undefined" ? window : this);
