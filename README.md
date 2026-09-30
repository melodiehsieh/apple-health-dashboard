# Apple Health Dashboard

Personal Apple Health data, parsed and charted at [melodiehsieh.com](https://melodiehsieh.com).

- `pipeline/` — scripts that parse the raw Apple Health export (`export.xml` + `workout-routes/*.gpx`) into Parquet/DuckDB tables, then precompute every chart's data into one small `site_data.json`. Raw exports and all generated data live in `data/`, which is gitignored and never committed.
- `site/` — the static site. Fetches `site_data.json` and renders the charts; no client-side query engine, no backend.

Full processing plan and open decisions: see the project doc.

## Credits

Homepage wallpaper: Photo by [Zongnan Bao](https://unsplash.com/@zbao?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText) on [Unsplash](https://unsplash.com/photos/green-grass-field-under-blue-sky-during-daytime-DznqzDPA0WM?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText)

Homepage cow photos from Wikimedia Commons, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). I cut out the backgrounds, resized them, and placed them on the wallpaper:

- [Diary cow looking at camera](https://commons.wikimedia.org/wiki/File:Diary_cow_looking_at_camera_ylinen_2025.jpg), [Cow looking at camera 2025](https://commons.wikimedia.org/wiki/File:Cow_looking_at_camera_2025.jpg), [Cow resting while looking at camera](https://commons.wikimedia.org/wiki/File:Cow_resting_while_looking_at_camera_ylinen_2025.jpg) and [Resting cow looking at camera 2025](https://commons.wikimedia.org/wiki/File:Resting_cow_looking_at_camera_2025.jpg) by Osmo Lundell
- [Cows in Switzerland looking into the camera](https://commons.wikimedia.org/wiki/File:Cows_in_Switzerland_looking_into_the_camera.jpg) by Jonas Eppler

## How the site is laid out

One Cloudflare Pages project serves both pages from one deploy:

- `melodiehsieh.com/` is the homepage, built in [melodiehsieh-home](https://github.com/melodiehsieh/melodiehsieh-home). The deploy workflow checks that repo out and `site/scripts/assemble-homepage.sh` copies its `dist/` (page and résumé PDF) into the site root.
- `melodiehsieh.com/health/` is this dashboard (`site/health/index.html`; its JS and data load from `/assets` and `/data`).
- `/api/prs` is the PRs Pages Function, unchanged.

After the homepage repo changes, redeploy with Actions -> "Deploy to Cloudflare Pages" -> Run workflow (or `gh workflow run deploy.yml`). To preview locally: `cd site && npm run build && HOMEPAGE_DIR=../../melodiehsieh-home/dist bash scripts/assemble-homepage.sh`, then serve `site/dist`.
