import { createHash } from "node:crypto";
import { parse } from "node-html-parser";

export const isSeason = (value) => /^\d{4}(01|04|07|10)$/.test(value);

export function seasonForDate(date = new Date(), offset = 0) {
	const chinaDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
	const quarter = new Date(
		Date.UTC(
			chinaDate.getUTCFullYear(),
			Math.floor(chinaDate.getUTCMonth() / 3) * 3 + offset * 3,
			1,
		),
	);
	return `${quarter.getUTCFullYear()}${String(quarter.getUTCMonth() + 1).padStart(2, "0")}`;
}

const text = (element) =>
	element?.structuredText.replace(/\s+/g, " ").trim() || "";
const field = (table, prefix) => table.querySelector(`[class^="${prefix}"]`);
function safeUrl(value, base) {
	try {
		const url = new URL(value || "", base);
		return value && ["https:", "http:"].includes(url.protocol)
			? url.href
			: "";
	} catch {
		return "";
	}
}

export function parseYucSeason(html, season) {
	if (!isSeason(season))
		throw new Error("季度格式应为 YYYY01 / YYYY04 / YYYY07 / YYYY10");
	const root = parse(html);
	const sourceUrl = `https://yuc.wiki/${season}/`;
	const items = [];
	for (const titleNode of root.querySelectorAll('[class^="title_cn"]')) {
		const table = titleNode.closest("table");
		if (!table) continue;
		const title = text(titleNode);
		const titleJapanese = text(field(table, "title_jp"));
		const image =
			table.parentNode.previousElementSibling?.querySelector("img");
		const staff = field(table, "staff_")?.structuredText || "";
		const studio =
			staff
				.match(/动画制作[：:]\s*([\s\S]*?)(?=\n[^\n]*[：:]|$)/)?.[1]
				?.replace(/\s+/g, " ")
				.trim() || "";
		const identity = (titleJapanese || title)
			.normalize("NFKC")
			.replace(/\s+/g, "");
		const id = `${season}-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
		if (!title || items.some((item) => item.id === id))
			throw new Error(`新番标题为空或重复：${title}`);
		items.push({
			id,
			season,
			title,
			titleJapanese,
			cover: safeUrl(
				image?.getAttribute("data-src") || image?.getAttribute("src"),
				sourceUrl,
			),
			studio,
			genres: (field(table, "type_tag")?.structuredText || "")
				.split(/[/\n]+/)
				.map((tag) => tag.trim())
				.filter(Boolean),
			broadcast: text(field(table, "broadcast_")),
			website: safeUrl(
				table.querySelector("a")?.getAttribute("href"),
				sourceUrl,
			),
			sourceUrl,
		});
	}
	const expected = Number(
		text(root.querySelector(".intro")).match(/共收录\s*(\d+)/)?.[1],
	);
	if (!items.length || (expected && expected !== items.length)) {
		throw new Error(
			`yuc.wiki ${season} 数据不完整：解析 ${items.length} 部，页面标注 ${expected || "未知"} 部；保留原缓存`,
		);
	}
	return { season, sourceUrl, fetchedAt: new Date().toISOString(), items };
}
