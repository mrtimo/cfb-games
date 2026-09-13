// =====================================================================
//  Team Rankings — one wide table, re-ranked by clicking any header.
//
//  The query returns every team's numbers once; sorting is the reader's
//  and happens here, so a click re-ranks instantly instead of re-running
//  the join. The sort column and direction live in the URL (~sort, ~dir)
//  beside the givens, so a ranking is a shareable link.
//
//  First click on a column ranks it best-first — which is descending for
//  points scored and ascending for points allowed. A second click flips it.
//
//  Cells are tinted by how good the value is among the teams on screen:
//  one hue, deeper for better, so the eye can run down a column. The
//  number is always printed; the tint only repeats it.
// =====================================================================

import React, { useMemo } from "react";
import { Controls, Given, useQuery, useUrlState } from "@malloyyo/dashboard";

const SURFACE = "#ffffff";
const BORDER = "#e5e7eb";
const HEAD_BG = "#f7f8fa";
const INK = "#16181c";
const INK_2 = "#4b5563";
const MUTED = "#8a9099";
const ACCENT = "#2a78d6";
const TINT = "42, 120, 214";

type Better = "high" | "low";
type Col = {
  key: string;
  label: string;
  group: string;
  title: string;
  fmt: (v: any) => string;
  better?: Better;
  text?: boolean;
};

const dash = "—";
const pct = (v: any) => (v == null ? dash : `${(Number(v) * 100).toFixed(1)}%`);
const fixed = (d: number) => (v: any) => (v == null ? dash : Number(v).toFixed(d));
const signed = (d: number) => (v: any) =>
  v == null ? dash : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(d)}`;
const whole = (v: any) => (v == null ? dash : Math.round(Number(v)).toLocaleString());
const plain = (v: any) => (v == null ? dash : String(v));

const COLUMNS: Col[] = [
  { key: "team", label: "Team", group: "", title: "Team", fmt: plain, text: true },
  { key: "conference", label: "Conf", group: "", title: "Conference", fmt: plain, text: true },

  { key: "games_played", label: "G", group: "Record", title: "Completed games played", fmt: whole, better: "high" },
  { key: "wins", label: "W", group: "Record", title: "Wins", fmt: whole, better: "high" },
  { key: "losses", label: "L", group: "Record", title: "Losses", fmt: whole, better: "low" },
  { key: "win_rate", label: "Win %", group: "Record", title: "Share of completed games won", fmt: pct, better: "high" },

  { key: "points_per_game", label: "Pts/G", group: "Scoring", title: "Points scored per game", fmt: fixed(1), better: "high" },
  { key: "points_allowed_per_game", label: "Opp Pts/G", group: "Scoring", title: "Points allowed per game", fmt: fixed(1), better: "low" },
  { key: "avg_scoring_margin", label: "Margin", group: "Scoring", title: "Average scoring margin per game", fmt: signed(1), better: "high" },

  { key: "offense_points_per_drive", label: "Pts/Dr", group: "Offense", title: "Points scored per offensive drive", fmt: fixed(2), better: "high" },
  { key: "offense_yards_per_play", label: "Yds/Play", group: "Offense", title: "Yards gained per play", fmt: fixed(2), better: "high" },
  { key: "offense_eckel_rate", label: "Eckel", group: "Offense", title: "Eckel rate: share of drives that scored a TD or reached the opponent's 35 after gaining 10+ yards", fmt: pct, better: "high" },
  { key: "offense_touchdown_rate", label: "TD %", group: "Offense", title: "Share of drives ending in an offensive touchdown", fmt: pct, better: "high" },
  { key: "offense_explosive_rate", label: "40+ Yd %", group: "Offense", title: "Share of drives gaining 40 yards or more", fmt: pct, better: "high" },
  { key: "offense_three_and_out_rate", label: "3&Out %", group: "Offense", title: "Share of drives ending in a three-and-out punt", fmt: pct, better: "low" },
  { key: "offense_turnover_rate", label: "TO %", group: "Offense", title: "Share of drives ending in an interception or fumble", fmt: pct, better: "low" },
  { key: "offense_avg_start", label: "Start", group: "Offense", title: "Average starting field position, yards from own goal line", fmt: fixed(1), better: "high" },
  { key: "offense_drives", label: "Drives", group: "Offense", title: "Offensive drives counted", fmt: whole },

  { key: "defense_points_per_drive", label: "Pts/Dr", group: "Defense", title: "Points allowed per opponent drive", fmt: fixed(2), better: "low" },
  { key: "defense_yards_per_play", label: "Yds/Play", group: "Defense", title: "Yards allowed per play", fmt: fixed(2), better: "low" },
  { key: "defense_eckel_rate", label: "Eckel", group: "Defense", title: "Eckel rate allowed: share of opponent drives that were quality possessions", fmt: pct, better: "low" },
  { key: "defense_three_and_out_rate", label: "3&Out %", group: "Defense", title: "Share of opponent drives forced into a three-and-out", fmt: pct, better: "high" },
  { key: "defense_takeaway_rate", label: "Takeaway %", group: "Defense", title: "Share of opponent drives ending in an interception or fumble", fmt: pct, better: "high" },

  { key: "net_points_per_drive", label: "Net Pts/Dr", group: "Overall", title: "Offensive points per drive minus defensive points per drive allowed", fmt: signed(2), better: "high" },
  { key: "current_elo", label: "Elo", group: "Overall", title: "Elo rating after the most recent rated game", fmt: whole, better: "high" },
  { key: "strength_of_schedule", label: "SOS", group: "Overall", title: "Strength of schedule: average opponent pregame Elo", fmt: whole, better: "high" },
];

// the groups, in column order, with their spans — for the top header row
const GROUPS = COLUMNS.reduce<{ name: string; span: number }[]>((acc, c) => {
  const last = acc[acc.length - 1];
  if (last && last.name === c.group) last.span++;
  else acc.push({ name: c.group, span: 1 });
  return acc;
}, []);

/** The first-click direction for a column: best first, A-Z for text. */
const bestDir = (c: Col) => (c.text || c.better === "low" ? "asc" : "desc");

const ROW_H = 30;
const GROUP_H = 24;
const RANK_W = 42;
const TEAM_W = 170;

export default function Dashboard({ dashboard, givens }: any) {
  const { rows, loading, error } = useQuery({ query: "team_rankings", givens });

  const [sortKey, setSortKey] = useUrlState("sort", "net_points_per_drive");
  const [dir, setDir] = useUrlState("dir", "desc");
  const [search, setSearch] = useUrlState("q", "");

  const col = COLUMNS.find((c) => c.key === sortKey) || COLUMNS.find((c) => c.key === "net_points_per_drive")!;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (rows || []).filter((r: any) => !q || String(r.team).toLowerCase().includes(q));
    const sign = dir === "asc" ? 1 : -1;
    return [...list].sort((a: any, b: any) => {
      const va = a[col.key];
      const vb = b[col.key];
      // missing values rank last whichever way the column is sorted
      if (va == null && vb != null) return 1;
      if (vb == null && va != null) return -1;
      if (va == null && vb == null) return String(a.team).localeCompare(String(b.team));
      const c = col.text ? String(va).localeCompare(String(vb)) : Number(va) - Number(vb);
      return c * sign || String(a.team).localeCompare(String(b.team));
    });
  }, [rows, search, col, dir]);

  // per-column range over the teams on screen, for the tint
  const ranges = useMemo(() => {
    const out: Record<string, [number, number]> = {};
    COLUMNS.forEach((c) => {
      if (!c.better) return;
      const vals = visible.map((r: any) => r[c.key]).filter((v: any) => v != null).map(Number);
      if (vals.length >= 4) out[c.key] = [Math.min(...vals), Math.max(...vals)];
    });
    return out;
  }, [visible]);

  const tint = (c: Col, v: any) => {
    const range = ranges[c.key];
    if (!range || v == null || range[1] === range[0]) return undefined;
    let good = (Number(v) - range[0]) / (range[1] - range[0]);
    if (c.better === "low") good = 1 - good;
    return `rgba(${TINT}, ${(0.02 + 0.26 * good * good).toFixed(3)})`;
  };

  const onHeader = (c: Col) => {
    if (c.key === col.key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSortKey(c.key);
      setDir(bestDir(c));
    }
  };

  const stickyLeft = (i: number): React.CSSProperties =>
    i === 0 ? { position: "sticky", left: RANK_W, zIndex: 1 } : {};

  return (
    <div style={{ maxWidth: 1600, margin: "0 auto", padding: "20px 20px 48px" }}>
      <h1 style={{ margin: "0 0 2px", fontSize: 26, fontWeight: 700, letterSpacing: "-0.01em" }}>
        {dashboard?.title || "Team Rankings"}
      </h1>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--dash-muted, #6b7280)" }}>
        Every team on record, scoring, and drive efficiency on both sides of the ball. Click any column
        header to rank by it; click again to flip. Deeper blue is better among the teams shown.
      </p>

      <Controls>
        <Given name="SEASON" />
        <Given name="DIVISION" />
        <Given name="CONFERENCE" />
        <Given name="EXCLUDE_GARBAGE" />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{
            color: "var(--dash-muted, #888)", marginBottom: 2, fontSize: 11,
            fontWeight: 500, textTransform: "uppercase", letterSpacing: ".03em",
          }}>
            Find team
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name"
            style={{
              fontSize: 13, padding: "4px 8px", borderRadius: 6, width: 160,
              border: "1px solid var(--dash-border, #ccc)",
              background: "var(--dash-control-bg, white)", color: "var(--dash-fg, #1a1a1a)",
            }}
          />
        </div>
      </Controls>

      {loading && <div style={{ fontSize: 13, color: MUTED, marginTop: 16 }}>Ranking teams…</div>}
      {error && <div style={{ fontSize: 13, color: "var(--dash-danger, #b91c1c)", marginTop: 16 }}>{String(error)}</div>}

      {!loading && !error && (
        <>
          <div style={{ fontSize: 12, color: "var(--dash-muted, #6b7280)", margin: "12px 0 6px" }}>
            {visible.length} teams · ranked by <strong>{col.group ? `${col.group} ` : ""}{col.label}</strong>,{" "}
            {col.text ? (dir === "asc" ? "A–Z" : "Z–A") : (dir === bestDir(col) ? "best first" : "worst first")}
          </div>
          <div
            style={{
              overflow: "auto", maxHeight: "calc(100vh - 230px)", minHeight: 300,
              background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10,
            }}
          >
            <table style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5, color: INK, fontVariantNumeric: "tabular-nums", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ ...headCell, top: 0, left: 0, zIndex: 4, height: GROUP_H, width: RANK_W, minWidth: RANK_W }} />
                  {GROUPS.map((g, i) => (
                    <th
                      key={`${g.name}${i}`}
                      colSpan={g.span}
                      style={{
                        ...headCell, top: 0, height: GROUP_H, zIndex: i === 0 ? 4 : 3,
                        ...(i === 0 ? { left: RANK_W } : {}),
                        fontSize: 10.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".06em",
                        textAlign: "center", borderLeft: i === 0 ? undefined : `1px solid ${BORDER}`,
                      }}
                    >
                      {g.name}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th style={{ ...headCell, top: GROUP_H, left: 0, zIndex: 4, width: RANK_W, textAlign: "right", paddingRight: 8 }}>#</th>
                  {COLUMNS.map((c, i) => {
                    const active = c.key === col.key;
                    const groupStart = i > 0 && COLUMNS[i - 1].group !== c.group;
                    return (
                      <th
                        key={c.key}
                        title={c.title}
                        onClick={() => onHeader(c)}
                        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
                        style={{
                          ...headCell, top: GROUP_H, zIndex: i === 0 ? 4 : 3,
                          ...(i === 0 ? { left: RANK_W, minWidth: TEAM_W } : {}),
                          cursor: "pointer", userSelect: "none",
                          textAlign: c.text ? "left" : "right",
                          color: active ? ACCENT : INK_2,
                          borderLeft: groupStart ? `1px solid ${BORDER}` : undefined,
                          boxShadow: active ? `inset 0 -2px 0 ${ACCENT}` : `inset 0 -1px 0 ${BORDER}`,
                        }}
                      >
                        {c.label}
                        <span style={{ display: "inline-block", width: 10, marginLeft: 2, color: active ? ACCENT : "transparent" }}>
                          {dir === "asc" ? "▲" : "▼"}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map((r: any, n: number) => (
                  <tr key={`${r.team}|${r.conference}`}>
                    <td style={{ ...bodyCell, position: "sticky", left: 0, zIndex: 1, background: SURFACE, textAlign: "right", paddingRight: 8, color: MUTED }}>
                      {n + 1}
                    </td>
                    {COLUMNS.map((c, i) => {
                      const active = c.key === col.key;
                      const groupStart = i > 0 && COLUMNS[i - 1].group !== c.group;
                      return (
                        <td
                          key={c.key}
                          style={{
                            ...bodyCell,
                            ...stickyLeft(i),
                            background: i === 0 ? SURFACE : tint(c, r[c.key]),
                            textAlign: c.text ? "left" : "right",
                            fontWeight: i === 0 || active ? 650 : 400,
                            color: c.key === "conference" ? INK_2 : INK,
                            borderLeft: groupStart ? `1px solid ${BORDER}` : undefined,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.fmt(r[c.key])}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && (
              <div style={{ fontSize: 13, color: MUTED, padding: 16 }}>No teams match these filters.</div>
            )}
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 10, lineHeight: 1.55, maxWidth: 980 }}>
            Record and scoring count every completed game against any opponent. Drive columns come from
            drive-by-drive data, which exists for Division I games only, and leave out garbage-time
            possessions while the box is ticked. Eckel rate counts a drive that scored a touchdown or
            reached the opponent's 35 after gaining at least ten yards — the drive-level stand-in for a
            first down inside the 40. Elo is CFBD's rating after each team's latest rated game; SOS is the
            average pregame Elo of the opponents played.
          </div>
        </>
      )}
    </div>
  );
}

const headCell: React.CSSProperties = {
  position: "sticky",
  background: HEAD_BG,
  padding: "5px 8px",
  fontWeight: 600,
  fontSize: 11.5,
  whiteSpace: "nowrap",
  boxShadow: `inset 0 -1px 0 ${BORDER}`,
};

const bodyCell: React.CSSProperties = {
  padding: "0 8px",
  height: ROW_H,
  borderBottom: "1px solid #f0f1f3",
};
