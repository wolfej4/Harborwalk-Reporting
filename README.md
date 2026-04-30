# Harborwalk Reporting

A lightweight, single-page tool for entering daily Harborwalk operating numbers
(lunch / dinner / retail) alongside a 1–10 weather rank fetched automatically
from [OpenMeteo](https://open-meteo.com/), and reviewing them on a metrics page
that compares any two periods.

## Run it

It is a static site — no build step, no API key.

### Local

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Or just open `index.html` directly in a browser.

### Docker

```sh
docker compose up -d --build
# open http://<host>:3000
```

The image is `nginx:1.27-alpine` serving the three static files. Change the
host port in `docker-compose.yml` if `3000` is taken.

### Portainer

Two options:

**Stack from Git (recommended):**

1. Portainer → **Stacks → Add stack → Repository**.
2. Repository URL: `https://github.com/wolfej4/Harborwalk-Reporting`
3. Reference: `refs/heads/main` (or whichever branch you've merged to).
4. Compose path: `docker-compose.yml`.
5. **Deploy the stack.** Portainer will `docker compose build` and start it.

**Stack from web editor:**

1. Portainer → **Stacks → Add stack → Web editor**.
2. Paste the contents of `docker-compose.yml`.
3. Because the editor build context can't reach the repo, switch the
   `build: .` line to a prebuilt `image:` reference, or use the Repository
   option above.

Data lives entirely in the visitor's browser `localStorage`, so the container
itself is stateless — no volumes needed. Use the **Records → Export CSV**
button to back up.

## Data captured per day

- Date
- Weather rank (1–10)
- Lunch revenue & covers
- Dinner revenue & covers
- Retail revenue & transactions
- Raw weather detail (high/low °F, precipitation, wind, cloud cover, WMO code)

Records are stored in `localStorage` under `hw.records.v1`. Use the **Records**
tab to export to / import from CSV, or delete individual rows.

## Weather ranking

The **Fetch from OpenMeteo** button calls the daily archive (past dates) or
forecast (today / future) endpoint and computes a 1–10 score weighted toward
revenue-relevant factors: temperature distance from a 75 °F ideal,
precipitation, wind, cloud cover, and extreme-temperature penalties. The score
is editable — operators can tweak it after fetch.

Set the location (default Boston Harborwalk: 42.3601, -71.0589) on the
**Settings** tab.

## Metrics

The **Metrics** tab compares two date ranges (Period A vs. Period B) with:

- A summary table (totals, averages, deltas, % change)
- Daily revenue line chart
- Daily covers bar chart
- Revenue-vs-weather scatter

Quick presets cover last 7 / last 30 / MTD / YTD against the matched prior
period.
