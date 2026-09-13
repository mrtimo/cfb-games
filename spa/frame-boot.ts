// @ts-nocheck
// =====================================================================
//  One dashboard, inside the app shell's iframe.
//
//  The frame runs NO DuckDB and NO Malloy. It mounts the dashboard with
//  the runtime's default postMessage host — the same protocol the
//  sandboxed iframe speaks under `malloyyo dashboard dev` — so every
//  query, every given change and every view-state change goes to the
//  parent, spa/shell.ts, which owns the one database for the whole site.
//
//  The frame's own query string is where its starting state comes from:
//  the shell creates each frame with the URL the reader arrived on.
// =====================================================================

import { mountDashboard } from "@malloyyo/dashboard";
import { givensFromSearch, urlStateFromSearch } from "malloyyo:shared/givens-url";

export function bootFrame(Dashboard: unknown) {
  const info = (window as any).__DASHBOARD__ || {};

  // Opened on its own rather than inside the shell, nobody would answer
  // the frame's queries and it would sit on "Loading" forever. Send the
  // reader to the real page for this dashboard instead.
  if (window.parent === window) {
    location.replace(new URL(`../${info.name}.html${location.search}`, location.href).href);
    return;
  }

  // Same encoder the bundled pages use: `$NAME` givens and `~key` view-state.
  // Set before mount — the runtime reads both lazily for its initial state.
  (window as any).__INITIAL_GIVENS__ = givensFromSearch(location.search);
  (window as any).__INITIAL_URLSTATE__ = urlStateFromSearch(location.search);

  mountDashboard(Dashboard);
}
