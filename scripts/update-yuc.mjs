import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import axios from "axios";
import { isSeason, parseYucSeason, seasonForDate } from "./lib/yuc.mjs";

export const catalogPath = fileURLToPath(
	new URL("../src/data/yuc-catalog.json", import.meta.url),
);

export async function updateYuc({
	seasons = [seasonForDate(), seasonForDate(new Date(), 1)],
	output = catalogPath,
	fetchHtml,
} = {}) {
	let catalog = { version: 1, seasons: [] };
	try {
		catalog = JSON.parse(await fs.readFile(output, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const warnings = [];
	for (const season of [...new Set(seasons)]) {
		if (!isSeason(season)) throw new Error(`无效季度：${season}`);
		try {
			const url = `https://yuc.wiki/${season}/`;
			const html = fetchHtml
				? await fetchHtml(url)
				: (
						await axios.get(url, {
							timeout: 20000,
							maxContentLength: 5 * 1024 * 1024,
							headers: {
								"User-Agent": "Mizuki-Yuc-Sync/1.0",
								Accept: "text/html",
							},
						})
					).data;
			const data = parseYucSeason(html, season);
			catalog.seasons = [
				...catalog.seasons.filter((item) => item.season !== season),
				data,
			];
			console.log(`[Yuc] ${season}: ${data.items.length} 部新番`);
		} catch (error) {
			const cached = catalog.seasons.find(
				(item) => item.season === season,
			);
			const message = `${season} 同步失败${cached ? "，继续使用缓存" : "，该季度暂不可用"}：${error.message}`;
			warnings.push(message);
			console.warn(`[Yuc] ${message}`);
		}
	}
	if (!catalog.seasons.some((item) => item.items.length))
		throw new Error("没有可用的新番数据，请检查网络后运行 pnpm update-yuc");
	catalog.seasons.sort((a, b) => b.season.localeCompare(a.season));
	await fs.writeFile(
		`${output}.tmp`,
		`${JSON.stringify(catalog, null, 2)}\n`,
	);
	await fs.rename(`${output}.tmp`, output);
	return { catalog, warnings };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const args = process.argv.slice(2).filter((value) => value !== "--");
	if (
		args.length &&
		(args.length !== 2 || args[0] !== "--season" || !isSeason(args[1]))
	) {
		console.error("用法：pnpm update-yuc [--season YYYYMM]");
		process.exitCode = 1;
	} else {
		updateYuc(args.length ? { seasons: [args[1]] } : {}).catch((error) => {
			console.error(`[Yuc] ${error.message}`);
			process.exitCode = 1;
		});
	}
}
