# Harborwalk Reporting

A lightweight tool for entering daily Harborwalk operating numbers
(lunch / dinner / retail) alongside a 1–10 weather rank fetched automatically
from [OpenMeteo](https://open-meteo.com/), and reviewing them on a metrics page
that compares any two periods.

The frontend is plain HTML/CSS/JS. It talks to a small Node.js + Express
backend that persists everything to a JSON file in a Docker volume, so data
survives container restarts and rebuilds, and is shared across every browser
that hits the same instance.

## Run it

### Docker (recommended)

```sh
docker compose up -d --build
# open http://<host>:3000
```

The image is `node:20-alpine`. Records and settings live in the
`harborwalk-data` named volume mounted at `/data` inside the container — back
it up the same way you'd back up any other Portainer/Docker volume.

Change the host port in `docker-compose.yml` if `3000` is taken.

### Local development

```sh
npm install
DATA_DIR=./data npm start
# open http://localhost:3000
```

The server creates `./data/harborwalk.json` on first write.

### Portainer

**Stack from Git (recommended):**

1. Portainer → **Stacks → Add stack → Repository**.
2. Repository URL: `https://github.com/wolfej4/Harborwalk-Reporting`
3. Reference: `refs/heads/main` (or whichever branch you've merged to).
4. Compose path: `docker-compose.yml`.
5. **Deploy the stack.** Portainer will `docker compose build` and start it,
   creating the `harborwalk-data` volume automatically.

The volume persists across stack redeploys. To wipe the data, stop the stack
and delete the `harborwalk-data` volume from the **Volumes** view.

## Data model

Each daily record stores:

- Date
- Weather rank (1–10)
- Lunch revenue & covers
- Dinner revenue & covers
- Retail revenue & transactions
- Raw weather detail (high/low °F, precipitation, wind, cloud cover, WMO code)

The on-disk format is a single `harborwalk.json` file:

```json
{
  "settings": { "label": "...", "lat": 30.39, "lon": -86.49, "tz": "America/Chicago" },
  "records": [ { "date": "2026-04-29", ... } ]
}
```

Use the **Records** tab to export to / import from CSV, or delete individual
rows.

## REST API

All endpoints return JSON.

| Method   | Path                  | Description                               |
| -------- | --------------------- | ----------------------------------------- |
| `GET`    | `/api/health`         | Liveness probe                            |
| `GET`    | `/api/records`        | All records, oldest → newest              |
| `PUT`    | `/api/records/:date`  | Upsert a record (`:date` is `YYYY-MM-DD`) |
| `DELETE` | `/api/records/:date`  | Delete one record                         |
| `DELETE` | `/api/records`        | Delete all records                        |
| `POST`   | `/api/records/bulk`   | Bulk upsert (CSV import)                  |
| `GET`    | `/api/settings`       | Current location settings                 |
| `PUT`    | `/api/settings`       | Update location settings                  |

## Weather ranking

The tool is meant to be filled in after close, so the score reflects the day
that just happened, averaged across all 24 hours rather than peaks. **Fetch
from OpenMeteo** pulls hourly observations (archive endpoint for past days,
forecast endpoint for today) and averages temperature, wind, and cloud cover
across the day, sums precipitation, and picks the most-frequent WMO weather
code as the dominant condition. From those it computes a 1–10 score weighted
toward revenue-relevant factors:

- Temperature distance from a 75 °F daily average
- Total daily precipitation
- Average sustained wind (penalty above ~12 mph)
- Average cloud cover
- Extreme-temperature penalties for very cold or very hot days

The score is editable — operators can tweak it after fetch. The day's high
and low are still stored alongside the averages for reference.

Default location is Destin Harborwalk, FL (30.3935, -86.4958, `America/Chicago`).
Change it on the **Settings** tab.

## Metrics

The **Metrics** tab compares two date ranges (Period A vs. Period B) with:

- A summary table (totals, averages, deltas, % change)
- Daily revenue line chart
- Daily covers bar chart
- Revenue-vs-weather scatter

Quick presets cover last 7 / last 30 / MTD / YTD against the matched prior
period.
