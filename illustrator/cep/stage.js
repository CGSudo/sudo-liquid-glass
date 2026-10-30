// Stages the panel for packaging: node illustrator/cep/stage.js <outDir>. Copies the panel, the shared looks
// (photoshop/looks.js) and the logo, and makes the panel icons. Signing is done per platform (ZXPSignCmd).
const fs = require("fs");
const path = require("path");
const here = __dirname, root = path.join(here, "..", "..");
const out = path.resolve(process.argv[2] || path.join(root, "dist", "cep"));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "CSXS"), { recursive: true });
for (const f of ["index.html", "host.jsx", "CSXS/manifest.xml", "icon-light.png", "icon-dark.png"]) fs.copyFileSync(path.join(here, f), path.join(out, f));
fs.copyFileSync(path.join(root, "photoshop", "looks.js"), path.join(out, "looks.js"));
fs.copyFileSync(path.join(root, "photoshop", "logo.png"), path.join(out, "logo.png"));
// The bundle version must match the plug-in's, so a stale panel is never paired with a newer plug-in.
const manifest = fs.readFileSync(path.join(out, "CSXS", "manifest.xml"), "utf8");
const plugin = fs.readFileSync(path.join(root, "illustrator", "Source", "LiquidGlass.h"), "utf8");
const v = /kVersion = "([^"]+)"/.exec(plugin)[1];
if (!manifest.includes(`ExtensionBundleVersion="${v}"`)) throw new Error(`manifest.xml version differs from plug-in ${v}`);
// The version badge shows the plug-in version.
const html = path.join(out, "index.html");
fs.writeFileSync(html, fs.readFileSync(html, "utf8").replace(/id="ver">v[^<]*</, `id="ver">v${v}<`));
console.log("staged " + out);
