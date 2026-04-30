# Harborwalk Reporting

A lightweight, single-page tool for entering daily Harborwalk operating numbers
(lunch / dinner / retail) alongside a 1–10 weather rank fetched automatically
from [OpenMeteo](https://open-meteo.com/), and reviewing them on a metrics page
that compares any two periods.

## Run it

It is a static site — no build step, no server, no API key.

```sh
# any static server works; e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser.

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
