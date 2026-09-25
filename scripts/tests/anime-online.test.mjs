import test from "node:test";
import assert from "node:assert/strict";
import { createAnimeApi } from "../lib/anime-online.mjs";

const origin = "https://hxy-blog.vercel.app";
const env = {
	ANIME_ADMIN_PASSWORD: "test-only-admin-password",
	UPSTASH_REDIS_REST_URL: "https://redis.example.test",
	UPSTASH_REDIS_REST_TOKEN: "test-only-redis-token",
	VERCEL_ENV: "production",
};
const initialWatchlist = { version: 1, updatedAt: null, items: [] };
const item = {
	id: "202607:test",
	season: "202607",
	title: "测试新番",
	titleJapanese: "テスト",
	cover: "",
	studio: "",
	genres: [],
	broadcast: "",
	website: "",
	sourceUrl: "https://yuc.wiki/202607/",
};
const catalog = { version: 1, seasons: [{ season: "202607", items: [item] }] };

// In-memory REST transport with Redis expiry/CAS semantics. Each API instance
// shares this external store, rather than sharing any handler process state.
function fixture(overrides = {}) {
	const values = new Map();
	let time = 0;
	let offline = false;
	const get = (key) => {
		const entry = values.get(key);
		return entry && entry.until > time ? entry.value : null;
	};
	const fetchImpl = async (url, options) => {
		assert.equal(url, env.UPSTASH_REDIS_REST_URL);
		assert.equal(
			options.headers.Authorization,
			`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
		);
		if (offline)
			return Response.json(
				{ error: "private provider details" },
				{ status: 500 },
			);
		const [command, ...args] = JSON.parse(options.body);
		let result;
		if (command === "GET") result = get(args[0]);
		else if (command === "SET") {
			values.set(args[0], {
				value: args[1],
				until: args[2] === "EX" ? time + Number(args[3]) : Infinity,
			});
			result = "OK";
		} else if (command === "DEL") result = Number(values.delete(args[0]));
		else if (command === "EVAL") {
			const [script, keyCount, key, expected, next] = args;
			assert.equal(keyCount, 1);
			if (script.includes("INCR")) {
				result = Number(get(key) || 0) + 1;
				values.set(key, {
					value: String(result),
					until: result === 1 ? time + 900 : values.get(key).until,
				});
			} else {
				result = (get(key) ?? "") === expected ? 1 : 0;
				if (result) values.set(key, { value: next, until: Infinity });
			}
		} else throw new Error(`Unexpected Redis command: ${command}`);
		return Response.json({ result });
	};
	const makeApi = (changes = {}) =>
		createAnimeApi({
			env: { ...env, ...overrides, ...changes },
			catalog,
			initialWatchlist,
			fetchImpl,
		});
	return {
		api: makeApi(),
		makeApi,
		values,
		advance: (seconds) => {
			time += seconds;
		},
		setOffline: () => {
			offline = true;
		},
	};
}
function request(
	action = "watchlist",
	{ method = "GET", cookie, data, headers = {}, raw } = {},
) {
	return new Request(`${origin}/api/anime?action=${action}`, {
		method,
		headers: {
			...(method === "POST"
				? { origin, "content-type": "application/json" }
				: {}),
			...(cookie ? { cookie } : {}),
			...headers,
		},
		...(method === "POST"
			? { body: raw ?? JSON.stringify(data ?? {}) }
			: {}),
	});
}
async function login(api) {
	const response = await api(
		request("login", {
			method: "POST",
			data: { password: env.ANIME_ADMIN_PASSWORD },
		}),
	);
	assert.equal(response.status, 200);
	return response.headers.get("set-cookie").split(";")[0];
}
const write = (
	api,
	cookie,
	revision = null,
	items = [{ id: item.id, status: "watching" }],
) =>
	api(
		request("watchlist", {
			method: "POST",
			cookie,
			data: { revision, items },
		}),
	);

test("未配置时展示初始公开清单，并拒绝登录和写入", async () => {
	const { api } = fixture({
		UPSTASH_REDIS_REST_URL: "",
		UPSTASH_REDIS_REST_TOKEN: "",
	});
	const response = await api(request());
	assert.deepEqual(await response.json(), {
		watchlist: initialWatchlist,
		configured: false,
		authenticated: false,
	});
	assert.equal((await write(api)).status, 503);
	assert.equal((await api(request("login", { method: "POST" }))).status, 503);
});

test("访客可读取、不能修改；公开响应禁止 CDN 缓存", async () => {
	const { api } = fixture();
	const response = await api(request());
	assert.equal((await response.json()).authenticated, false);
	assert.match(response.headers.get("cache-control"), /no-store/);
	assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
	assert.equal((await write(api)).status, 401);
	assert.equal(
		(await write(api, `anime_admin=${"a".repeat(64)}`)).status,
		401,
	);
});

test("登录设置 HttpOnly/Secure 会话，密码和 Redis 密钥不出现在响应中", async () => {
	const { api } = fixture();
	const response = await api(
		request("login", {
			method: "POST",
			data: { password: env.ANIME_ADMIN_PASSWORD },
		}),
	);
	assert.equal(response.status, 200);
	const cookie = response.headers.get("set-cookie");
	for (const flag of [
		"HttpOnly",
		"SameSite=Strict",
		"Secure",
		"Max-Age=28800",
		"Path=/api/anime",
	])
		assert.ok(cookie.includes(flag));
	const text = await response.text();
	assert.ok(!text.includes(env.ANIME_ADMIN_PASSWORD));
	assert.ok(!text.includes(env.UPSTASH_REDIS_REST_TOKEN));
	assert.equal(
		(await (await api(request("watchlist", { cookie }))).json())
			.authenticated,
		true,
	);
});

test("登录后添加、换实例读取、修改状态、移除，访客立即读到保存结果", async () => {
	const f = fixture();
	const cookie = await login(f.api);
	const added = await (await write(f.api, cookie)).json();
	assert.equal(added.items[0].title, item.title);
	const second = f.makeApi();
	assert.deepEqual((await (await second(request())).json()).watchlist, added);
	const changed = await (
		await write(second, cookie, added.updatedAt, [
			{ id: item.id, status: "completed" },
		])
	).json();
	assert.equal(changed.items[0].status, "completed");
	assert.equal(changed.items[0].addedAt, added.items[0].addedAt);
	const removed = await (
		await write(second, cookie, changed.updatedAt, [])
	).json();
	assert.deepEqual(removed.items, []);
	assert.deepEqual(
		(await (await f.api(request())).json()).watchlist,
		removed,
	);
});

test("退出撤销服务端会话，复制的旧 Cookie 也不能继续写入", async () => {
	const { api } = fixture();
	const cookie = await login(api);
	const response = await api(request("logout", { method: "POST", cookie }));
	assert.equal(response.status, 200);
	assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
	assert.equal((await write(api, cookie)).status, 401);
});

test("会话到期和管理密码修改后必须重新登录", async () => {
	const f = fixture();
	const cookie = await login(f.api);
	assert.equal(
		(
			await write(
				f.makeApi({ ANIME_ADMIN_PASSWORD: "a-new-strong-password" }),
				cookie,
			)
		).status,
		401,
	);
	f.advance(28801);
	assert.equal((await write(f.api, cookie)).status, 401);
});

test("弱密码不启用编辑；错误密码限流由所有函数实例共享", async () => {
	assert.equal(
		(
			await (
				await fixture({ ANIME_ADMIN_PASSWORD: "short" }).api(request())
			).json()
		).configured,
		false,
	);
	const f = fixture();
	for (let i = 0; i < 5; i++) {
		assert.equal(
			(
				await f.makeApi()(
					request("login", {
						method: "POST",
						data: { password: "wrong" },
					}),
				)
			).status,
			401,
		);
	}
	const blocked = await f.api(
		request("login", {
			method: "POST",
			data: { password: env.ANIME_ADMIN_PASSWORD },
		}),
	);
	assert.equal(blocked.status, 429);
	assert.equal(blocked.headers.get("retry-after"), "900");
	f.advance(901);
	await login(f.api);
});

test("跨站和缺少 Origin 的请求不能登录、写入或退出", async () => {
	const { api } = fixture();
	const cookie = await login(api);
	for (const action of ["login", "watchlist", "logout"]) {
		for (const value of ["https://evil.example", "null", ""]) {
			assert.equal(
				(
					await api(
						request(action, {
							method: "POST",
							cookie,
							headers: { origin: value },
						}),
					)
				).status,
				403,
			);
		}
	}
	assert.equal((await write(api, cookie)).status, 200);
});

test("拒绝无效条目、重复条目、非法状态、无效 JSON 和过大请求", async () => {
	const { api } = fixture();
	const cookie = await login(api);
	for (const items of [
		[{ id: "unknown", status: "watching" }],
		[{ id: item.id, status: "unknown" }],
		[null],
		[
			{ id: item.id, status: "watching" },
			{ id: item.id, status: "watching" },
		],
	]) {
		assert.equal((await write(api, cookie, null, items)).status, 400);
	}
	assert.equal(
		(
			await api(
				request("watchlist", {
					method: "POST",
					cookie,
					raw: "{broken",
				}),
			)
		).status,
		400,
	);
	assert.equal(
		(
			await api(
				request("watchlist", {
					method: "POST",
					cookie,
					raw: "x".repeat(128 * 1024 + 1),
				}),
			)
		).status,
		413,
	);
	assert.equal(
		(
			await api(
				request("watchlist", {
					method: "POST",
					cookie,
					headers: { "content-type": "text/plain" },
				}),
			)
		).status,
		415,
	);
});

test("过期 revision 不覆盖数据；并发首次保存只有一个成功", async () => {
	const f = fixture();
	const cookie = await login(f.api);
	const responses = await Promise.all([
		write(f.api, cookie),
		write(f.makeApi(), cookie),
	]);
	assert.deepEqual(
		responses.map((response) => response.status).sort(),
		[200, 409],
	);
	assert.equal((await write(f.api, cookie, null, [])).status, 409);
	assert.equal(
		(await (await f.api(request())).json()).watchlist.items.length,
		1,
	);
});

test("存储异常时明确失败，不把旧清单冒充最新数据，也不泄露服务商错误", async () => {
	const f = fixture();
	const cookie = await login(f.api);
	f.setOffline();
	for (const response of [
		await f.api(request()),
		await write(f.api, cookie),
	]) {
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), {
			error: "在线存储暂时不可用，请稍后重试",
		});
	}
});

test("Preview 与 Production 的清单和登录状态隔离", async () => {
	const f = fixture();
	const cookie = await login(f.api);
	await write(f.api, cookie);
	const preview = f.makeApi({ VERCEL_ENV: "preview" });
	const data = await (await preview(request("watchlist", { cookie }))).json();
	assert.equal(data.authenticated, false);
	assert.equal(data.watchlist.items.length, 0);
});
