// @ts-nocheck
// =====================================================================
//  The app shell — one page, one DuckDB, every dashboard kept alive.
//
//  `malloyyo dashboard bundle` emits one HTML page per dashboard, and each
//  page boots its own DuckDB-WASM and recompiles the model: every click in
//  the nav is a full reload, and coming back to a report starts it over.
//
//  Here the dashboards live in iframes under a single shell:
//
//    * The shell owns the ONLY DuckDB (from the jsDelivr CDN) and the only
//      Malloy runtime. A frame asks for a query over postMessage — the
//      runtime's own iframe protocol — and the shell answers it. Each
//      dashboard's model is compiled once and reused.
//    * A frame is created the first time its dashboard is opened and is
//      never torn down, only hidden. Switching away and back — by the nav
//      or by the browser's Back button — shows it exactly as it was left:
//      filters, sort, opened drive charts, scroll position.
//    * Each dashboard remembers its own query string. The address bar
//      always carries the visible dashboard's filters, so any view is still
//      a shareable link, and opening that link lands on the same state.
//
//  Every page of the site (index.html, games-2026.html, …) is this same
//  shell; the file name picks the dashboard to show.
// =====================================================================

import * as duckdb from "@duckdb/duckdb-wasm";
import { DuckDBWASMConnection } from "@malloydata/db-duckdb/wasm";
import { API, SingleConnectionRuntime } from "@malloydata/malloy";
import { givensFromSearch, shareSearch, urlStateFromSearch } from "malloyyo:shared/givens-url";
import { jsonRows } from "malloyyo:shared/json-rows";

const SITE = window.__SITE__;
const MODEL_FILES: Record<string, string> = window.__MODEL_FILES__ || {};
const TABLE_FILES: Record<string, string> = window.__TABLE_FILES__ || {};
const DASHBOARDS: { name: string; title: string; entryFile: string }[] = SITE.dashboards;
const byName = new Map(DASHBOARDS.map((d) => [d.name, d]));

// ── DuckDB + Malloy, once for the whole site ────────────────────────

// jsDelivr bundles pinned to the installed duckdb-wasm version, so no
// binaries are copied into the site.
class CdnDuckDB extends DuckDBWASMConnection {
  getBundles() {
    return duckdb.getJsDelivrBundles();
  }
}

// The model sources are inlined at build time (assets/model-files.js), keyed
// by the file:// URL Malloy resolves imports against.
const urlReader = {
  readURL: async (url: URL | string) => {
    const src = MODEL_FILES[url.toString()];
    if (src == null) throw new Error(`model file not found: ${url}`);
    return src;
  },
};

let runtimeP: Promise<any> | null = null;
function getRuntime() {
  if (!runtimeP) {
    runtimeP = (async () => {
      const connection = new CdnDuckDB({ name: "duckdb" });
      await connection.connecting;
      // The model reads Hugging Face over https, so this is normally empty;
      // kept for any project-relative table a model may add.
      const db = (connection as any).database;
      await Promise.all(
        Object.entries(TABLE_FILES).map(async ([name, href]) => {
          const r = await fetch(new URL(href, document.baseURI).href);
          if (!r.ok) throw new Error(`fetch ${href} failed: ${r.status}`);
          await db.registerFileBuffer(name, new Uint8Array(await r.arrayBuffer()));
        })
      );
      return new SingleConnectionRuntime({ connection, urlReader });
    })();
  }
  return runtimeP;
}

// One compiled model per dashboard file, shared by every query it runs.
const models = new Map<string, any>();
const modelFor = (runtime: any, entryFile: string) => {
  if (!models.has(entryFile)) models.set(entryFile, runtime.loadModel(new URL(`file:///${entryFile}`)));
  return models.get(entryFile);
};

// Match `dashboard dev` and the bundled pages exactly: without an explicit
// limit Malloy truncates results to a much smaller default.
const ROW_LIMIT = 5000;
const asRun = (t: string) => (/^\s*run\s*:/.test(t) ? t : `run: ${t}`);

async function run(entryFile: string, req: { query?: string; malloy?: string }, givens: Record<string, unknown>) {
  try {
    const runtime = await getRuntime();
    const text = req.malloy != null ? asRun(req.malloy) : asRun(req.query as string);
    const result = await modelFor(runtime, entryFile).loadQuery(text).run({ rowLimit: ROW_LIMIT, givens: givens ?? {} });
    return { ok: true, rows: jsonRows(result), stable_result: API.util.wrapResult(result) };
  } catch (e: unknown) {
    return { ok: false, problems: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

// ── status pill in the nav ──────────────────────────────────────────
const statusEl = document.getElementById("status")!;
let ready = false;
let inFlight = 0;
function paintStatus(failed?: string) {
  statusEl.className = "status" + (failed ? " failed" : ready && !inFlight ? " ready" : "");
  statusEl.lastChild!.textContent = failed
    ? "DuckDB failed to start"
    : !ready
      ? "Starting DuckDB…"
      : inFlight
        ? "Running query…"
        : "DuckDB ready";
  if (failed) statusEl.title = failed;
}
paintStatus();
// Start the database now, not on the first query: by the time the first
// dashboard has mounted and asked for data, most of the startup is done.
getRuntime().then(
  () => {
    ready = true;
    paintStatus();
  },
  (e) => paintStatus(String(e))
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

// The directory the site is served from — "/" locally, "/<repo>/" on GitHub Pages.
const siteBase = new URL("./", location.href);

/** Which dashboard a URL names: its file name, or "" for the home page. */
function routeOf(url: Location | URL) {
  const file = decodeURIComponent(url.pathname.slice(siteBase.pathname.length)).replace(/\.html$/, "");
  return byName.has(file) ? file : "";
}

const searchOf = (v?: View) => (v ? shareSearch({ givens: v.givens, urlState: v.urlState }) : "");
const urlFor = (name: string, search: string) =>
  name ? new URL(`${name}.html${search}`, siteBase).pathname + search.replace(/^[^?]*/, "") : siteBase.pathname;

function createView(name: string, search: string): View {
  const frame = document.createElement("iframe");
  frame.title = byName.get(name)!.title;
  frame.src = new URL(`frames/${name}.html${search}`, siteBase).href;
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
  const name = routeOf(location);
  show(name, location.search);
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
    const res = await run(byName.get(v.name)!.entryFile, { query: m.query, malloy: m.malloy }, m.givens);
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
