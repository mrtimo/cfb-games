// =====================================================================
//  Games report — the page
//
//  One scoreboard card per game, from the dashboard's games_list query.
//  The .malloy file owns every filter (team, conference, division, week
//  and the pinned season); this component owns what the reader does with
//  the result: the sort order, paging, and the drive charts.
//
//  View-state lives in the URL next to the givens, so a sorted, filtered
//  page is a link: ~sort=thrill, ~orient=down.
//
//  Drive charts load lazily. With one team picked, every one of its games
//  opens with its chart, fed by a single team_game_drives query. Without
//  one, a card's chart runs its own one-game query when it is opened —
//  a week can hold three hundred games, and nobody reads three hundred
//  drive charts.
// =====================================================================

const SURFACE = "#ffffff";
const BORDER = "#e5e7eb";
const INK_2 = "#4b5563";
const PAGE_SIZE = 40;

// One hue, darkening with the score: the tier is also written out beside
// the number, so the color only ever repeats what the text says.
const THRILL_COLORS: Record<string, string> = {
  "Instant classic": "#a63d12",
  Thriller: "#e2703a",
  "Good game": "#eeaa82",
  Routine: "#d3d6db",
};

const THRILL_PARTS: [string, string, number][] = [
  ["thrill_closeness", "Close final", 35],
  ["thrill_late_drama", "Close entering the 4th", 20],
  ["thrill_comeback", "Comeback win", 10],
  ["thrill_overtime", "Overtime", 15],
  ["thrill_scoring", "Scoring", 12],
  ["thrill_upset", "Elo upset", 10],
  ["thrill_stakes", "Playoff stakes", 8],
];

const pickValues = (v: any) => {
  try {
    return (filters.values ? filters.values(v) : []).filter(Boolean);
  } catch {
    return [];
  }
};

const num = (v: any): number | null => (v == null || v === "" ? null : Number(v));

/**
 * StartDate is a naive US/Pacific wall-clock time (see games.malloy), so
 * it is read and formatted as UTC — which leaves the wall clock alone —
 * and labelled PT. A value without a zone would otherwise be read as the
 * VIEWER's local time and shift by their offset.
 */
const kickoffDate = (v: any): Date | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  const s = String(v).trim().replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
};

const kickoffTime = (g: any) => kickoffDate(g.start_date)?.getTime() ?? null;

const fmtKickoff = (g: any) => {
  const d = kickoffDate(g.start_date);
  if (!d) return "";
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  if (g.start_time_tbd) return `${day} · time TBD`;
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${day} · ${time} PT`;
};

const isPlayed = (g: any) => !!g.completed && num(g.home_points) != null && num(g.away_points) != null;

const winnerOf = (g: any) => {
  if (!isPlayed(g)) return null;
  const h = Number(g.home_points);
  const a = Number(g.away_points);
  return h > a ? g.home_team : a > h ? g.away_team : null;
};

// ---- sorting ---------------------------------------------------------
// Every sort puts games it has nothing to say about (unplayed games under
// "Closest finish", non-upsets under "Biggest upset") after the rest, in
// kickoff order, rather than dropping them.
type SortSpec = { value: string; text: string; key: (g: any) => number | null; dir: 1 | -1 };

const SORTS: SortSpec[] = [
  { value: "kickoff", text: "Kickoff", key: kickoffTime, dir: 1 },
  { value: "latest", text: "Latest results", key: (g) => (isPlayed(g) ? kickoffTime(g) : null), dir: -1 },
  { value: "thrill", text: "Thrill index", key: (g) => num(g.thrill_index), dir: -1 },
  { value: "excitement", text: "CFBD excitement", key: (g) => num(g.excitement_index), dir: -1 },
  { value: "closest", text: "Closest finish", key: (g) => (isPlayed(g) ? num(g.victory_margin) : null), dir: 1 },
  { value: "points", text: "Most points", key: (g) => (isPlayed(g) ? num(g.total_points) : null), dir: -1 },
  {
    value: "upset",
    text: "Biggest upset",
    key: (g) => (isPlayed(g) && g.is_elo_upset ? Math.abs(Number(g.pregame_elo_edge) || 0) : null),
    dir: -1,
  },
];

function sortGames(rows: any[], sortValue: string) {
  const spec = SORTS.find((s) => s.value === sortValue) || SORTS[0];
  return [...rows].sort((a, b) => {
    const ka = spec.key(a);
    const kb = spec.key(b);
    if (ka == null && kb != null) return 1;
    if (kb == null && ka != null) return -1;
    if (ka != null && kb != null && ka !== kb) return (ka - kb) * spec.dir;
    return (kickoffTime(a) ?? 0) - (kickoffTime(b) ?? 0) || Number(a.game_id) - Number(b.game_id);
  });
}

// ---- small pieces ----------------------------------------------------
const controlLabel: React.CSSProperties = {
  color: "var(--dash-muted, #888)", marginBottom: 2, fontSize: 11,
  fontWeight: 500, textTransform: "uppercase", letterSpacing: ".03em",
};
const selectStyle: React.CSSProperties = {
  fontSize: 13, padding: "4px 7px", borderRadius: 6,
  border: "1px solid var(--dash-border, #ccc)",
  background: "var(--dash-control-bg, white)",
  color: "var(--dash-fg, #1a1a1a)",
};

/** A view-state picker shaped like the <Given> controls beside it. */
function ViewSelect({ label, value, onChange, options, hint }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; text: string }[]; hint?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={controlLabel}>{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.text}</option>
        ))}
      </select>
      {hint !== undefined && (
        <div style={{ fontSize: 10, color: "var(--dash-muted, #888)", marginTop: 2, minHeight: 12 }}>{hint}</div>
      )}
    </div>
  );
}

function Tag({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10.5, fontWeight: 600, letterSpacing: ".02em", padding: "1px 7px",
        borderRadius: 999, whiteSpace: "nowrap",
        background: strong ? "#fbe7dc" : "#f1f3f5",
        color: strong ? "#8a3310" : INK_2,
      }}
    >
      {children}
    </span>
  );
}

/** Line scores, with every overtime period folded into one OT column. */
function periodCells(line: any, played: boolean) {
  const parts = String(line ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (!played || !parts.length) return null;
  const reg = parts.slice(0, 4);
  while (reg.length < 4) reg.push("");
  const ot = parts.slice(4);
  return { reg, ot: ot.length ? String(ot.reduce((s, p) => s + (Number(p) || 0), 0)) : null };
}

function Scoreboard({ g }: { g: any }) {
  const played = isPlayed(g);
  const winner = winnerOf(g);
  const away = periodCells(g.away_line_scores, played);
  const home = periodCells(g.home_line_scores, played);
  const hasOT = !!(away?.ot || home?.ot);
  const hasLines = !!(away && home);

  const cell: React.CSSProperties = { padding: "3px 0", width: 26, textAlign: "center", color: MUTED, fontSize: 12 };
  const rows = [
    { team: g.away_team, conf: g.away_conference, pts: g.away_points, seed: g.away_seed, line: away },
    { team: g.home_team, conf: g.home_conference, pts: g.home_points, seed: g.home_seed, line: home },
  ];

  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontVariantNumeric: "tabular-nums" }}>
      {hasLines && (
        <thead>
          <tr>
            <th />
            {["1", "2", "3", "4"].map((p) => (
              <th key={p} style={{ ...cell, fontSize: 10, fontWeight: 500 }}>{p}</th>
            ))}
            {hasOT && <th style={{ ...cell, fontSize: 10, fontWeight: 500 }}>OT</th>}
            <th style={{ ...cell, fontSize: 10, fontWeight: 500, width: 38 }}>T</th>
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((r, i) => {
          const won = winner != null && sameTeam(winner, r.team);
          return (
            <tr key={i}>
              <td style={{ padding: "3px 10px 3px 0", minWidth: 0 }}>
                {r.seed != null && (
                  <span style={{ fontSize: 10.5, color: MUTED, marginRight: 5 }}>#{r.seed}</span>
                )}
                <span style={{ fontSize: 15, fontWeight: won ? 700 : played ? 500 : 600, color: played && !won ? INK_2 : INK }}>
                  {r.team}
                </span>
                {r.conf && <span style={{ fontSize: 11, color: MUTED, marginLeft: 7 }}>{r.conf}</span>}
              </td>
              {hasLines && r.line!.reg.map((p: string, j: number) => <td key={j} style={cell}>{p}</td>)}
              {hasLines && hasOT && <td style={cell}>{r.line!.ot ?? "0"}</td>}
              <td style={{ padding: "3px 0", width: 38, textAlign: "right", fontSize: 18, fontWeight: won ? 800 : 600, color: won ? INK : INK_2 }}>
                {played ? r.pts : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ThrillMeter({ g }: { g: any }) {
  const v = num(g.thrill_index);
  if (!isPlayed(g) || v == null) {
    // unplayed: what the ratings expect instead
    const edge = num(g.pregame_elo_edge);
    if (edge == null) return <div style={{ fontSize: 12, color: MUTED }}>Not played yet</div>;
    const homeWin = 1 / (1 + Math.pow(10, -edge / 400));
    const fav = homeWin >= 0.5 ? g.home_team : g.away_team;
    return (
      <div style={{ fontSize: 12, color: INK_2, lineHeight: 1.45 }}>
        <div style={{ color: MUTED, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>Elo favorite</div>
        <div style={{ fontWeight: 600, color: INK }}>{fav}</div>
        <div>{Math.round(Math.max(homeWin, 1 - homeWin) * 100)}% to win</div>
      </div>
    );
  }
  const color = THRILL_COLORS[g.thrill_tier] || GREY;
  const why = THRILL_PARTS.map(([k, label, max]) => [label, num(g[k]) ?? 0, max] as const).filter(([, pts]) => pts >= 0.5);
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 26, fontWeight: 800, color: INK, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{v}</span>
        <span style={{ fontSize: 10.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".05em" }}>Thrill</span>
      </div>
      <div style={{ height: 6, background: "#eef0f2", borderRadius: 3, margin: "6px 0 5px", overflow: "hidden" }}>
        <div style={{ width: `${Math.max(2, v)}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      <div style={{ fontSize: 12, color: INK_2, fontWeight: 600 }}>{g.thrill_tier}</div>
      <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>
        {why.map(([label, pts]) => `${label} ${Math.round(pts)}`).join(" · ")}
      </div>
      {num(g.excitement_index) != null && (
        <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>CFBD excitement {Number(g.excitement_index).toFixed(1)}</div>
      )}
    </div>
  );
}

/** One game's drive chart, fetched on its own when the card is opened. */
function LazyDriveChart({ g, focusTeam, orient }: { g: any; focusTeam?: string; orient: DriveOrient }) {
  const q = useQuery({
    malloy: `drives -> game_drive_chart + { where: GameId = ${Number(g.game_id)} }`,
  });
  if (q.loading) return <div style={{ fontSize: 12, color: MUTED, padding: "8px 0" }}>Loading drives…</div>;
  if (q.error) return <div style={{ fontSize: 12, color: "var(--dash-danger, #b91c1c)" }}>{String(q.error)}</div>;
  if (!q.rows?.length) return <div style={{ fontSize: 12, color: MUTED }}>No drive data for this game.</div>;
  return (
    <DriveChart game={{ home_team: g.home_team, away_team: g.away_team, rows: q.rows }} focusTeam={focusTeam} orient={orient} />
  );
}

function GameCard({ g, teamDrives, focusTeam, orient }: {
  g: any;
  /** The team-mode drives for this game, or undefined outside team mode. */
  teamDrives?: { rows: any[] | undefined; loading: boolean };
  focusTeam?: string;
  orient: DriveOrient;
}) {
  const teamMode = !!teamDrives;
  const [open, setOpen] = useState(teamMode);
  useEffect(() => setOpen(teamMode), [teamMode]);
  const canChart = isPlayed(g) && !!g.has_drive_detail;

  const tags: React.ReactNode[] = [];
  if (g.playoff_round) tags.push(<Tag key="po" strong>{g.playoff_round}</Tag>);
  if (g.bowl && g.bowl !== g.playoff_round) tags.push(<Tag key="bowl">{g.bowl}</Tag>);
  if (isPlayed(g) && g.is_overtime) tags.push(<Tag key="ot" strong>Overtime</Tag>);
  if (isPlayed(g) && g.is_comeback_win) tags.push(<Tag key="cb" strong>Comeback</Tag>);
  if (isPlayed(g) && g.is_elo_upset) tags.push(<Tag key="up" strong>Upset</Tag>);
  if (g.conference_game) tags.push(<Tag key="conf">Conference game</Tag>);
  if (g.neutral_site) tags.push(<Tag key="ns">Neutral site</Tag>);

  return (
    <article
      style={{
        background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10,
        padding: "12px 16px", marginTop: 10, color: INK,
      }}
    >
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: INK_2, fontWeight: 600 }}>{g.week_label}</span>
        <span style={{ fontSize: 12, color: MUTED }}>{fmtKickoff(g)}</span>
        {g.venue && <span style={{ fontSize: 12, color: MUTED }}>· {g.venue}</span>}
        {g.attendance != null && isPlayed(g) && (
          <span style={{ fontSize: 12, color: MUTED }}>· {Number(g.attendance).toLocaleString()} fans</span>
        )}
        <span style={{ display: "flex", gap: 5, flexWrap: "wrap", marginLeft: "auto" }}>{tags}</span>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 28px", alignItems: "center" }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <Scoreboard g={g} />
          {g.notes && <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>{g.notes}</div>}
        </div>
        <div style={{ flex: "0 1 210px", minWidth: 150 }}>
          <ThrillMeter g={g} />
        </div>
      </div>

      {canChart && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={() => setOpen(!open)}
            style={{
              fontSize: 12, padding: "3px 10px", borderRadius: 6, cursor: "pointer",
              border: `1px solid ${BORDER}`, background: open ? "#f3f4f6" : SURFACE, color: INK_2,
            }}
          >
            {open ? "Hide drive chart" : "Show drive chart"}
          </button>
          {open && (
            <div style={{ marginTop: 10 }}>
              {teamMode ? (
                teamDrives!.loading ? (
                  <div style={{ fontSize: 12, color: MUTED }}>Loading drives…</div>
                ) : teamDrives!.rows?.length ? (
                  <DriveChart
                    game={{ home_team: g.home_team, away_team: g.away_team, rows: teamDrives!.rows }}
                    focusTeam={focusTeam}
                    orient={orient}
                  />
                ) : (
                  <div style={{ fontSize: 12, color: MUTED }}>No drive data for this game.</div>
                )
              ) : (
                <LazyDriveChart g={g} orient={orient} />
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** Every drive of the picked team's games in one query, split by game. Mounted only in team mode. */
function TeamDrives({ givens, children }: {
  givens: any;
  children: (byGame: Map<number, any[]>, loading: boolean, error?: string) => React.ReactNode;
}) {
  const q = useQuery({ query: "team_game_drives", givens });
  const byGame = useMemo(() => {
    const m = new Map<number, any[]>();
    (q.rows || []).forEach((r: any) => {
      const id = Number(r.game_id);
      if (!m.has(id)) m.set(id, []);
      m.get(id)!.push(r);
    });
    m.forEach((rows) => rows.sort((a, b) => Number(a.drive_number) - Number(b.drive_number)));
    return m;
  }, [q.rows]);
  return <>{children(byGame, q.loading, q.error)}</>;
}

export default function Dashboard({ dashboard, givens }: any) {
  const list = useQuery({ query: "games_list", givens });
  const teamGiven = useGiven("TEAM");
  const team: string = useMemo(() => pickValues(teamGiven.value)[0] || "", [teamGiven.value]);

  const [sort, setSort] = useUrlState("sort", "kickoff");
  const [orient, setOrient] = useUrlState("orient", "up");
  const [shown, setShown] = useState(PAGE_SIZE);

  const rows: any[] = list.rows || [];
  const sorted = useMemo(() => sortGames(rows, sort), [rows, sort]);
  useEffect(() => setShown(PAGE_SIZE), [rows, sort]);

  const played = rows.filter(isPlayed);
  const avgThrill = played.length
    ? played.reduce((s, g) => s + (num(g.thrill_index) ?? 0), 0) / played.length
    : null;
  const record = team
    ? played.reduce(
        (acc, g) => {
          const w = winnerOf(g);
          if (w && sameTeam(w, team)) acc.w++;
          else if (w) acc.l++;
          return acc;
        },
        { w: 0, l: 0 }
      )
    : null;

  const season = rows[0]?.season ?? String(dashboard?.title || "").match(/\d{4}/)?.[0] ?? "";
  const title = dashboard?.title || `${season} Games`;

  const renderList = (byGame?: Map<number, any[]>, drivesLoading = false) => (
    <>
      {sorted.slice(0, shown).map((g) => (
        <GameCard
          key={g.game_id}
          g={g}
          teamDrives={byGame ? { rows: byGame.get(Number(g.game_id)), loading: drivesLoading } : undefined}
          focusTeam={team || undefined}
          orient={orient as DriveOrient}
        />
      ))}
      {sorted.length > shown && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <button
            onClick={() => setShown(shown + PAGE_SIZE)}
            style={{
              fontSize: 13, padding: "7px 16px", borderRadius: 8, cursor: "pointer",
              border: "1px solid var(--dash-border, #d1d5db)", background: "var(--dash-control-bg, #fff)",
              color: "var(--dash-fg, #1a1a1a)",
            }}
          >
            Show {Math.min(PAGE_SIZE, sorted.length - shown)} more of {sorted.length - shown} remaining
          </button>
        </div>
      )}
    </>
  );

  return (
    <div style={{ maxWidth: 1320, margin: "0 auto", padding: "20px 20px 48px" }}>
      <h1 style={{ margin: "0 0 2px", fontSize: 26, fontWeight: 700, letterSpacing: "-0.01em" }}>
        {team ? `${team} · ${title}` : title}
      </h1>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--dash-muted, #6b7280)" }}>
        Every game of the {season} season, with its line score and a thrill index. Pick a team,
        conference or week to narrow the list; pick one team to open every one of its drive charts.
      </p>

      <Controls>
        <Given name="TEAM" />
        <Given name="CONFERENCE" />
        <Given name="GAME_WEEK" />
        <Given name="DIVISION" />
        <ViewSelect label="Sort by" value={sort} onChange={setSort} options={SORTS} hint="" />
        {team && (
          <ViewSelect
            label={`${team} drives`}
            value={orient}
            onChange={setOrient}
            options={[
              { value: "up", text: "Up" },
              { value: "down", text: "Down" },
              { value: "default", text: "Default" },
            ]}
            hint={orient === "default" ? "Home team drives down" : "The field turns over as needed"}
          />
        )}
      </Controls>

      {!list.loading && !list.error && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", alignItems: "baseline", margin: "14px 0 2px", fontSize: 13, color: "var(--dash-muted, #6b7280)" }}>
          <span>
            <strong style={{ color: "var(--dash-fg, #16181c)" }}>{rows.length.toLocaleString()}</strong> games
            {" · "}
            <strong style={{ color: "var(--dash-fg, #16181c)" }}>{played.length.toLocaleString()}</strong> played
          </span>
          {record && played.length > 0 && (
            <span>
              {team} <strong style={{ color: "var(--dash-fg, #16181c)" }}>{record.w}–{record.l}</strong>
            </span>
          )}
          {avgThrill != null && (
            <span>
              average thrill <strong style={{ color: "var(--dash-fg, #16181c)" }}>{avgThrill.toFixed(0)}</strong>
            </span>
          )}
          <details style={{ fontSize: 12 }}>
            <summary style={{ cursor: "pointer" }}>How the thrill index works</summary>
            <div style={{ maxWidth: 640, lineHeight: 1.5, marginTop: 4 }}>
              A 0–100 score from the box score, so every completed game has one. Points for a close
              final (up to 35, gone at a 28-point margin), a close game entering the fourth quarter
              (20, gone at 17), a comeback win (10), overtime (15), combined scoring (12, full at 80
              points), an Elo upset (10, full at a 250-point rating gap) and a playoff game (8), capped
              at 100. Instant classic at 75+, Thriller 55+, Good game 35+. CFBD's own excitement
              rating, built from win-probability swings, is shown beside it where CFBD has published one.
            </div>
          </details>
        </div>
      )}

      {list.loading && <div style={{ fontSize: 13, color: MUTED, marginTop: 16 }}>Loading games…</div>}
      {list.error && <div style={{ fontSize: 13, color: "var(--dash-danger, #b91c1c)", marginTop: 16 }}>{String(list.error)}</div>}
      {!list.loading && !list.error && rows.length === 0 && (
        <div style={{ fontSize: 13, color: MUTED, marginTop: 16 }}>No games match these filters.</div>
      )}

      {!list.loading && !list.error && (team ? (
        <TeamDrives givens={givens}>
          {(byGame, loading, error) => (
            <>
              {error && <div style={{ fontSize: 12, color: "var(--dash-danger, #b91c1c)", marginTop: 10 }}>{error}</div>}
              {renderList(byGame, loading)}
            </>
          )}
        </TeamDrives>
      ) : (
        renderList()
      ))}
    </div>
  );
}
