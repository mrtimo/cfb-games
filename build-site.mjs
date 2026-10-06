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
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "docs");
const stageDir = path.join(here, ".build");
const TITLE = "College Football Games";
// where GitHub Pages serves docs/ — for canonical links, the sitemap and the
// link-preview tags, which all need absolute URLs
const SITE_URL = "https://mrtimo.github.io/cfb-games/";
const AUTHOR = { name: "Tim Olsen", url: "https://www.linkedin.com/in/4timolsen/", affiliation: "Gonzaga School of Business" };

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

  // FBS teams per season, for the home page's "browse by team" links
  const { rows } = await connection.runSQL(`
    SELECT season, team, conference FROM (
      SELECT Season AS season, HomeTeam AS team, HomeConference AS conference, HomeClassification AS cls FROM cfb_games
      UNION ALL
      SELECT Season, AwayTeam, AwayConference, AwayClassification FROM cfb_games)
    WHERE cls = 'fbs' AND team IS NOT NULL
    GROUP BY ALL ORDER BY season DESC, conference, team`, { rowLimit: 100000 });
  return { json, teams: rows };
}

const { json: modelJson, teams } = await compileModel();

// The files the setupSQL reads over https (the parquet, plus the team-colors
// CSV): the page downloads each whole, registers it under its URL, then runs
// the setupSQL against those bytes.
const dataFiles = [...new Set(setupSQL.match(/https:\/\/[^'"\s]+\.(?:parquet|csv)/g) || [])];
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
/* who made it, after the status pill at the right end of the nav */
.dash-nav .credit{display:flex;align-items:center;gap:5px;color:#9aa1ac;font-size:12px;padding:0 4px 0 10px;margin-left:6px;border-left:1px solid #2c3038;white-space:nowrap}
.dash-nav .credit a{padding:0;border-radius:0;background:none;color:#e6e9ee;font-weight:550}
.dash-nav .credit a:hover{background:none;color:#fff;text-decoration:underline}
@media (max-width:700px){.dash-nav .credit .school{display:none}}
.stage{position:relative;flex:1;min-height:0}
.stage>iframe{position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden;background:var(--bg)}
.stage>iframe.on{visibility:visible}
.home{position:absolute;inset:0;overflow:auto}
.home[hidden]{display:none}
/* the about list is prose, not the index's card links */
.about-list{list-style:none;padding:0;margin:20px 0 0;display:grid;gap:14px;max-width:660px}
.about-list li{font-size:14px;line-height:1.6}
.about-list li strong{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
.index .about-list a{display:inline;padding:0;border:0;border-radius:0;background:none;color:var(--accent);text-decoration:none}
.index .about-list a:hover{text-decoration:underline}
.about-note{max-width:660px;font-size:14px;line-height:1.6;color:var(--muted);margin:10px 0 0}
/* browse by team: plain links, grouped by conference */
.browse{margin-top:34px;max-width:980px}
.browse h2{font-size:17px;margin:0 0 10px}
.browse details{margin:0 0 12px}
.browse summary{cursor:pointer;font-weight:600;font-size:14px;padding:4px 0}
.browse .confs{columns:3 260px;column-gap:28px;margin-top:8px}
.browse .conf{break-inside:avoid;margin:0 0 12px}
.browse h3{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 3px;font-weight:600}
.browse p{margin:0;font-size:13px;line-height:1.7}
.index .browse a{display:inline;padding:0;border:0;border-radius:0;background:none;color:var(--accent);text-decoration:none}
.index .browse a:hover{text-decoration:underline}
`;

// Cache busting. Only the shared chunk carries a content hash in its name;
// shell.js, each frame's entry, model.json and site.css ship under fixed
// names, and GitHub Pages lets a browser hold them for ten minutes. After a
// deploy that served a stale frame against a fresh model — the worst version
// of which is an old model.json under a new shell — so every one of them gets
// ?v=<content hash>.
const version = (rel) =>
  crypto.createHash("sha256").update(fs.readFileSync(path.join(out, rel))).digest("hex").slice(0, 10);
const v = {
  shell: version("assets/shell.js"),
  model: version("assets/model.json"),
  css: version("assets/site.css"),
  frame: Object.fromEntries(dashboards.map((d) => [d.name, version(`assets/frames/${d.name}.js`)])),
};

const site = {
  title: TITLE,
  model: `assets/model.json?v=${v.model}`,
  dataFiles,
  setupSQL,
  // `opening`: the givens each dashboard starts from, so the shell can leave
  // them out of the address bar (games-2026.html already means SEASON=2026)
  dashboards: dashboards.map((d) => ({ name: d.name, title: d.info.title || d.name, description: d.info.description || "", opening: openingGivens(d), givens: d.givens.map((s) => s.name) })),
};

const link = (href, text) => `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;
const ABOUT_HTML = `<div id="about" class="home" hidden><main class="index">
<h1>About</h1>
<p class="about-note">Every game of the 2025 and 2026 college football seasons: the line score, a thrill index, a drive chart of every possession, and team rankings. The data is queried in your browser — there is no server.</p>
<ul class="about-list">
<li><strong>Data</strong>${link("https://collegefootballdata.com/", "collegefootballdata.com")}</li>
<li><strong>Original design for the drive charts</strong>${link("https://bcftoys.com/whiteboard/possession-flow", "BCFToys · possession flow")}</li>
<li><strong>Made with</strong>${link("http://malloydata.dev/", "the Malloy data language")} and ${link("https://github.com/malloydata/malloyyo", "Malloyyo")}</li>
<li><strong>Made by</strong>${link("https://www.linkedin.com/in/4timolsen/", "Tim Olsen")}</li>
</ul>
</main></div>`;

// ---- page metadata (search engines and link previews) ------------------
const PAGES = {
  "": {
    title: "College Football Drive Charts — 2025 & 2026 Games",
    description:
      "Every 2025 and 2026 college football game as a drive chart: every possession, the line score and a thrill index, plus team rankings by drive efficiency. Free, and it runs in your browser.",
  },
  about: {
    title: `About · ${TITLE}`,
    description: "Where the data comes from, the drive-chart design it builds on, and who made the College Football Games site.",
  },
  "games-2026": {
    title: "2026 College Football Games & Drive Charts",
    description:
      "Every 2026 college football game with its line score, thrill index and a drive chart of every possession. Filter by team, conference or week; sort by the most exciting games.",
  },
  "games-2025": {
    title: "2025 College Football Games & Drive Charts",
    description:
      "Every 2025 college football game with its line score, thrill index and a drive chart of every possession. Filter by team, conference or week; sort by the most exciting games.",
  },
  "team-rankings": {
    title: "College Football Team Rankings — Drive Efficiency, Elo & Strength of Schedule",
    description:
      "Every FBS team ranked by record, scoring margin, points per drive, yards per play, three-and-out and turnover rates, Elo and strength of schedule.",
  },
};
const pageMeta = (name) => {
  const d = dashboards.find((x) => x.name === name);
  return PAGES[name] ?? { title: `${d?.info.title || name} · ${TITLE}`, description: d?.info.description || PAGES[""].description };
};
const pagePath = (name) => (name ? `${name}.html` : "");
// the shell retitles the tab as the reader moves around; give it these
for (const d of site.dashboards) d.pageTitle = pageMeta(d.name).title;
site.pageTitles = { "": PAGES[""].title, about: PAGES.about.title };
const OG_IMAGE = fs.existsSync(path.join(here, "og-image.png")) ? `${SITE_URL}assets/og-image.png` : null;
if (OG_IMAGE) fs.copyFileSync(path.join(here, "og-image.png"), path.join(out, "assets", "og-image.png"));

const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      name: TITLE,
      url: SITE_URL,
      description: PAGES[""].description,
      author: {
        "@type": "Person",
        name: AUTHOR.name,
        url: AUTHOR.url,
        affiliation: { "@type": "Organization", name: AUTHOR.affiliation },
      },
    },
    {
      "@type": "Dataset",
      name: "College football games and drives, 2025–2026",
      description:
        "Game results, line scores and drive-by-drive possessions for every 2025 and 2026 college football game, with a thrill index and drive-efficiency measures, explorable as drive charts.",
      url: SITE_URL,
      keywords: ["college football", "drive chart", "CFB", "sports analytics", "FBS", "Malloy"],
      creator: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
      isBasedOn: "https://collegefootballdata.com/",
      temporalCoverage: "2025/2026",
    },
  ],
}).replace(/</g, "\\u003c");

// ---- browse by team: plain links a crawler can follow -------------------
const teamLinks = (season) => {
  const rows = teams.filter((r) => Number(r.season) === season);
  const byConf = new Map();
  for (const r of rows) {
    const c = r.conference || "Independent";
    if (!byConf.has(c)) byConf.set(c, []);
    byConf.get(c).push(r.team);
  }
  return [...byConf]
    .map(
      ([conf, list]) =>
        `<div class="conf"><h3>${esc(conf)}</h3><p>${list
          .map((t) => `<a href="./games-${season}.html?team=${encodeURIComponent(t).replace(/%20/g, "+")}">${esc(t)}</a>`)
          .join(" · ")}</p></div>`
    )
    .join("");
};
const seasons = [...new Set(teams.map((r) => Number(r.season)))].sort((a, b) => b - a);
const BROWSE_HTML = seasons.length
  ? `<section class="browse"><h2>Browse a team's season</h2>${seasons
      .map(
        (s, i) =>
          `<details${i === 0 ? " open" : ""}><summary>${s} FBS teams</summary><div class="confs">${teamLinks(s)}</div></details>`
      )
      .join("")}</section>`
  : "";

const shellHtml = (name) => {
  const meta = pageMeta(name);
  const url = SITE_URL + pagePath(name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<meta name="author" content="${esc(AUTHOR.name)}">
<link rel="canonical" href="${esc(url)}"${dashboards.some((d) => d.name === name) ? ` data-dynamic` : ""}>
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(TITLE)}">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${esc(url)}">
${OG_IMAGE ? `<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A college football drive chart: every possession of a game drawn up and down the field, with the teams' names in the end zones">` : ""}
<meta name="twitter:card" content="${OG_IMAGE ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
${OG_IMAGE ? `<meta name="twitter:image" content="${OG_IMAGE}">` : ""}
<script type="application/ld+json">${jsonLd}</script>
${ICON}
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="preconnect" href="https://huggingface.co" crossorigin>
<link rel="preload" href="./${site.model}" as="fetch" crossorigin="anonymous">
<link rel="modulepreload" href="./assets/shell.js?v=${v.shell}">
<link rel="stylesheet" href="./assets/site.css?v=${v.css}">
<style>${SHELL_CSS}</style>
<script data-goatcounter="https://cfb-drives.goatcounter.com/count"
        async src="//gc.zgo.at/count.js"></script>
</head>
<body class="shell">
<nav class="dash-nav"><a class="brand" href="./" data-route="" title="Home" aria-label="Home">${HOME_ICON}</a><span class="sep"></span>${site.dashboards
  .map((d) => `<a href="./${encodeURIComponent(d.name)}.html" data-route="${esc(d.name)}">${esc(d.title)}</a>`)
  .join("")}<a href="./about.html" data-route="about">About</a><span id="status" class="status" role="status"><i></i><span></span></span><span class="credit">Built by <a href="${AUTHOR.url}" target="_blank" rel="noopener">${esc(AUTHOR.name)}</a><span class="school">· ${esc(AUTHOR.affiliation)}</span></span></nav>
<div id="stage" class="stage">
<div id="home" class="home"><main class="index"><h1>${esc(TITLE)}</h1>
<p class="about-note">Every game of the 2025 and 2026 college football seasons as a drive chart — every possession drawn up and down the field — with the line score, a thrill index for the most exciting games, and team rankings by drive efficiency.</p>
<ul>${site.dashboards
  .map(
    (d) =>
      `<li><a href="./${encodeURIComponent(d.name)}.html" data-route="${esc(d.name)}"><strong>${esc(d.title)}</strong>${
        d.description ? `<span>${esc(d.description)}</span>` : ""
      }</a></li>`
  )
  .join("")}</ul>
${BROWSE_HTML}</main></div>
${ABOUT_HTML}
</div>
<script>window.__SITE__ = ${safeJson(site)};</script>
<script type="module" src="./assets/shell.js?v=${v.shell}"></script>
</body>
</html>
`;
};

fs.writeFileSync(path.join(out, "index.html"), shellHtml(""));
// the About page is the shell too — the file name is what routes it
fs.writeFileSync(path.join(out, "about.html"), shellHtml("about"));
for (const d of dashboards) {
  fs.writeFileSync(path.join(out, `${d.name}.html`), shellHtml(d.name));
  fs.writeFileSync(
    path.join(out, "frames", `${d.name}.html`),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.info.title || d.name)}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="../assets/site.css?v=${v.css}">
</head>
<body>
<div id="root"></div>
<script>
window.__DASHBOARD__ = ${safeJson(d.info)};
window.__GIVENS__ = ${safeJson(d.givens)};
</script>
<script type="module" src="../assets/frames/${encodeURIComponent(d.name)}.js?v=${v.frame[d.name]}"></script>
</body>
</html>
`
  );
}

// ---- sitemap ---------------------------------------------------------------
// GitHub Pages serves this project under /cfb-games/, and crawlers only read a
// robots.txt at the host's root — so no robots.txt here; submit the sitemap in
// Google Search Console instead.
const today = new Date().toISOString().slice(0, 10);
const sitemapUrls = [
  "",
  ...dashboards.map((d) => pagePath(d.name)),
  "about.html",
  ...teams.map((r) => `games-${r.season}.html?team=${encodeURIComponent(r.team).replace(/%20/g, "+")}`),
];
fs.writeFileSync(
  path.join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...new Set(sitemapUrls)].map((u) => `  <url><loc>${esc(SITE_URL + u)}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`
);
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
