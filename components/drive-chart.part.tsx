// =====================================================================
//  Drive chart — the React/SVG chart from ../dashboards/team-drive-charts.tsx,
//  vendored here so this project stands on its own. sync-components.mjs
//  splices it into every games report component (a malloyyo component
//  may import only React and @malloyyo/dashboard, never a local module).
// =====================================================================

// ---- palette -------------------------------------------------------
// Read off the reference chart: scoring drives carry the saturated
// hues, a drive that LOST ground goes orange, everything else recedes
// to grey. Identity never rests on color — every drive is labelled.
const NAVY = "#1c3557";     // touchdown
const BLUE = "#5b8fd6";     // field goal
const ORANGE = "#e2703a";   // the drive lost yardage
const GREY = "#b3b3b3";     // punt, turnover, clock
const KO_GREY = "#c9ccd0";  // kickoff markers and the dashed routing
const INK = "#1a1c1f";
const MUTED = "#9aa0a6";
const RULE = "#d7dade";

// ---- layout --------------------------------------------------------
const COL = 30;          // per possession — tight, so a whole game fits
const HALF_GAP = 34;     // the break between halves
const REG_GAP = 40;      // the break before overtime; its label stacks to fit
const LABEL_W = 96;      // ledger row labels down the left
const AXIS_W = 24;       // yard numbers, repeated on both sides
const PLOT_PAD = 26;     // room for the opening kickoff, which is routed
                         // in from the LEFT of the first possession
const FINAL_W = 46;      // the "Final" column
const FIELD_H = 300;
const FIELD_TOP = 26;
const LEDGER_TOP_PAD = 16;
const ROW_H = 21;
const RETURN_DX = 10;    // a return touchdown sits this far right of the possession
const U_TURN = 9;        // how far it carries on before turning back
// Every kickoff marker sits this far LEFT of the possession it sets up. Placing
// it midway between the two possessions instead made the kick after halftime —
// and after regulation — reach much further right than the rest, because those
// breaks add a gap to the spacing.
const KO_DX = COL / 2;

/** Team names as they arrive from two different givens — compare loosely. */
const sameTeam = (a: string, b: string) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

const teamWords = (t: string) =>
  String(t || "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);

/**
 * Three-character tags for a team, in the order we would rather use them.
 * The first is the plain one — Alabama becomes Ala — and the rest are
 * fallbacks that reach into the second and third words for teams whose
 * first word is not enough on its own.
 */
const tagCandidates = (t: string): string[] => {
  const w = teamWords(t);
  if (!w.length) return [""];
  const squashed = w.join("");
  const raw = [w[0].slice(0, 3)];
  if (w[1]) raw.push(w[0][0] + w[1].slice(0, 2));
  if (w[1]) raw.push(w[0].slice(0, 2) + w[1][0]);
  if (w[2]) raw.push(w[0][0] + w[1][0] + w[2][0]);
  // For one-word names the fallbacks above have nothing to reach for, so
  // reach further into the word itself — Tulane and Tulsa are both "Tul".
  raw.push(w[0][0] + w[0].slice(3, 5));
  raw.push(w[0].slice(0, 2) + w[0].slice(-1));
  raw.push(squashed.slice(0, 3));
  // The plain tag stands as it is — UC Davis has always read "UC" and
  // there is nothing wrong with it. Only the FALLBACKS, which exist to
  // break a tie, are held to three characters: a one-letter second word
  // would otherwise offer "TA" for Texas A&M, no clearer than what it
  // was replacing.
  const out = [raw[0], ...raw.slice(1).filter((c) => c.length === 3)];
  return out.filter((c, i) => c && out.indexOf(c) === i);
};

/**
 * Tags for the two teams of one game, guaranteed to differ from each other
 * wherever the names allow it. South Dakota and Southern Illinois both come
 * out "Sou" under the plain rule, which left every column of the possession
 * row in that game reading the same three letters — so the pair steps down
 * its fallbacks together until they part: SDa and SIl.
 */
const gameTags = (awayTeam: string, homeTeam: string): [string, string] => {
  const a = tagCandidates(awayTeam);
  const h = tagCandidates(homeTeam);
  if (a[0] !== h[0]) return [a[0], h[0]];

  // A one-word name against a longer one that starts the same way —
  // Michigan and Michigan State — has an obvious reading: the short name
  // keeps the plain tag and only the longer one steps aside, giving
  // Mic and MSt rather than two equally strange halves.
  const aWords = teamWords(awayTeam).length;
  const hWords = teamWords(homeTeam).length;
  if (aWords === 1 && hWords > 1) {
    const ht = h.find((c) => c !== a[0]);
    if (ht) return [a[0], ht];
  }
  if (hWords === 1 && aWords > 1) {
    const at = a.find((c) => c !== h[0]);
    if (at) return [at, h[0]];
  }

  // Otherwise both step down together, so the pair reads as a pair:
  // South Dakota and Southern Illinois become SDa and SIl.
  const depth = Math.max(a.length, h.length);
  for (let i = 1; i < depth; i++) {
    const at = a[Math.min(i, a.length - 1)];
    const ht = h[Math.min(i, h.length - 1)];
    if (at !== ht) return [at, ht];
  }
  // two teams the name itself cannot separate; the plain tag is as good as any
  return [a[0], h[0]];
};

const isGiveaway = (d: any) => d.result_category === "Interception" || d.result_category === "Fumble";

/** The possession itself: orange only when the drive LOST ground. */
const driveColor = (d: any) => {
  if (d.result_category === "Touchdown") return NAVY;
  if (d.result_category === "Field goal") return BLUE;
  // a possession that ended behind where it started
  if (Number(d.yards) < 0) return ORANGE;
  return GREY;
};

/** The result label. A giveaway is called out in orange while its line stays
    grey — the turnover is the news, not the ground the drive covered. */
const labelColor = (d: any) => {
  const line = driveColor(d);
  if (line !== GREY) return line;
  return isGiveaway(d) ? ORANGE : MUTED;
};

/** Seconds of game clock as m:ss. */
const fmtClock = (secs: any) => {
  const s = Number(secs);
  if (!Number.isFinite(s) || s <= 0) return null;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
};

/** Rounded orthogonal path through a list of points. */
function routePath(pts: [number, number][], r = 7) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const ri = Math.min(r, inLen / 2, outLen / 2);
    const ix = cx - ((cx - px) / (inLen || 1)) * ri;
    const iy = cy - ((cy - py) / (inLen || 1)) * ri;
    const ox = cx + ((nx - cx) / (outLen || 1)) * ri;
    const oy = cy + ((ny - cy) / (outLen || 1)) * ri;
    d += ` L ${ix} ${iy} Q ${cx} ${cy} ${ox} ${oy}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

// =====================================================================
//  The chart
// =====================================================================
export type DriveOrient = "up" | "down" | "default";

export function DriveChart({
  game,
  focusTeam,
  orient = "up",
}: {
  game: any;
  /** The team the reader picked, whose possessions get pointed a chosen way. */
  focusTeam?: string;
  /** Which way the picked team drives: up, down, or "default" for the
      fixed convention — home attacks down in every game. */
  orient?: DriveOrient;
}) {
  const [hover, setHover] = useState<{ d: any; x: number; y: number } | null>(null);

  const drives = game.rows;
  const home = game.home_team;
  const away = game.away_team;

  // WHICH WAY IS UP.
  //
  // In field coordinates the home team always attacks 100 and the away team
  // 0, so on an unflipped field the home team drives DOWN the page and the
  // away team up. Read a season one team at a time and that convention
  // fights you: the same offense climbs in one game and falls in the next,
  // for no reason the reader cares about.
  //
  // So the reader points the picked team a fixed way and the chart turns
  // itself over in whichever games it needs to — its home games to send it
  // up, its away games to send it down. "default" opts out and restores the
  // fixed convention, which is what you want when reading the GAME rather
  // than following one team.
  //
  // Every piece of geometry below reads the field through yFor — drives,
  // kickoff markers, the dashed routing, the yard numbers — so this one
  // line flips the entire chart and nothing else has to know.
  const flip =
    !focusTeam || orient === "default"
      ? false
      : orient === "up"
        ? sameTeam(focusTeam, home)
        : sameTeam(focusTeam, away);
  const yFor = (yardline: number) =>
    FIELD_TOP + ((flip ? 100 - yardline : yardline) / 100) * FIELD_H;

  // Two structural breaks split the x spacing: halftime, and — when the
  // game went past the fourth quarter — the end of regulation. Overtime is
  // a different game with different rules, so it reads as its own block.
  const firstSecondHalf = drives.findIndex((d: any) => Number(d.start_period) >= 3);
  const firstOvertime = drives.findIndex((d: any) => Number(d.start_period) >= 5);
  /** Total break width sitting to the LEFT of possession i. */
  const gapBefore = (i: number) =>
    (firstSecondHalf > 0 && i >= firstSecondHalf ? HALF_GAP : 0) +
    (firstOvertime > 0 && i >= firstOvertime ? REG_GAP : 0);
  const xFor = (i: number) =>
    LABEL_W + AXIS_W + PLOT_PAD + i * COL + COL / 2 + gapBefore(i);

  const width =
    LABEL_W + AXIS_W + PLOT_PAD + drives.length * COL +
    gapBefore(drives.length) + FINAL_W + AXIS_W;
  const fieldBottom = FIELD_TOP + FIELD_H;
  const ledgerTop = fieldBottom + LEDGER_TOP_PAD;
  const height = ledgerTop + ROW_H * 4 + 14;

  // ---- kickoffs and the dashed routing between possessions ----------
  const links = useMemo(() => {
    const out: { path: string; ko: { x: number; y: number } | null }[] = [];
    for (let i = 0; i < drives.length; i++) {
      const cur = drives[i];
      const prev = i > 0 ? drives[i - 1] : null;

      // OVERTIME HAS NO KICKOFFS. Each possession is spotted on the
      // opponent's 25 and the ball never leaves the offense's hands to a
      // kicking team, so there is no kickoff to mark and nothing for a
      // dashed line to trace — neither between overtime possessions nor
      // from the last play of regulation into the first of overtime, which
      // is a break like halftime. Drawing them there invented a play that
      // was never run.
      if (Number(cur.start_period) >= 5) continue;
      const startsSecondHalf = !!prev && Number(prev.start_period) <= 2 && Number(cur.start_period) >= 3;
      const startsHalf = i === 0 || startsSecondHalf;
      const prevOffScored = prev ? Number(prev.drive_points) > 0 : false;
      const prevDefTd = prev ? Number(prev.defensive_points_scored) >= 6 : false;
      const prevSafety = prev ? Number(prev.defensive_points_scored) === 2 : false;
      const prevSpecialTeams = !!prev && !!prev.is_special_teams_touchdown;
      const prevPutPointsUp = prevOffScored || prevDefTd || prevSafety || prevSpecialTeams;

      // Who kicks: whoever just scored. On a defensive or special-teams
      // touchdown that is the team that was DEFENDING; after a safety it is
      // the team that was scored upon, which free-kicks. To open a half it
      // is whoever is about to defend.
      //
      // A KICKOFF RETURN row is the exception, because the feed files it
      // under the KICKING team: its "offense" is the team that kicked and
      // its "defense" is the team that ran it back.
      let kicker: string | null = null;
      if (cur.is_kickoff_return_touchdown) kicker = cur.offense;
      else if (prevOffScored) kicker = prev.offense;
      else if (prevDefTd || prevSpecialTeams) kicker = prev.defense;
      else if (prevSafety) kicker = prev.offense;
      else if (startsHalf) kicker = cur.defense;

      const x = xFor(i);
      // a kickoff ends where the return began, which on a return touchdown is
      // the length of the return back from the goal line
      const startY = yFor(
        Number(cur.is_kickoff_return_touchdown ? cur.return_start_yardline ?? cur.start_yardline : cur.start_yardline)
      );

      if (!prev) {
        if (!kicker) continue;
        // opening kickoff: straight down the field from the tee, then across
        // to the possession it set up
        const koY = yFor(kicker === home ? 35 : 65);
        const koX = x - KO_DX;
        out.push({
          path: routePath([[koX, koY], [koX, startY], [x, startY]]),
          ko: { x: koX, y: koY },
        });
        continue;
      }

      const px = xFor(i - 1);
      const endY = yFor(Number(prev.end_yardline));
      const xa = px + COL * 0.36;

      if (kicker) {
        // The dotted line does NOT run out of a possession that scored,
        // nor across halftime: in both cases the ball is dead and goes
        // back to a kicking tee, so the route STARTS at the kickoff
        // marker. Nothing traces from the last play of the half to the
        // second-half kickoff.
        const koY = yFor(kicker === home ? 35 : 65);
        const koX = x - KO_DX;
        const inbound =
          prevPutPointsUp || startsSecondHalf
            ? ""
            : routePath([[px, endY], [xa, endY], [xa, koY], [koX, koY]]) + " ";
        // the kick itself goes straight down the field from the tee — it is a
        // ball in the air, not a route across the chart — and only then runs
        // across to where the return team took over
        out.push({
          path: inbound + routePath([[koX, koY], [koX, startY], [x, startY]]),
          ko: { x: koX, y: koY },
        });
      } else {
        // straight change of possession: the ball is where it is
        const mid = (px + x) / 2;
        out.push({ path: routePath([[px, endY], [mid, endY], [mid, startY], [x, startY]]), ko: null });
      }
    }
    return out;
  }, [drives, flip]);

  const yardLabels = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const fmtYard = (v: number) => (v > 50 ? 100 - v : v);

  // ---- ledger -------------------------------------------------------
  const rows = [
    { key: "poss", label: "Game Poss #" },
    { key: "team", label: "Possession" },
    { key: "away", label: away },
    { key: "home", label: home },
  ];
  const rowY = (n: number) => ledgerTop + n * ROW_H + ROW_H * 0.7;
  const halfX = firstSecondHalf > 0 ? xFor(firstSecondHalf) - COL / 2 - HALF_GAP / 2 : null;
  const regX = firstOvertime > 0 ? xFor(firstOvertime) - COL / 2 - REG_GAP / 2 : null;
  const finalX = xFor(drives.length - 1) + COL / 2 + FINAL_W / 2;
  const [awayTag, homeTag] = gameTags(away, home);
  const abbr = (t: string) => (sameTeam(t, home) ? homeTag : awayTag);

  return (
    <div style={{ position: "relative", overflowX: "auto" }}>
      <svg width={width} height={height} style={{ display: "block", fontFamily: "inherit" }}>
        {/* field boundaries and yard lines */}
        <line x1={LABEL_W + AXIS_W - 8} y1={FIELD_TOP} x2={width - AXIS_W} y2={FIELD_TOP} stroke={RULE} strokeWidth={1} />
        <line x1={LABEL_W + AXIS_W - 8} y1={fieldBottom} x2={width - AXIS_W} y2={fieldBottom} stroke={RULE} strokeWidth={1} />
        {yardLabels.map((v) => (
          <g key={v}>
            <line
              x1={LABEL_W + AXIS_W - 8}
              y1={yFor(v)}
              x2={width - AXIS_W}
              y2={yFor(v)}
              stroke="#f0f1f3"
              strokeWidth={1}
            />
            <text x={LABEL_W + AXIS_W - 12} y={yFor(v) + 3.5} textAnchor="end" fontSize={10} fill={MUTED}>
              {fmtYard(v)}
            </text>
            <text x={width - AXIS_W + 6} y={yFor(v) + 3.5} fontSize={10} fill={MUTED}>
              {fmtYard(v)}
            </text>
          </g>
        ))}

        {/* which way each team is driving, at its own end of the field */}
        <text x={LABEL_W + AXIS_W - 2} y={yFor(12)} fontSize={10.5} fill={MUTED}
          stroke="#fff" strokeWidth={3} paintOrder="stroke">{home} {flip ? "↑" : "↓"}</text>
        <text x={LABEL_W + AXIS_W - 2} y={yFor(90)} fontSize={10.5} fill={MUTED}
          stroke="#fff" strokeWidth={3} paintOrder="stroke">{away} {flip ? "↓" : "↑"}</text>

        {/* dashed routing and kickoff markers, behind the possessions */}
        {links.map((l, i) => (
          <g key={`k${i}`}>
            <path d={l.path} fill="none" stroke={KO_GREY} strokeWidth={1} strokeDasharray="3 3" />
            {l.ko && (
              <>
                <circle cx={l.ko.x} cy={l.ko.y} r={4} fill="#fff" stroke={KO_GREY} strokeWidth={1.4} />
                  <text
                  x={l.ko.x}
                  y={l.ko.y + 15}
                  textAnchor="middle"
                  fontSize={9}
                  fill={MUTED}
                  stroke="#fff"
                  strokeWidth={2.5}
                  paintOrder="stroke"
                >
                  KO
                </text>
              </>
            )}
          </g>
        ))}

        {/* the possessions */}
        {drives.map((d: any, i: number) => {
          const x = xFor(i);
          const y1 = yFor(Number(d.start_yardline));
          const y2 = yFor(Number(d.end_yardline));
          const color = driveColor(d);
          const scored = Number(d.drive_points) > 0;
          // A return touchdown belongs to the OTHER team, so it is drawn as
          // its own line to the goal line that team was attacking, a step to
          // the right of the possession rather than on top of it: dotted for
          // special teams (kickoff, punt, blocked kick), dashed for a defense
          // that took the ball away. A kickoff return has no possession to
          // draw at all — the feed's "drive" IS the return.
          const specialTeams = !!d.is_special_teams_touchdown;
          const kickoffReturn = !!d.is_kickoff_return_touchdown;
          const defensiveTd = !specialTeams && Number(d.defensive_points_scored) >= 6;
          const returnTd = specialTeams || defensiveTd;
          const returnY = yFor(d.is_home_offense ? 0 : 100);
          // A kickoff return is drawn its true length — the feed gives it. A punt
          // or blocked-kick return has no length in the feed, so it starts where
          // the possession ended (see chart_return_start_yardline).
          const returnFromY = yFor(Number(d.return_start_yardline ?? (kickoffReturn ? d.start_yardline : d.end_yardline)));
          // The return turns around: it carries on the way the possession was
          // going, steps right, and comes back the other way to the end zone —
          // a U, which is what a return IS. A kickoff return has no possession
          // to turn out of, so it runs straight.
          const driveDir = Math.sign(y2 - y1) || (d.is_home_offense ? 1 : -1);
          const returnPath = kickoffReturn
            ? `M ${x + RETURN_DX} ${returnFromY} L ${x + RETURN_DX} ${returnY}`
            : routePath(
                [
                  [x, returnFromY],
                  [x, returnFromY + driveDir * U_TURN],
                  [x + RETURN_DX, returnFromY + driveDir * U_TURN],
                  [x + RETURN_DX, returnY],
                ],
                4
              );
          // The possession keeps ITS own result. On a punt return the drive
          // still ended in a punt, so labelling it "ST TD" — the category the
          // return earned it — put the same words on both lines.
          const possessionLabel = !specialTeams
            ? d.result_abbreviation
            : d.special_teams_score_type === "Punt return"
              ? "P"
              : d.special_teams_score_type === "Blocked kick return"
                ? "FGA"
                : d.result_abbreviation;
          return (
            // NOT keyed on drive_number: the feed repeats it across overtime
            // possessions in a handful of games, and duplicate keys make React
            // reuse the wrong node. Position in this already-sorted list is
            // stable for as long as the list is.
            <g key={i}>
              {/* A kickoff return has no possession to draw: the feed's row
                  IS the return, filed under the kicking team. */}
              {!kickoffReturn && (
                <>
                  <line x1={x} y1={y1} x2={x} y2={y2} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
                  <circle cx={x} cy={y1} r={3.2} fill={color} />
                  <circle cx={x} cy={y2} r={4.2} fill={color} />
                </>
              )}
              {/* The other team's touchdown, carried to the goal line THAT
                  team was attacking. Drawn a step to the right of the
                  possession rather than over it, and never solid: dotted for
                  special teams, dashed for a defense that took the ball away. */}
              {returnTd && (
                <g>
                  <path
                    d={returnPath}
                    fill="none"
                    stroke={NAVY}
                    strokeWidth={2}
                    strokeDasharray={specialTeams ? "1 3.5" : "4 3"}
                    strokeLinecap={specialTeams ? "round" : "butt"}
                  />
                  {kickoffReturn && (
                    <circle cx={x + RETURN_DX} cy={returnFromY} r={3} fill="#fff" stroke={NAVY} strokeWidth={1.4} />
                  )}
                  <circle cx={x + RETURN_DX} cy={returnY} r={4.2} fill={NAVY} />
                  <text
                    x={x + RETURN_DX + 6}
                    y={returnY + 3.5}
                    fontSize={9}
                    fontWeight={700}
                    fill={NAVY}
                    stroke="#fff"
                    strokeWidth={2.5}
                    paintOrder="stroke"
                  >
                    TD
                  </text>
                </g>
              )}
              {!kickoffReturn && (
                <text
                  x={x + 7}
                  y={y2 + 3.5}
                  fontSize={9}
                  fontWeight={scored ? 700 : 500}
                  fill={labelColor(d)}
                  stroke="#fff"
                  strokeWidth={2.5}
                  paintOrder="stroke"
                >
                  {possessionLabel}
                </text>
              )}
              {/* a wide invisible target so the tooltip is easy to hit */}
              <rect
                x={x - COL / 2}
                y={FIELD_TOP}
                width={COL}
                height={FIELD_H}
                fill="transparent"
                onMouseEnter={() => setHover({ d, x, y: Math.min(y1, y2) })}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}

        {/* ledger */}
        {rows.map((r, n) => (
          <text key={r.key} x={8} y={rowY(n)} fontSize={n >= 2 ? 12 : 10} fill={n >= 2 ? INK : MUTED}
            fontWeight={n >= 2 ? 700 : 400}>
            {r.label}
          </text>
        ))}
        {drives.map((d: any, i: number) => {
          const x = xFor(i);
          const prev = i > 0 ? drives[i - 1] : null;
          const awayScored = !prev || Number(d.away_score_after) !== Number(prev.away_score_after);
          const homeScored = !prev || Number(d.home_score_after) !== Number(prev.home_score_after);
          const teamScored = Number(d.drive_points) > 0;
          return (
            <g key={`l${i}`}>
              <text x={x} y={rowY(0)} textAnchor="middle" fontSize={10} fill={MUTED}>{d.drive_number}</text>
              <text x={x} y={rowY(1)} textAnchor="middle" fontSize={10}
                fill={teamScored ? INK : MUTED} fontWeight={teamScored ? 700 : 400}>
                {abbr(d.offense)}
              </text>
              <text x={x} y={rowY(2)} textAnchor="middle" fontSize={12}
                fill={awayScored && i > 0 ? INK : MUTED} fontWeight={awayScored && i > 0 ? 700 : 400}>
                {d.away_score_after}
              </text>
              <text x={x} y={rowY(3)} textAnchor="middle" fontSize={12}
                fill={homeScored && i > 0 ? INK : MUTED} fontWeight={homeScored && i > 0 ? 700 : 400}>
                {d.home_score_after}
              </text>
            </g>
          );
        })}
        {halfX !== null && (
          <text x={halfX} y={(rowY(2) + rowY(3)) / 2 + 2} textAnchor="middle" fontSize={12} fill={INK} fontWeight={600}>
            Half
          </text>
        )}
        {/* Only on games that went past the fourth quarter. The score
            standing here is the one that sent the game to overtime; the
            "Final" column at the far right is the one that ended it.
            Stacked over three lines so the break stays as narrow as
            halftime's — set on one line it pushed the overtime a third of
            the chart to the right. */}
        {regX !== null &&
          ["End", "of", "Reg."].map((line, n) => (
            <text
              key={line}
              x={regX}
              y={(rowY(2) + rowY(3)) / 2 + 2 + (n - 1) * 12}
              textAnchor="middle"
              fontSize={12}
              fill={INK}
              fontWeight={600}
            >
              {line}
            </text>
          ))}
        <text x={finalX} y={(rowY(2) + rowY(3)) / 2 + 2} textAnchor="middle" fontSize={12} fill={INK} fontWeight={600}>
          Final
        </text>
      </svg>

      {hover && (
        <div
          style={{
            position: "absolute",
            left: Math.min(hover.x + 12, width - 190),
            top: hover.y,
            pointerEvents: "none",
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            boxShadow: "0 6px 20px rgba(15,20,30,0.14)",
            borderRadius: 7,
            padding: "8px 10px",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: INK,
            minWidth: 168,
            zIndex: 5,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2 }}>
            {hover.d.is_kickoff_return_touchdown
              ? `${hover.d.defense} · kickoff return`
              : `${hover.d.offense} · possession ${hover.d.drive_number}`}
          </div>
          {!hover.d.is_kickoff_return_touchdown && (
            <div style={{ color: MUTED }}>
              {hover.d.quarter_label} quarter · started own {hover.d.start_field_position}
            </div>
          )}
          <div>
            {hover.d.is_kickoff_return_touchdown
              ? `${hover.d.yards} yards, returned for a touchdown`
              : `${hover.d.plays} play${Number(hover.d.plays) === 1 ? "" : "s"}, ${hover.d.yards} yards` +
                (fmtClock(hover.d.elapsed_seconds) ? `, ${fmtClock(hover.d.elapsed_seconds)} min` : "")}
          </div>
          <div style={{ color: labelColor(hover.d), fontWeight: 600 }}>{hover.d.result_category}</div>
          {hover.d.is_special_teams_touchdown ? (
            <div style={{ color: NAVY }}>
              {hover.d.special_teams_score_type} touchdown — {hover.d.defense}
              {!hover.d.is_kickoff_return_touchdown && (
                <span style={{ color: MUTED }}> · return length not in the feed</span>
              )}
            </div>
          ) : (
            Number(hover.d.defensive_points_scored) > 0 && (
              <div style={{ color: NAVY }}>
                {hover.d.defensive_score_type} — {hover.d.defense} {hover.d.defensive_points_scored} pts
              </div>
            )
          )}
          <div style={{ color: MUTED }}>
            {abbr(hover.d.away_team ?? "")} {hover.d.away_score_after} · {abbr(hover.d.home_team ?? "")}{" "}
            {hover.d.home_score_after}
          </div>
        </div>
      )}
    </div>
  );
}

