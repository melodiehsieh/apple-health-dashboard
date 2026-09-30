import { defineConfig } from "vite";

// The dashboard's page lives at health/index.html so it is served at /health/.
// Its JS/CSS still build into /assets and its data into /data, so every absolute
// path in the code (/data/site_data.json, /api/prs, /log-pr) keeps working.
// The site root (/) is the homepage, copied in by scripts/assemble-homepage.sh.
export default defineConfig({
  build: { rollupOptions: { input: "health/index.html" } },
  server: { open: "/health/" },
});
