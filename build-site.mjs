// =====================================================================
//  Build the published site into docs/ — a single-page app.
//
//    node build-site.mjs
//
//  `malloyyo dashboard bundle` alone emits one self-contained page per
//  dashboard, each booting its own DuckDB. This script keeps everything
//  malloyyo knows how to do and changes only how the pages are put
//  together:
//
//    1. sync-components.mjs     regenerate the games report components
//    2. malloyyo dashboard bundle (into .build/) — discovers the
//       dashboards, introspects their givens, inlines the model files.
//       Its HTML is read for that metadata and then discarded.
//    3. esbuild, with malloyyo's own runtime sources and dependencies:
//         assets/shell.js          spa/shell.ts — DuckDB + Malloy, routing
//         assets/frames/<name>.js  each dashboard component + spa/frame-boot.ts
//    4. pages:
//         index.html, <name>.html  the shell (identical; the file name routes)
//         frames/<name>.html       one dashboard, loaded by the shell in an iframe
//
//  DuckDB-WASM comes from the jsDelivr CDN; nothing binary is copied.
//
//  The runtime and its dependencies are taken from the installed malloyyo
//  CLI (npm i -g @malloydata/malloyyo), so the site is always built against
//  the same runtime `malloyyo dashboard dev` previews with.
// =====================================================================

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "docs");
const stageDir = path.join(here, ".build");
const TITLE = "College Football Games";

// ---- the installed malloyyo CLI ----------------------------------------
const bin = execFileSync("which", ["malloyyo"]).toString().trim();
const pkgRoot = path.resolve(path.dirname(fs.realpathSync(bin)), "..");
const dist = path.join(pkgRoot, "dist");
const nodeModules = path.join(pkgRoot, "node_modules");
const requireFromMalloyyo = createRequire(path.join(pkgRoot, "package.json"));
const esbuild = requireFromMalloyyo("esbuild");
const runtimeIndex = path.join(dist, "frame-runtime", "index.ts");
if (!fs.existsSync(runtimeIndex)) throw new Error(`malloyyo runtime not found at ${runtimeIndex}`);

const run = (cmd, args) => execFileSync(cmd, args, { cwd: here, stdio: "inherit" });

// ---- 1 + 2: components, then malloyyo's own bundle for the metadata ------
run("node", ["sync-components.mjs"]);
fs.rmSync(stageDir, { recursive: true, force: true });
run("malloyyo", ["dashboard", "bundle", "--out", ".build", "--title", TITLE, "--no-serve"]);

const readJsonGlobal = (html, name) => {
  const m = html.match(new RegExp(`window\\.${name} = (.*);\\n`));
  if (!m) throw new Error(`${name} not found in bundled page`);
  return JSON.parse(m[1]);
};

// nav order, as malloyyo wrote it
const indexHtml = fs.readFileSync(path.join(stageDir, "index.html"), "utf8");
const order = [...indexHtml.matchAll(/href="\.\/([^"]+)\.html"/g)].map((m) => decodeURIComponent(m[1]));
const dashboards = [...new Set(order)].map((name) => {
  const html = fs.readFileSync(path.join(stageDir, `${name}.html`), "utf8");
  const info = readJsonGlobal(html, "__DASHBOARD__");
  const givens = readJsonGlobal(html, "__GIVENS__");
  const tsx = ["tsx", "jsx"].map((ext) => path.join(here, "dashboards", `${name}.${ext}`)).find((p) => fs.existsSync(p));
  return { name, info, givens, tsx };
});
if (!dashboards.length) throw new Error("no dashboards found in the malloyyo bundle");

// ---- 3: esbuild --------------------------------------------------------
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "assets", "frames"), { recursive: true });
fs.mkdirSync(path.join(out, "frames"), { recursive: true });

const HOST_LIBS = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"];
const resolvePlugin = {
  name: "malloyyo-runtime",
  setup(b) {
    // what a dashboard component imports
    b.onResolve({ filter: /^@malloyyo\/dashboard$/ }, () => ({ path: runtimeIndex }));
    // malloyyo's shared helpers, as source: malloyyo:shared/givens-url
    b.onResolve({ filter: /^malloyyo:/ }, (args) => ({ path: path.join(dist, `${args.path.slice("malloyyo:".length)}.ts`) }));
    // one React for the component and the runtime alike
    b.onResolve({ filter: /^react(-dom)?($|\/)/ }, (args) =>
      HOST_LIBS.includes(args.path) ? { path: requireFromMalloyyo.resolve(args.path) } : undefined
    );
  },
};

// the same base malloyyo's own bundler uses
const base = {
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  minify: true,
  logLevel: "warning",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    assert: path.join(dist, "shims", "assert.cjs"),
    util: path.join(dist, "shims", "util.cjs"),
  },
  banner: { js: "globalThis.process||={env:{},platform:'browser',versions:{},argv:[],cwd:()=>'/'};" },
  nodePaths: [nodeModules],
};

const frameBoot = path.join(here, "spa", "frame-boot.ts");
await esbuild.build({
  ...base,
  entryPoints: Object.fromEntries(dashboards.map((d) => [d.name, `vframe:${d.name}`])),
  splitting: true,
  outdir: path.join(out, "assets", "frames"),
  plugins: [
    {
      name: "virtual-frame-entry",
      setup(b) {
        b.onResolve({ filter: /^vframe:/ }, (args) => ({ path: args.path, namespace: "vframe" }));
        b.onLoad({ filter: /.*/, namespace: "vframe" }, (args) => {
          const d = dashboards.find((x) => `vframe:${x.name}` === args.path);
          const imp = d.tsx ? `import Dashboard from ${JSON.stringify(d.tsx)};` : `const Dashboard = null;`;
          return {
            contents: `${imp}\nimport { bootFrame } from ${JSON.stringify(frameBoot)};\nbootFrame(Dashboard);\n`,
            loader: "js",
            resolveDir: here,
          };
        });
      },
    },
    resolvePlugin,
  ],
});

await esbuild.build({
  ...base,
  entryPoints: [path.join(here, "spa", "shell.ts")],
  outfile: path.join(out, "assets", "shell.js"),
  plugins: [resolvePlugin],
});

fs.copyFileSync(path.join(stageDir, "assets", "model-files.js"), path.join(out, "assets", "model-files.js"));
fs.copyFileSync(path.join(stageDir, "assets", "site.css"), path.join(out, "assets", "site.css"));

// ---- 4: pages ------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
const ICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏈</text></svg>">`;
const HOME_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.2 12 3.5l9 6.7"/><path d="M5.2 8.9V20h13.6V8.9"/><path d="M9.6 20v-6.2h4.8V20"/></svg>`;

const SHELL_CSS = `
html,body{height:100%}
body.shell{display:flex;flex-direction:column;overflow:hidden}
.dash-nav{flex:none}
.dash-nav .status{margin-left:auto;display:flex;align-items:center;gap:7px;color:#9aa1ac;font-size:12px;padding:0 4px}
.dash-nav .status i{width:7px;height:7px;border-radius:50%;background:#eda100;flex:none}
.dash-nav .status.ready i{background:#1baf7a}
.dash-nav .status.failed i{background:#e34948}
.stage{position:relative;flex:1;min-height:0}
.stage>iframe{position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden;background:var(--bg)}
.stage>iframe.on{visibility:visible}
.home{position:absolute;inset:0;overflow:auto}
.home[hidden]{display:none}
`;

const site = {
  title: TITLE,
  dashboards: dashboards.map((d) => ({
    name: d.name,
    title: d.info.title || d.name,
    description: d.info.description || "",
    entryFile: d.info.entryFile,
  })),
};

const shellHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<meta name="description" content="College football games, drive charts and team rankings for the 2025 and 2026 seasons, from a Malloy model running in your browser on DuckDB-WASM.">
${ICON}
<link rel="stylesheet" href="./assets/site.css">
<style>${SHELL_CSS}</style>
</head>
<body class="shell">
<nav class="dash-nav"><a class="brand" href="./" data-route="" title="Home" aria-label="Home">${HOME_ICON}</a><span class="sep"></span>${site.dashboards
  .map((d) => `<a href="./${encodeURIComponent(d.name)}.html" data-route="${esc(d.name)}">${esc(d.title)}</a>`)
  .join("")}<span id="status" class="status" role="status"><i></i><span></span></span></nav>
<div id="stage" class="stage">
<div id="home" class="home"><main class="index"><h1>${esc(TITLE)}</h1><ul>${site.dashboards
  .map(
    (d) =>
      `<li><a href="./${encodeURIComponent(d.name)}.html" data-route="${esc(d.name)}"><strong>${esc(d.title)}</strong>${
        d.description ? `<span>${esc(d.description)}</span>` : ""
      }</a></li>`
  )
  .join("")}</ul></main></div>
</div>
<script>window.__SITE__ = ${safeJson(site)};</script>
<script src="./assets/model-files.js"></script>
<script type="module" src="./assets/shell.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(out, "index.html"), shellHtml);
for (const d of dashboards) {
  fs.writeFileSync(path.join(out, `${d.name}.html`), shellHtml);
  fs.writeFileSync(
    path.join(out, "frames", `${d.name}.html`),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.info.title || d.name)}</title>
<link rel="stylesheet" href="../assets/site.css">
</head>
<body>
<div id="root"></div>
<script>
window.__DASHBOARD__ = ${safeJson(d.info)};
window.__GIVENS__ = ${safeJson(d.givens)};
</script>
<script type="module" src="../assets/frames/${encodeURIComponent(d.name)}.js"></script>
</body>
</html>
`
  );
}
// GitHub Pages would otherwise run the output through Jekyll
fs.writeFileSync(path.join(out, ".nojekyll"), "");
fs.rmSync(stageDir, { recursive: true, force: true });

const size = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`\n  SPA: ${dashboards.map((d) => d.name).join(", ")}`);
console.log(`  docs/ ${(size(out) / 1048576).toFixed(1)} MB — DuckDB-WASM from the jsDelivr CDN\n`);
