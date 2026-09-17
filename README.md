# College Football Games — 2025 & 2026

A malloyyo dashboard site built on the 2025 drive-analytics model in the parent folder,
extended to both seasons. Data is read straight from Hugging Face
(`huggingface.co/datasets/24601p/cfb-data`), so every `cfbd_pipeline.py --upload` shows up
on the site without a rebuild.

| Dashboard | What it is |
|---|---|
| `games-2025`, `games-2026` | One scoreboard card per game. Filter by team, conference, week and division (all in the URL as `$TEAM`, `$CONFERENCE`, `$GAME_WEEK`, `$DIVISION`); sort by kickoff, thrill index, CFBD excitement, closest finish, most points or biggest upset (`~sort=`). Every card opens with its drive chart (hide it per card), under a legend that toggles off (`~legend=`); with one team picked, the Up / Down / Default direction control (`~orient=`) points its drives. Each card links to the other team's full season. Picking a conference clears the team, and a team link clears the conference, week and division — either filter alone is what the reader asked for. |
| `team-rankings` | One wide table of every team — record, points for and allowed, margin, offensive and defensive drive efficiency (points per drive, yards per play, Eckel rate, TD / explosive / three-and-out / turnover rates), Elo and strength of schedule. Click a header to re-rank (`~sort=`, `~dir=`). |

## Files

| File | |
|---|---|
| `raw.malloy` | The Hugging Face parquet, both seasons stacked; plus `team_games_raw`, each game unpivoted to one row per team |
| `games.malloy` | `games_base` — adapted from `../games.malloy`; adds season/week labels, line-score parsing and the **thrill index** |
| `drives.malloy` | `drives_base` — adapted from `../drives.malloy` (garbage time, score repair, chart geometry); adds **Eckel rate** |
| `teams.malloy` | `team_games` — one row per team per game, joined to the drives it ran and defended |
| `index.malloy` | Exports `games`, `drives`, `team_games`; the `game_drive_chart` view |
| `givens.malloy` | `SEASON`, `DIVISION`, `CONFERENCE`, `TEAM`, `GAME_WEEK`, `EXCLUDE_GARBAGE` and their faceted pickers |
| `components/*.part.tsx` | Source for the two games report components — **edit these**, then `node sync-components.mjs` |

## Thrill index (0–100)

Built from the box score so every completed game has one (CFBD's `ExcitementIndex` is missing
on most lower-division games and lags on new ones): close final (35, gone at a 28-point margin),
close entering the 4th (20, gone at 17), comeback win (10), overtime (15), combined scoring
(12, full at 80), Elo upset (10, full at a 250-point gap), playoff game (8); capped at 100.
Instant classic ≥ 75, Thriller ≥ 55, Good game ≥ 35.

## Eckel rate

Share of drives that scored a touchdown or reached the opponent's 35 after gaining at least
ten yards. The textbook definition — a first down inside the opponent's 40 — needs
play-by-play; this is the drive-level stand-in.

## Drive charts: where a drive ends

A drive line is drawn from where the offense took over to **where its possession ended**:
`chart_end_yards_to_goal` in `drives.malloy` is the starting distance less the drive's net yards,
not the feed's `EndYardsToGoal`. On a kick or a return the feed records where the BALL came to
rest — Arizona's 3-play, minus-14-yard possession at BYU in 2026 starts on its own 25 and the feed
ends it on BYU's 11, which drew a three-and-out as a 64-yard march. About a fifth of punts differ
by a punt's distance; interceptions differ by their return. The ball's travel afterwards is still
on the chart as the dashed change-of-possession path. Checked across both seasons: 34,235 of
34,371 non-touchdown drives now draw exactly their net yards (the rest clamp at a goal line).

## Special teams touchdowns

The feed has no field for them, so `drives.malloy` reads them off the shape of the row, and the
chart draws them as a **dotted** line to the scoring team's end zone, a step right of the
possession (`ST TD`):

- **Kickoff return** — filed under the KICKING team as a one-play "drive" of 85+ yards, scoring,
  whose own score never moves. Utah Tech at BYU in 2026 opens the second half with "Utah Tech,
  1 play, 100 yards, TD", which was BYU's return; read literally it credited the wrong team going
  the wrong way. These rows have no possession, so no solid line is drawn. 51 across both seasons.
- **Punt return** — `PUNT TD` / `PUNT RETURN TD`, a punt whose defense gained the points, or a
  short possession the feed calls a TD that ends back on the offense's own goal line (Minnesota's
  two against Eastern Illinois in 2026). 181.
- **Blocked kick return** — `MISSED FG TD`, or a kick whose defense scored. 19.

Counts are from the model's guarded `defensive_points_scored`, which only believes a defensive
score the next drive's scoreboard corroborates, so they run below the raw row counts (296 punt
returns, 77 blocked kicks) on purpose. A kickoff return no longer counts as an offensive touchdown
for the kicking team; it credits nobody's `drive_points`, since the feed books those points
between drives.

## The published site (`docs/`)

Published on GitHub Pages from `docs/` on `main`: https://mrtimo.github.io/cfb-games/

It is a single-page app rather than malloyyo's page-per-dashboard bundle:

- **One DuckDB for the whole site**, started once from the jsDelivr CDN. Switching dashboards
  never restarts it, and each dashboard's model is compiled once.
- **Every dashboard stays alive.** Each one runs in its own iframe, created the first time it is
  opened and afterwards only hidden. Going back to a report — by the nav or the browser's Back
  button — shows it exactly as it was: filters, sort, open drive charts, scroll position.
- **Every view is still a link.** The address bar carries the visible dashboard's filters and
  view-state, and `games-2026.html?$TEAM=Indiana&~sort=thrill` opens straight to that view.

`spa/shell.ts` is the shell (DuckDB, Malloy, routing); `spa/frame-boot.ts` mounts a dashboard in
its frame, talking to the shell with the malloyyo runtime's own iframe protocol. `build-site.mjs`
runs `malloyyo dashboard bundle` for the dashboard metadata, then builds both with the installed
malloyyo CLI's runtime and esbuild.

### What makes it load fast

- **The model is compiled at build time.** `build-site.mjs` compiles one entry importing every
  dashboard in Node, against native DuckDB, and ships the result as `assets/model.json` (about
  1 MB gzipped). The browser never compiles a `.malloy` file — Malloy's compiler runs 20–30×
  slower in a page — only each query's few lines. Before writing it, the build compiles every
  query the site runs both from its dashboard file and from `model.json`, and fails if the SQL
  differs. **Rebuild after changing any `.malloy` file or a parquet schema.** New rows need no
  rebuild.
- **Model, data and DuckDB start together** the moment the page loads. The parquet is fetched once
  and decoded once into DuckDB tables (`cfb_games`, `cfb_drives`) by the `setupSQL` in
  `malloy-config.json` — the same SQL the local connection runs, so dev, lint, the build and the
  page all read identical tables. This mattered more than anything else after pre-compiling:
  DuckDB-WASM spends ~0.4 s decoding parquet on every scan, even from memory, while a table scan
  takes a few ms, and the drive model scans its data several times per query.
- **Queries run content-first and are cached.** The shell runs one query at a time with the picker
  lists (`*_suggest`) after the games and drive charts, and keeps every answer for the life of the
  page, so a filter value already seen comes back instantly.
- **No expression is written out more than once.** Malloy inlines a dimension's expression
  everywhere it is used, and the thrill tier → index → parts → line-score chain grew one query to
  49 KB of SQL and 2.2 s of compile per filter change. `games.malloy` now computes them in query
  stages as columns (a few ms to compile). Keep deep chains of derived dimensions in stages.
- **Frames carry only what they use.** Malloy's renderer and Vega are stubbed out of the frame
  bundle (every dashboard draws itself), taking each frame from 4.5 MB of JavaScript to 0.3 MB.
- **Drive charts load a page at a time** — one query for the 40 games on screen, cached per game —
  and that query sets `DRIVE_GAMES` (`drive-games.malloy`), which narrows the drive model to those
  games *before* its season-wide window passes (dedupe, possessions left, score repair). They all
  partition by game, so the answers are identical over a few hundred drives instead of 45,000.
- **Team Rankings joins drives once.** One join holds a team-game's drives on both sides of the
  ball, with offense and defense as filters, instead of an offense join and a defense join that
  multiplied to ~144 rows per team-game and built the drive model twice. (Test the defense side
  as `on_defense`, never `not on_offense` — an unplayed game's empty join row would count as a
  defensive drive.)

The console logs a `[cfb]` line for each startup step and each query with its time.

## Run

```bash
node sync-components.mjs          # after editing components/*.part.tsx
malloyyo lint
malloyyo dashboard dev            # http://localhost:4173
node build-site.mjs               # the SPA, into docs/ — then commit and push
```
