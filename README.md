# College Football Games — 2025 & 2026

A malloyyo dashboard site built on the 2025 drive-analytics model in the parent folder,
extended to both seasons. Data is read straight from Hugging Face
(`huggingface.co/datasets/24601p/cfb-data`), so every `cfbd_pipeline.py --upload` shows up
on the site without a rebuild.

| Dashboard | What it is |
|---|---|
| `games-2025`, `games-2026` | One scoreboard card per game. Filter by team, conference, week and division (all in the URL as `$TEAM`, `$CONFERENCE`, `$GAME_WEEK`, `$DIVISION`); sort by kickoff, thrill index, CFBD excitement, closest finish, most points or biggest upset (`~sort=`). Pick one team and every game opens with its drive chart, with the Up / Down / Default direction control (`~orient=`); otherwise any card's chart opens on click. |
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
runs `malloyyo dashboard bundle` for the dashboard metadata and model files, then builds both with
the installed malloyyo CLI's runtime and esbuild.

## Run

```bash
node sync-components.mjs          # after editing components/*.part.tsx
malloyyo lint
malloyyo dashboard dev            # http://localhost:4173
node build-site.mjs               # the SPA, into docs/ — then commit and push
```
