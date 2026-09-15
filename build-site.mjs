// =====================================================================
//  Build the published site into docs/ — a single-page app with the
//  Malloy model compiled ahead of time.
//
//    node build-site.mjs
//
//  `malloyyo dashboard bundle` alone emits one self-contained page per
//  dashboard, each booting its own DuckDB and compiling the model from
//  source in the browser. This script keeps what malloyyo knows how to do
//  and changes how the site is assembled:
//
//    1. sync-components.mjs     regenerate the games report components
//    2. malloyyo dashboard bundle (into .build/) — discovers the
//       dashboards and introspects their givens. Its HTML is read for that
//       metadata and then discarded.
//    3. COMPILE THE MODEL HERE, in Node, against native DuckDB (which reads
//       the parquet schemas): one entry that imports every dashboard, saved
//       as assets/model.json. In the browser the compiler is 20-30x slower,
//       and compiling the model there was most of the page's load time.
//       Before anything is written, every query the site runs is compiled
//       both ways — from source and from model.json — and the SQL must match.
//    4. esbuild, with malloyyo's own runtime sources and dependencies:
//         assets/shell.js          spa/shell.ts — DuckDB + Malloy, routing
//         assets/frames/<name>.js  each dashboard component + spa/frame-boot.ts
//       The frames never render with Malloy's renderer or Vega (every
//       dashboard here draws itself), so both are stubbed out of them.
//    5. pages:
//         index.html, <name>.html  the shell (identical; the file name routes)
//         frames/<name>.html       one dashboard, loaded by the shell in an iframe
//
//  Rebuild whenever a .malloy file or a parquet SCHEMA changes. New rows in
//  the parquet need no rebuild: the page reads the data from Hugging Face.
//
//  DuckDB-WASM comes from the jsDelivr CDN; nothing binary is copied. The
//  runtime, compiler and dependencies are the installed malloyyo CLI's
//  (npm i -g @malloydata/malloyyo), so model.json is always read by the same
//  Malloy version that wrote it.
// =====================================================================

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const { Runtime } = requireFromMalloyyo("@malloydata/malloy");
const { DuckDBConnection } = requireFromMalloyyo("@malloydata/db-duckdb");
const runtimeIndex = path.join(dist, "frame-runtime", "index.ts");

// The connection's setupSQL creates the cfb_games / cfb_drives tables the
// model reads (see raw.malloy). The same SQL runs here for the compile and
// in the page after it downloads the files — one definition of the data.
const config = JSON.parse(fs.readFileSync(path.join(here, "malloy-config.json"), "utf8"));
const setupSQL = config.connections?.duckdb?.setupSQL ?? "";
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
const siteCss = fs.readFileSync(path.join(stageDir, "assets", "site.css"), "utf8");
fs.rmSync(stageDir, { recursive: true, force: true });

// ---- 3: compile the model ahead of time ----------------------------------

// The ad-hoc query the games reports send for a page of drive charts, in the
// shape the component writes it — checked below like every named query.
const DRIVE_BATCH_QUERY = "run: drives -> game_drive_chart + { where: GameId ~ f'401752677, 401754512' }";

/** The givens a dashboard opens with: its artifact's values, else the declarations' defaults. */
function openingGivens(d) {
  const g = {};
  for (const spec of d.givens) {
    let v = d.info.givens?.[spec.name] ?? spec.default;
    if (spec.type === "boolean") v = v === true || v === "true";
    if (v !== undefined && v !== "") g[spec.name] = v;
  }
  return g;
}

async function compileModel() {
  // One entry importing every dashboard file, so the site ships ONE model:
  // the shared sources are the bulk of it, and each dashboard alone would
  // repeat them. Query names are unique across the dashboard files for this.
  const entry = pathToFileURL(path.join(here, "__site_model__.malloy"));
  const entrySource =
    ["##! experimental { givens }", 'import "index.malloy"', 'import "givens.malloy"', 'import "drive-games.malloy"', ...dashboards.map((d) => `import "${d.info.entryFile}"`)].join("\n") + "\n";

  const connection = new DuckDBConnection({ name: "duckdb", workingDirectory: here, setupSQL });
  const runtime = new Runtime({
    urlReader: {
      readURL: async (url) => (url.toString() === entry.href ? entrySource : fs.readFileSync(fileURLToPath(url), "utf8")),
    },
    connections: { lookupConnection: async () => connection },
  });

  let t = Date.now();
  const modelDef = (await runtime.loadModel(entry).getModel())._modelDef;
  const json = JSON.stringify(modelDef);
  console.log(`\n  model compiled in ${Date.now() - t} ms — ${(json.length / 1048576).toFixed(1)} MB`);

  // Every query the site runs, compiled from its own dashboard file and from
  // the saved definition. Any difference means model.json would run
  // something other than what the dashboard says.
  t = Date.now();
  const saved = runtime._loadModelFromModelDef(JSON.parse(json));
  const checks = new Map();
  for (const d of dashboards) {
    const own = runtime.loadModel(pathToFileURL(path.join(here, d.info.entryFile)));
    const givens = openingGivens(d);
    const names = [d.info.query, ...d.givens.map((s) => s.suggest?.query).filter(Boolean)];
    for (const name of names) {
      if (!checks.has(name)) checks.set(name, [own.loadQueryByName(name), saved.loadQueryByName(name), givens]);
    }
    // DRIVE_GAMES isn't in the dashboard's given list (its main query never
    // touches drives), so find the reports that send drive batches by import.
    const sendsDriveBatches = fs.readFileSync(path.join(here, d.info.entryFile), "utf8").includes("drive-games.malloy");
    if (!checks.has(DRIVE_BATCH_QUERY) && sendsDriveBatches) {
      checks.set(DRIVE_BATCH_QUERY, [own.loadQuery(DRIVE_BATCH_QUERY), saved.loadQuery(DRIVE_BATCH_QUERY), { DRIVE_GAMES: "401752677, 401754512" }]);
    }
  }
  for (const [name, [fromSource, fromSaved, givens]] of checks) {
    const [a, b] = await Promise.all([fromSource.getSQL({ givens }), fromSaved.getSQL({ givens })]);
    if (a !== b) throw new Error(`model.json compiles ${name} to different SQL than its dashboard file does`);
  }
  console.log(`  verified ${checks.size} queries against model.json in ${Date.now() - t} ms`);
  return json;
}

const modelJson = await compileModel();

// The parquet the setupSQL reads over https: the page downloads each whole,
// registers it under its URL, then runs the setupSQL against those bytes.
const dataFiles = [...new Set(setupSQL.match(/https:\/\/[^'"\s]+\.parquet/g) || [])];
if (!dataFiles.length) throw new Error("no parquet URLs found in malloy-config.json's setupSQL");

// ---- 4: esbuild --------------------------------------------------------
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

// Malloy's renderer (for tag-only dashboards) and Vega (for <VegaChart>) are
// imported by the runtime but used by none of these dashboards — together
// they were most of every frame's JavaScript. Any use fails loudly.
const unused = (what) => `throw new Error("${what} is not bundled into this site — see build-site.mjs")`;
const lazyFail = (what) => `new Proxy(function () {}, { get() { ${unused(what)} }, apply() { ${unused(what)} }, construct() { ${unused(what)} } })`;
const STUBS = {
  "@malloydata/render": `export const MalloyRenderer = ${lazyFail("Malloy's renderer")};`,
  // loader() is the exception: the runtime calls it once at import time to
  // build a network-blocking loader, so it must hand back a plain object.
  vega: `const v = ${lazyFail("Vega")}; export const parse = v, View = v; export const loader = () => ({});`,
  "vega-lite": `export const compile = ${lazyFail("Vega-Lite")};`,
  "vega-interpreter": `export const expressionInterpreter = ${lazyFail("Vega")};`,
};
const stubPlugin = {
  name: "stub-unused-renderers",
  setup(b) {
    b.onResolve({ filter: /^(@malloydata\/render|vega|vega-lite|vega-interpreter)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
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
    stubPlugin,
    resolvePlugin,
  ],
});

await esbuild.build({
  ...base,
  entryPoints: [path.join(here, "spa", "shell.ts")],
  outfile: path.join(out, "assets", "shell.js"),
  plugins: [resolvePlugin],
});

fs.writeFileSync(path.join(out, "assets", "model.json"), modelJson);
fs.writeFileSync(path.join(out, "assets", "site.css"), siteCss);

// ---- 5: pages ------------------------------------------------------------
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
  model: "assets/model.json",
  dataFiles,
  setupSQL,
  dashboards: dashboards.map((d) => ({ name: d.name, title: d.info.title || d.name, description: d.info.description || "" })),
};

const shellHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<meta name="description" content="College football games, drive charts and team rankings for the 2025 and 2026 seasons, from a Malloy model queried in your browser with DuckDB-WASM.">
${ICON}
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="preconnect" href="https://huggingface.co" crossorigin>
<link rel="preload" href="./assets/model.json" as="fetch" crossorigin="anonymous">
<link rel="modulepreload" href="./assets/shell.js">
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

const size = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
const kb = (f) => `${Math.round(fs.statSync(path.join(out, f)).size / 1024)} KB`;
console.log(`\n  SPA: ${dashboards.map((d) => d.name).join(", ")}`);
console.log(`  shell.js ${kb("assets/shell.js")}, model.json ${kb("assets/model.json")}, frame chunk(s) ${fs
  .readdirSync(path.join(out, "assets", "frames"))
  .map((f) => kb(`assets/frames/${f}`))
  .join(" + ")}`);
console.log(`  data preloaded from ${dataFiles.length} parquet URL(s)`);
console.log(`  docs/ ${(size(out) / 1048576).toFixed(1)} MB — DuckDB-WASM from the jsDelivr CDN\n`);
// native DuckDB keeps the event loop alive
process.exit(0);
