import catalog from "../src/data/yuc-catalog.json" with { type: "json" };
import initialWatchlist from "../src/data/anime-watchlist.json" with { type: "json" };
import { createAnimeApi } from "../scripts/lib/anime-online.mjs";

// Native Vercel function alongside the existing static Astro build.
export default {
	fetch: createAnimeApi({ env: process.env, catalog, initialWatchlist }),
};
