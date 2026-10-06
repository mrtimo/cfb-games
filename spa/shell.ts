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

// ── the data, cached in the browser ─────────────────────────────────
// Hugging Face can't be cached by the browser on its own: /resolve/ answers
// with a no-store redirect to a freshly signed CDN URL every time. So the
// shell keeps each file in Cache Storage under its git blob id, read from the
// repo's tree listing (one small JSON request), and only downloads a file
// whose id has changed — new data still appears with no rebuild. If the
// listing can't be read it uses whatever copy it has; if Cache Storage is
// unavailable (some private windows) it just downloads, as before.
const DATA_CACHE = "cfb-data-v1";
const HF_FILE = /^https:\/\/huggingface\.co\/datasets\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/;

async function fileVersions(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const repos = new Map<string, { rev: string; files: Map<string, string> }>();
  for (const url of urls) {
    const m = url.match(HF_FILE);
    if (!m) continue;
    const key = `${m[1]}@${m[2]}`;
    if (!repos.has(key)) repos.set(key, { rev: m[2], files: new Map() });
    repos.get(key)!.files.set(m[3], url);
  }
  await Promise.all(
    [...repos].map(async ([key, { rev, files }]) => {
      const repo = key.split("@")[0];
      try {
        const r = await fetch(`https://huggingface.co/api/datasets/${repo}/tree/${rev}`, { cache: "no-store" });
        if (!r.ok) return;
        for (const f of (await r.json()) as { path: string; oid: string }[]) {
          const url = files.get(f.path);
          if (url && f.oid) out.set(url, f.oid);
        }
      } catch {
        // offline or blocked: fall back to whatever is cached
      }
    })
  );
  return out;
}

async function loadFile(url: string, version: string | undefined, cache: Cache | null) {
  const download = async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  if (!cache) return { bytes: await download(), fromCache: false };
  const keys = (await cache.keys()).filter((k) => k.url.split("?v=")[0] === url);
  const wanted = version ? `${url}?v=${version}` : null;
  // the current version, or — when the listing couldn't be read — any copy
  const hit = keys.find((k) => (wanted ? k.url === wanted : true));
  if (hit) {
    const r = await cache.match(hit);
    if (r) return { bytes: new Uint8Array(await r.arrayBuffer()), fromCache: true };
  }
  const bytes = await download();
  if (wanted) {
    try {
      await cache.put(wanted, new Response(bytes));
      for (const k of keys) if (k.url !== wanted) await cache.delete(k);
    } catch {
      // storage full or refused: the page still has the bytes
    }
  }
  return { bytes, fromCache: false };
}

const dataP = (async () => {
  const urls = SITE.dataFiles as string[];
  let cache: Cache | null = null;
  try {
    cache = await caches.open(DATA_CACHE);
  } catch {
    cache = null;
  }
  const versions = cache ? await fileVersions(urls) : new Map<string, string>();
  const files = await Promise.all(
    urls.map(async (url) => {
      const { bytes, fromCache } = await loadFile(url, versions.get(url), cache);
      return [url, bytes, fromCache] as const;
    })
  );
  const mb = files.reduce((n, [, b]) => n + b.byteLength, 0) / 1048576;
  const cached = files.filter(([, , c]) => c).length;
  log(`data ready (${files.length} files, ${mb.toFixed(1)} MB; ${cached} from the browser cache, ${files.length - cached} downloaded)`);
  return files.map(([url, bytes]) => [url, bytes] as const);
})();

const connectionP = (async () => {
  const connection = new CdnDuckDB({ name: "duckdb" });
  await connection.connecting;
  log("DuckDB-WASM started");
  // DuckDB-WASM fetches these extensions from its repository the first time
  // a query needs one — parquet for the setupSQL, icu for time zones, json
  // for Malloy — one at a time, each in the path of a query. Load them now.
  const t = performance.now();
  const db = (connection as any).database;
  await Promise.all(
    ["parquet", "icu", "json"].map(async (ext) => {
      const c = await db.connect();
      try {
        await c.query(`LOAD ${ext}`);
      } catch (e) {
        console.warn(`[cfb] LOAD ${ext} failed — it will autoload instead`, e);
      } finally {
        await c.close();
      }
    })
  );
  log(`extensions loaded (${ms(t)} ms)`);
  return connection;
})();

const modelReady = (async () => {
  const [def, files, connection] = await Promise.all([modelP, dataP, connectionP]);
  const db = (connection as any).database;
  // Registered under a PLAIN local name, and the setupSQL's https URLs
  // rewritten to match. Registered under the https URL itself, DuckDB-WASM
  // still treats the file as remote: each read cost ~240 ms against ~20 ms
  // under a plain name, with the bytes already in memory — most of the
  // seconds this step used to take on a cold start.
  const localName = (url: string, i: number) => `data_${i}_${url.split("/").pop()!.replace(/[^\w.]/g, "_")}`;
  let setupSQL = String(SITE.setupSQL || "");
  for (const [i, [url, bytes]] of files.entries()) {
    const name = localName(url, i);
    await db.registerFileBuffer(name, bytes);
    setupSQL = setupSQL.split(url).join(name);
  }
  // Decode the parquet ONCE, into the cfb_games / cfb_drives tables the
  // model reads — the same setupSQL the local connection runs (from
  // malloy-config.json). Reading parquet costs ~0.4 s per scan in
  // DuckDB-WASM even from memory; a table scan takes a few milliseconds,
  // and the drive model scans its data several times per query.
  const loadStart = performance.now();
  const setup = await db.connect();
  for (const statement of setupSQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    const t = performance.now();
    await setup.query(statement);
    log(`  ${statement.match(/TABLE\s+(\w+)/i)?.[1] ?? "setup"} (${ms(t)} ms)`);
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
// Static pages the shell owns itself — no model, no iframe.
const about = document.getElementById("about");
const isPage = (name: string) => name === "about";
const views = new Map<string, View>();
let current = "";

/** Which dashboard a URL names: its file name, or "" for the home page. */
function routeOf(url: Location | URL) {
  const file = decodeURIComponent(url.pathname.slice(siteBase.pathname.length)).replace(/\.html$/, "");
  return byName.has(file) || isPage(file) ? file : "";
}

/** A dashboard's givens minus the ones still at the value it opens with — a
    pinned season, a default division — so a link carries only what the
    reader actually chose. Left out, they open at that same value. */
function chosenGivens(name: string, givens: Record<string, unknown>) {
  const opening: Record<string, unknown> = (byName.get(name) as any)?.opening ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(givens ?? {})) {
    if (k in opening && String(opening[k]) === String(v)) continue;
    out[k] = v;
  }
  return out;
}
const searchOf = (v?: View) => (v ? shareSearch({ givens: chosenGivens(v.name, v.givens), urlState: v.urlState }) : "");
const urlFor = (name: string, search: string) =>
  (name ? new URL(`${encodeURIComponent(name)}.html`, siteBase).pathname : siteBase.pathname) + toPublic(search);

// ── readable links ──────────────────────────────────────────────────
// Inside, the runtime keeps two namespaces in the query string: `$TEAM`
// for a given, `~sort` for view-state — which a browser shows as %24TEAM
// and %7Esort. The address bar uses plain names instead (team=Oregon,
// sort=latest) and the shell translates at the edge: toPublic on every
// address it writes, fromPublic on every one it reads. Old links in the
// $/~ form still open as they are.
const PUBLIC_ALIAS: Record<string, string> = { GAME_WEEK: "week" };
const publicKey = (given: string) => PUBLIC_ALIAS[given] ?? given.toLowerCase();
function toPublic(search: string) {
  const out = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(search)) {
    out.set(k.charAt(0) === "$" ? publicKey(k.slice(1)) : k.charAt(0) === "~" ? k.slice(1) : k, v);
  }
  const s = out.toString();
  return s ? "?" + s : "";
}
function fromPublic(name: string, search: string) {
  const names: string[] = (byName.get(name) as any)?.givens ?? [];
  const given = new Map(names.map((n) => [publicKey(n), n]));
  const out = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(search)) {
    if (k.charAt(0) === "$" || k.charAt(0) === "~") out.set(k, v);
    else if (given.has(k)) out.set("$" + given.get(k), v);
    else out.set("~" + k, v);
  }
  const s = out.toString();
  return s ? "?" + s : "";
}

// ── GoatCounter ─────────────────────────────────────────────────────
// count.js (in the page head) counts the first page load. Everything the
// reader does after that happens without a page load, so it is counted here:
// a page view per view switched in place, an event per filter or view-state
// change, per button or link clicked inside a dashboard, and per link out.
// A no-op when count.js is blocked or not loaded yet.
function gcCount(path: string, title: string, event: boolean) {
  try {
    window.goatcounter?.count?.({ path, title, event });
  } catch {
    // tracking never breaks the site
  }
}
const gcPageView = (name: string) => gcCount(urlFor(name, ""), document.title, false);
const gcEvent = (path: string, title = path) => gcCount(path.slice(0, 200), title.slice(0, 200), true);
const gcValue = (x: unknown) =>
  x === undefined || x === null || x === "" ? "(cleared)" : typeof x === "string" ? x : JSON.stringify(x);

// Both the givens and the view state arrive once when a frame mounts; that
// first report is where the reader started, not a click, so it only sets the
// baseline. After it, each changed key is one event — held back 1.5 s so a
// search box typed into counts once, with what was finally typed.
const gcSeen = new Map<string, Record<string, unknown>>();
const gcTimers = new Map<string, ReturnType<typeof setTimeout>>();
function gcChanges(view: string, kind: "filter" | "view", next: Record<string, unknown>) {
  const key = `${view}|${kind}`;
  const prev = gcSeen.get(key);
  gcSeen.set(key, next);
  if (!prev) return;
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (JSON.stringify(prev[k]) === JSON.stringify(next[k])) continue;
    const t = `${key}|${k}`;
    clearTimeout(gcTimers.get(t));
    gcTimers.set(t, setTimeout(() => gcEvent(`${kind} · ${view} · ${k} = ${gcValue(next[k])}`), 1500));
  }
}

// Clicks inside a dashboard's frame (same origin, so the shell can listen):
// links out by host, everything else by the control's own label.
function gcWatchFrame(name: string, frame: HTMLIFrameElement) {
  frame.addEventListener("load", () => {
    frame.contentDocument?.addEventListener(
      "click",
      (e) => {
        const el = (e.target as Element).closest?.("a[href], button");
        if (!el) return;
        const href = el.tagName === "A" ? (el as HTMLAnchorElement).href : "";
        if (href && new URL(href).host !== location.host) {
          gcEvent(`outbound · ${new URL(href).host}`, href);
          return;
        }
        const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        if (label) gcEvent(`click · ${name} · ${label}`);
      },
      true
    );
  });
}

function createView(name: string, search: string): View {
  const frame = document.createElement("iframe");
  gcWatchFrame(name, frame);
  frame.title = byName.get(name)!.title;
  // the games reports copy a game's link from inside the frame
  frame.allow = "clipboard-write";
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
  const dashboard = byName.get(name);
  if (dashboard && !views.has(name)) createView(name, search);
  home.hidden = name !== "";
  if (about) about.hidden = name !== "about";
  for (const [n, v] of views) {
    const on = n === name;
    v.frame.classList.toggle("on", on);
    v.frame.inert = !on;
    v.frame.setAttribute("aria-hidden", String(!on));
  }
  document.querySelectorAll<HTMLAnchorElement>(".dash-nav a[data-route]").forEach((a) => {
    a.classList.toggle("on", a.dataset.route === name && name !== "");
  });
  document.title = pageTitle(name);
  updateCanonical(name);
}

/** On a dashboard the canonical address is the page plus the picked team —
    the team is what makes it a different page; sort, colors and the rest are
    the same page viewed another way. */
function updateCanonical(name: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"][data-dynamic]');
  if (!link || !byName.has(name)) return;
  const team = String(views.get(name)?.givens?.TEAM ?? "").trim();
  const u = new URL(`${encodeURIComponent(name)}.html`, link.href);
  if (team) u.search = "?" + new URLSearchParams({ team }).toString();
  link.href = u.href;
}

/** The tab title: the picked team first, when there is one — it is what the
    page is about, and what a search result or a bookmark should say. */
function pageTitle(name: string) {
  const dashboard: any = byName.get(name);
  if (!dashboard) return SITE.pageTitles?.[name] ?? SITE.title;
  const base = dashboard.pageTitle ?? `${dashboard.title} · ${SITE.title}`;
  const team = String(views.get(name)?.givens?.TEAM ?? "").trim();
  return team ? `${team} · ${base}` : base;
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
  gcPageView(name);
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
  show(routeOf(location), fromPublic(routeOf(location), location.search));
  syncAddressBar();
  gcPageView(current);
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
    gcChanges(v.name, "filter", m.givens);
    v.givens = m.givens;
    if (v.name === current) {
      syncAddressBar();
      document.title = pageTitle(v.name);
      updateCanonical(v.name);
    }
    return;
  }
  if (m.type === "urlstate" && m.state) {
    gcChanges(v.name, "view", m.state);
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
      gcSeen.delete(`${m.dashboard}|filter`);
      gcSeen.delete(`${m.dashboard}|view`);
    }
    const search = shareSearch({ givens: chosenGivens(m.dashboard, m.givens || {}) });
    history.pushState({ route: m.dashboard }, "", urlFor(m.dashboard, search));
    show(m.dashboard, search);
    gcPageView(m.dashboard);
  }
});

// ── first paint ─────────────────────────────────────────────────────
const first = routeOf(location);
const firstSearch = fromPublic(first, location.search);
show(first, firstSearch);
// an old $/~ link is rewritten to the readable form straight away
history.replaceState({ route: first }, "", isPage(first) || !first ? location.pathname + location.search : urlFor(first, firstSearch));
