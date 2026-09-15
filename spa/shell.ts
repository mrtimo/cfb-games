// @ts-nocheck
// =====================================================================
//  The app shell — one page, one DuckDB, every dashboard kept alive.
//
//  `malloyyo dashboard bundle` emits one HTML page per dashboard, and each
//  page boots its own DuckDB-WASM and compiles the model from source in the
//  browser — which is where the time goes: Malloy's compiler runs 20-30x
//  slower in a page than in Node. Here:
//
//    * The model is COMPILED AT BUILD TIME (build-site.mjs) and shipped as
//      assets/model.json. The page loads that definition and never sees a
//      .malloy file; only each query's own few lines are compiled here.
//    * Three things start the moment the page loads, side by side: the
//      model.json download, the parquet downloads, and DuckDB-WASM (from
//      the jsDelivr CDN).
//    * The parquet is fetched ONCE, whole, and registered with DuckDB under
//      the exact https URL the model reads. Every query after that is a
//      memory read — no range requests back to Hugging Face per query.
//    * Dashboards live in iframes that are created on first visit and then
//      only hidden, so going back to one shows it exactly as it was left.
//      A frame asks for a query over postMessage (the runtime's own iframe
//      protocol) and the shell answers from the one shared database.
//    * Each dashboard remembers its own query string; the address bar always
//      carries the visible dashboard's filters, so every view is a link.
//
//  Every page of the site (index.html, games-2026.html, …) is this same
//  shell; the file name picks the dashboard to show. Open the console for
//  a timing line per startup step and per query ([cfb]).
// =====================================================================

import * as duckdb from "@duckdb/duckdb-wasm";
import { DuckDBWASMConnection } from "@malloydata/db-duckdb/wasm";
import { API, SingleConnectionRuntime } from "@malloydata/malloy";
import { givensFromSearch, shareSearch, urlStateFromSearch } from "malloyyo:shared/givens-url";
import { jsonRows } from "malloyyo:shared/json-rows";

const SITE = window.__SITE__;
const DASHBOARDS: { name: string; title: string }[] = SITE.dashboards;
const byName = new Map(DASHBOARDS.map((d) => [d.name, d]));

const T0 = performance.now();
const ms = (since = T0) => Math.round(performance.now() - since);
const log = (msg: string) => console.info(`[cfb] ${msg} — ${ms()} ms after load`);

// The directory the site is served from — "/" locally, "/<repo>/" on GitHub Pages.
const siteBase = new URL("./", location.href);

// ── start everything at once ────────────────────────────────────────

class CdnDuckDB extends DuckDBWASMConnection {
  getBundles() {
    return duckdb.getJsDelivrBundles();
  }
}

const modelP = fetch(new URL(SITE.model, siteBase))
  .then((r) => {
    if (!r.ok) throw new Error(`model.json: ${r.status} ${r.statusText}`);
    return r.json();
  })
  .then((def) => {
    log("compiled model loaded");
    return def;
  });

const dataP = Promise.all(
  (SITE.dataFiles as string[]).map(async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
    return [url, new Uint8Array(await r.arrayBuffer())] as const;
  })
).then((files) => {
  const mb = files.reduce((n, [, b]) => n + b.byteLength, 0) / 1048576;
  log(`data downloaded (${files.length} parquet files, ${mb.toFixed(1)} MB)`);
  return files;
});

const connectionP = (async () => {
  const connection = new CdnDuckDB({ name: "duckdb" });
  await connection.connecting;
  log("DuckDB-WASM started");
  return connection;
})();

const modelReady = (async () => {
  const [def, files, connection] = await Promise.all([modelP, dataP, connectionP]);
  const db = (connection as any).database;
  // Registered under the URL itself: the model's SQL reads
  // read_parquet(['https://…']), and DuckDB-WASM resolves a registered name
  // before it would ever go to the network.
  for (const [url, bytes] of files) await db.registerFileBuffer(url, bytes);
  // Decode the parquet ONCE, into the cfb_games / cfb_drives tables the
  // model reads — the same setupSQL the local connection runs (from
  // malloy-config.json). Reading parquet costs ~0.4 s per scan in
  // DuckDB-WASM even from memory; a table scan takes a few milliseconds,
  // and the drive model scans its data several times per query.
  const loadStart = performance.now();
  const setup = await db.connect();
  for (const statement of String(SITE.setupSQL || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    await setup.query(statement);
  }
  await setup.close();
  log(`tables loaded (${ms(loadStart)} ms)`);
  const runtime = new SingleConnectionRuntime({
    connection,
    // The site ships a compiled model; a source fetch means something asked
    // for a file that isn't in model.json, and should fail loudly.
    urlReader: {
      readURL: async (url: URL) => {
        throw new Error(`unexpected .malloy fetch (${url}) — rebuild model.json with build-site.mjs`);
      },
    },
  });
  const model = runtime._loadModelFromModelDef(def);
  log("ready");
  return model;
})();

// For measuring from the console: await cfbDebug.model, then time
// .loadQuery(text).getSQL() (compile) against (await cfbDebug.connection).runSQL(sql) (DuckDB).
(window as any).cfbDebug = { model: modelReady, connection: connectionP };

// ── queries ─────────────────────────────────────────────────────────

// Match `dashboard dev` and the bundled pages: without an explicit limit
// Malloy truncates results to a much smaller default.
const ROW_LIMIT = 5000;
const NAMED = /^\s*(?:run\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const asRun = (t: string) => (/^\s*run\s*:/.test(t) ? t : `run: ${t}`);

async function execute(text: string, named: RegExpExecArray | null, givens: Record<string, unknown>, asked: number) {
  const started = performance.now();
  try {
    const model = await modelReady;
    const waited = Math.round(started - asked) + ms(started);
    const ranAt = performance.now();
    // A named query needs no parsing at all; anything else is compiled here
    // against the loaded model — a few lines, not the whole model.
    const query = named ? model.loadQueryByName(named[1]) : model.loadQuery(asRun(text));
    const result = await query.run({ rowLimit: ROW_LIMIT, givens: givens ?? {} });
    const label = named ? named[1] : text.replace(/\s+/g, " ").slice(0, 60);
    console.info(`[cfb] ${label}: ${result.data.rowCount} rows in ${ms(ranAt)} ms` + (waited > 5 ? ` (waited ${waited} ms for startup or earlier queries)` : ""));
    return { ok: true, rows: jsonRows(result), stable_result: API.util.wrapResult(result) };
  } catch (e: unknown) {
    return { ok: false, problems: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

// ONE query at a time, content first. DuckDB-WASM runs a single query at a
// time anyway, so the only choice is the ORDER — and a frame asks for its
// picker lists (the *_suggest queries) the moment it mounts, ahead of the
// drive charts it asks for once the games list is back. Left in arrival
// order, every page of drive charts waited behind four menus nobody had
// opened yet.
const waiting: { low: boolean; go: () => void }[] = [];
let busy = false;
function pump() {
  if (busy || !waiting.length) return;
  const i = waiting.findIndex((w) => !w.low);
  const [job] = waiting.splice(i >= 0 ? i : 0, 1);
  busy = true;
  job.go();
}
function schedule<T>(low: boolean, task: () => Promise<T>): Promise<T> {
  return new Promise((resolve) => {
    waiting.push({
      low,
      go: () =>
        task()
          .then(resolve)
          .finally(() => {
            busy = false;
            pump();
          }),
    });
    pump();
  });
}

// Every answer is kept for the life of the page, keyed by the query and its
// givens: the data does not change while the page is open, and a picker list
// or a games list for filters already seen comes back instantly instead of
// running again. Failures are not kept.
const answers = new Map<string, Promise<any>>();
const MAX_ANSWERS = 400;

function run(req: { query?: string; malloy?: string }, givens: Record<string, unknown>) {
  const text = (req.malloy ?? req.query ?? "") as string;
  const key = JSON.stringify([text, givens ?? {}]);
  let answer = answers.get(key);
  if (!answer) {
    const named = NAMED.exec(text);
    const low = !!named && /_suggest$/.test(named[1]);
    const asked = performance.now();
    answer = schedule(low, () => execute(text, named, givens, asked));
    answers.set(key, answer);
    answer.then((res) => {
      if (!res.ok) answers.delete(key);
    });
    if (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value);
  }
  return answer;
}

// ── status pill in the nav ──────────────────────────────────────────
const statusEl = document.getElementById("status")!;
let ready = false;
let inFlight = 0;
function paintStatus(failed?: string) {
  statusEl.className = "status" + (failed ? " failed" : ready && !inFlight ? " ready" : "");
  statusEl.lastChild!.textContent = failed
    ? "Failed to start"
    : !ready
      ? "Loading data…"
      : inFlight
        ? "Running query…"
        : "Ready";
  if (failed) statusEl.title = failed;
}
paintStatus();
modelReady.then(
  () => {
    ready = true;
    paintStatus();
  },
  (e) => {
    console.error("[cfb] startup failed", e);
    paintStatus(String(e?.message ?? e));
  }
);

// ── views ───────────────────────────────────────────────────────────

type View = {
  name: string;
  frame: HTMLIFrameElement;
  givens: Record<string, unknown>;
  urlState: Record<string, unknown>;
};

const stage = document.getElementById("stage")!;
const home = document.getElementById("home")!;
const views = new Map<string, View>();
let current = "";

/** Which dashboard a URL names: its file name, or "" for the home page. */
function routeOf(url: Location | URL) {
  const file = decodeURIComponent(url.pathname.slice(siteBase.pathname.length)).replace(/\.html$/, "");
  return byName.has(file) ? file : "";
}

const searchOf = (v?: View) => (v ? shareSearch({ givens: v.givens, urlState: v.urlState }) : "");
const urlFor = (name: string, search: string) =>
  (name ? new URL(`${encodeURIComponent(name)}.html`, siteBase).pathname : siteBase.pathname) + search;

function createView(name: string, search: string): View {
  const frame = document.createElement("iframe");
  frame.title = byName.get(name)!.title;
  frame.src = new URL(`frames/${encodeURIComponent(name)}.html${search}`, siteBase).href;
  stage.appendChild(frame);
  const v = { name, frame, givens: givensFromSearch(search), urlState: urlStateFromSearch(search) };
  views.set(name, v);
  return v;
}

/** Show a dashboard ("" for home). `search` seeds a view that doesn't exist
    yet; an existing view keeps the state it already has. */
function show(name: string, search: string) {
  current = name;
  if (name && !views.has(name)) createView(name, search);
  home.hidden = name !== "";
  for (const [n, v] of views) {
    const on = n === name;
    v.frame.classList.toggle("on", on);
    v.frame.inert = !on;
    v.frame.setAttribute("aria-hidden", String(!on));
  }
  document.querySelectorAll<HTMLAnchorElement>(".dash-nav a[data-route]").forEach((a) => {
    a.classList.toggle("on", a.dataset.route === name && name !== "");
  });
  document.title = name ? `${byName.get(name)!.title} · ${SITE.title}` : SITE.title;
}

/** The address bar follows the visible dashboard's own state. */
function syncAddressBar() {
  if (!current) return;
  const next = urlFor(current, searchOf(views.get(current)));
  if (next !== location.pathname + location.search) history.replaceState({ route: current }, "", next);
}

function go(name: string) {
  if (name === current) return;
  const search = searchOf(views.get(name));
  history.pushState({ route: name }, "", urlFor(name, search));
  show(name, search);
}

// Nav and home-page links switch views in place. Modified clicks (new tab,
// new window) keep the browser's own behavior: every link is a real page.
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest?.("a[data-route]") as HTMLAnchorElement | null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(a.dataset.route || "");
});

// Back / Forward: switch to the dashboard the entry names. If it is already
// alive it comes back as it was left, and the address bar is corrected to
// that state; if not, it starts from the URL.
window.addEventListener("popstate", () => {
  show(routeOf(location), location.search);
  syncAddressBar();
});

// ── the frames' half of the runtime's postMessage protocol ──────────
window.addEventListener("message", async (e) => {
  const v = [...views.values()].find((x) => x.frame.contentWindow === e.source);
  const m = e.data;
  if (!v || !m || typeof m !== "object") return;

  if (m.type === "run") {
    inFlight++;
    paintStatus();
    const res = await run({ query: m.query, malloy: m.malloy }, m.givens);
    inFlight--;
    paintStatus();
    const reply = { type: "result", id: m.id, ...res };
    try {
      (e.source as Window).postMessage(reply, location.origin);
    } catch {
      // anything structured clone refuses goes over as plain JSON
      (e.source as Window).postMessage(JSON.parse(JSON.stringify(reply)), location.origin);
    }
    return;
  }
  if (m.type === "givens" && m.givens) {
    v.givens = m.givens;
    if (v.name === current) syncAddressBar();
    return;
  }
  if (m.type === "urlstate" && m.state) {
    v.urlState = m.state;
    if (v.name === current) syncAddressBar();
    return;
  }
  if (m.type === "navigate" && byName.has(m.dashboard)) {
    // A drill carries new givens into its target, so the target starts over
    // from them rather than keeping whatever it showed before.
    const old = views.get(m.dashboard);
    if (old) {
      old.frame.remove();
      views.delete(m.dashboard);
    }
    const search = shareSearch({ givens: m.givens || {} });
    history.pushState({ route: m.dashboard }, "", urlFor(m.dashboard, search));
    show(m.dashboard, search);
  }
});

// ── first paint ─────────────────────────────────────────────────────
const first = routeOf(location);
show(first, location.search);
history.replaceState({ route: first }, "", location.pathname + location.search);
