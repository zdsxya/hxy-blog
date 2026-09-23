import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseYucSeason, seasonForDate } from "../lib/yuc.mjs";
import { updateYuc } from "../update-yuc.mjs";
import { updateWatchlist } from "../lib/anime-watchlist.mjs";

// 与源站已验证的 table/图片相邻结构一致，使用合成标题避免依赖实时网络。
const entry = (
	title = "测试新番",
	jp = "テスト",
	cover = "//img.example.test/cover.jpg",
) => `
<div style="float:left"><img data-src="${cover}"></div>
<div><table><tr><td><p class="title_cn_r1">${title}</p><p class="title_jp_r2">${jp}</p></td>
<td class="type_tag_r1">日常/青春<br>校园</td></tr><tr><td class="staff_r2">导演：甲<br>动画制作：Studio A<br>Studio B</td>
<td><a href="https://example.test/anime/">动画官网</a><p class="broadcast_r">7/5周日深夜</p></td></tr></table></div>`;
const html = (entries, count = entries.length) =>
	`<p class="intro">本期 夏季档 共收录 ${count} 部新番动画</p>${entries.join("")}`;
const sample = () => parseYucSeason(html([entry()]), "202607");

test("北京时间季度边界与跨年", () => {
	assert.equal(seasonForDate(new Date("2026-03-31T15:59:59Z")), "202601");
	assert.equal(seasonForDate(new Date("2026-03-31T16:00:00Z")), "202604");
	assert.equal(seasonForDate(new Date("2026-12-25T00:00:00Z"), 1), "202701");
});

test("解析延迟加载封面、换行标题、中文实体与多制作公司", () => {
	const item = parseYucSeason(
		html([entry("测试 &amp; 新番<br>第二季")]),
		"202607",
	).items[0];
	assert.equal(item.title, "测试 & 新番 第二季");
	assert.equal(item.cover, "https://img.example.test/cover.jpg");
	assert.equal(item.studio, "Studio A Studio B");
	assert.deepEqual(item.genres, ["日常", "青春", "校园"]);
	assert.equal(item.broadcast, "7/5周日深夜");
	assert.equal(item.website, "https://example.test/anime/");
});

test("标题顺序与封面改变不影响条目 ID", () => {
	const first = parseYucSeason(
		html([entry(), entry("另一部", "別の作品")]),
		"202607",
	);
	const second = parseYucSeason(
		html([
			entry("另一部", "別の作品"),
			entry("译名调整", "テスト", "/new.jpg"),
		]),
		"202607",
	);
	assert.equal(first.items[0].id, second.items[1].id);
});

test("网页异常、部分解析、重复番目和非法季度明确失败", () => {
	assert.throws(
		() => parseYucSeason("<h1>Access denied</h1>", "202607"),
		/数据不完整/,
	);
	assert.throws(
		() => parseYucSeason(html([entry()], 2), "202607"),
		/数据不完整/,
	);
	assert.throws(
		() => parseYucSeason(html([entry(), entry()]), "202607"),
		/重复/,
	);
	assert.throws(() => parseYucSeason(html([entry()]), "202613"), /季度格式/);
});

test("不把网页中的脚本 URL 带进卡片", () => {
	const unsafe = html([
		entry("测试", "テスト", "javascript:alert(1)"),
	]).replace("https://example.test/anime/", "javascript:alert(1)");
	const item = parseYucSeason(unsafe, "202607").items[0];
	assert.equal(item.cover, "");
	assert.equal(item.website, "");
});

test("同步失败保留旧缓存与其他季度，首次无数据则报错", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mizuki-yuc-test-"));
	const output = path.join(dir, "catalog.json");
	try {
		await assert.rejects(
			updateYuc({
				output,
				seasons: ["202607"],
				fetchHtml: async () => {
					throw new Error("offline");
				},
			}),
			/没有可用/,
		);
		await updateYuc({
			output,
			seasons: ["202604", "202607"],
			fetchHtml: async () => html([entry()]),
		});
		const before = await fs.readFile(output, "utf8");
		const { warnings } = await updateYuc({
			output,
			seasons: ["202607", "202610"],
			fetchHtml: async () => "<h1>Error</h1>",
		});
		assert.equal(warnings.length, 2);
		assert.equal(await fs.readFile(output, "utf8"), before);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("清单使用源站资料快照，支持状态修改、移除和旧季度保留", () => {
	const season = sample();
	const catalog = { version: 1, seasons: [season] };
	const empty = { version: 1, updatedAt: null, items: [] };
	const request = {
		revision: null,
		items: [
			{ id: season.items[0].id, status: "watching", title: "恶意覆盖" },
		],
	};
	const saved = updateWatchlist(empty, catalog, request);
	assert.equal(saved.items[0].title, "测试新番");
	const changed = updateWatchlist(
		saved,
		{ seasons: [] },
		{
			revision: saved.updatedAt,
			items: [{ id: saved.items[0].id, status: "completed" }],
		},
	);
	assert.equal(changed.items[0].status, "completed");
	assert.notEqual(changed.updatedAt, saved.updatedAt);
	assert.equal(changed.items[0].addedAt, saved.items[0].addedAt);
	assert.deepEqual(
		updateWatchlist(changed, catalog, {
			revision: changed.updatedAt,
			items: [],
		}).items,
		[],
	);
});

test("拒绝未知 ID、重复条目、无效状态和过期页面写入", () => {
	const season = sample();
	const catalog = { seasons: [season] };
	const current = {
		version: 1,
		updatedAt: "2026-09-23T00:00:00Z",
		items: [],
	};
	const item = { id: season.items[0].id, status: "watching" };
	assert.throws(
		() =>
			updateWatchlist(current, catalog, {
				revision: null,
				items: [item],
			}),
		{ status: 409 },
	);
	for (const items of [
		[{ ...item, id: "unknown" }],
		[item, item],
		[{ ...item, status: "unknown" }],
		null,
	]) {
		assert.throws(
			() =>
				updateWatchlist(current, catalog, {
					revision: current.updatedAt,
					items,
				}),
			{ status: 400 },
		);
	}
});
