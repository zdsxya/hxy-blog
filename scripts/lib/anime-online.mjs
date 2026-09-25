import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { updateWatchlist } from "./anime-watchlist.mjs";

const COOKIE = "anime_admin";
const SESSION_SECONDS = 8 * 60 * 60;
const BODY_LIMIT = 128 * 1024;
const CAS = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;
const LIMIT_LOGIN = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 900) end
return count`;

const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash("sha256").update(value).digest();

// The REST credentials and the administrator password are used only on the server.
export function createAnimeApi({
	env,
	catalog,
	initialWatchlist,
	fetchImpl = fetch,
}) {
	const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
	const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
	const password = env.ANIME_ADMIN_PASSWORD || "";
	const storageConfigured = Boolean(redisUrl && redisToken);
	const configured = storageConfigured && password.length >= 16;
	// Preview deployments must not accidentally change the production list.
	const prefix =
		env.ANIME_REDIS_PREFIX ||
		`mizuki:anime:${env.VERCEL_ENV || "development"}`;
	const listKey = `${prefix}:watchlist`;

	async function redis(...command) {
		try {
			const response = await fetchImpl(redisUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${redisToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(command),
				signal: AbortSignal.timeout(8000),
			});
			if (!response.ok) throw new Error("Redis unavailable");
			const data = await response.json();
			if (data.error || !("result" in data))
				throw new Error("Redis command failed");
			return data.result;
		} catch {
			// Never return provider errors that might contain connection details.
			throw fail(503, "在线存储暂时不可用，请稍后重试");
		}
	}

	function sessionKey(token) {
		return `${prefix}:session:${createHmac("sha256", password).update(token).digest("hex")}`;
	}
	function tokenFrom(request) {
		const token = request.headers
			.get("cookie")
			?.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${COOKIE}=`))
			?.slice(COOKIE.length + 1);
		return /^[a-f0-9]{64}$/.test(token || "") ? token : null;
	}
	function cookie(request, token = "", age = 0) {
		const secure =
			new URL(request.url).protocol === "https:" ? "; Secure" : "";
		return `${COOKIE}=${token}; Path=/api/anime; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
	}
	async function authenticated(request) {
		const token = tokenFrom(request);
		return Boolean(
			configured &&
			token &&
			(await redis("GET", sessionKey(token))) === "1",
		);
	}
	async function readList() {
		const raw = await redis("GET", listKey);
		return {
			raw,
			watchlist: raw === null ? initialWatchlist : JSON.parse(raw),
		};
	}
	async function body(request) {
		if (
			!request.headers.get("content-type")?.startsWith("application/json")
		) {
			throw fail(415, "仅接受 JSON 请求");
		}
		const reader = request.body?.getReader();
		const chunks = [];
		let size = 0;
		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > BODY_LIMIT) {
						await reader.cancel();
						throw fail(413, "请求过大");
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw fail(400, "请求格式无效");
		}
	}
	function json(data, status = 200, headers = {}) {
		return Response.json(data, {
			status,
			headers: {
				"Cache-Control": "private, no-store",
				"CDN-Cache-Control": "no-store",
				"Vercel-CDN-Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				...headers,
			},
		});
	}

	return async function handle(request) {
		try {
			const url = new URL(request.url);
			const action = url.searchParams.get("action") || "watchlist";
			if (!["watchlist", "login", "logout"].includes(action)) {
				return json({ error: "接口不存在" }, 404);
			}
			if (request.method === "GET" && action === "watchlist") {
				const watchlist = storageConfigured
					? (await readList()).watchlist
					: initialWatchlist;
				return json({
					watchlist,
					configured,
					authenticated: await authenticated(request),
				});
			}
			if (request.method !== "POST") {
				return json({ error: "不支持的请求方法" }, 405, {
					Allow: action === "watchlist" ? "GET, POST" : "POST",
				});
			}
			if (request.headers.get("origin") !== url.origin) {
				return json({ error: "仅接受本站页面的请求" }, 403);
			}
			if (!configured) {
				return json(
					{
						error: "在线编辑尚未配置，请在 Vercel 连接 Redis 并设置至少 16 位的管理密码",
					},
					503,
				);
			}
			if (action === "logout") {
				const token = tokenFrom(request);
				if (token) await redis("DEL", sessionKey(token));
				return json({ authenticated: false }, 200, {
					"Set-Cookie": cookie(request),
				});
			}
			if (action === "login") {
				// Vercel sets x-forwarded-for. Store its hash, not the visitor's IP.
				const ip =
					request.headers
						.get("x-forwarded-for")
						?.split(",")[0]
						?.trim() || "unknown";
				const rateKey = `${prefix}:login:${digest(ip).toString("hex")}`;
				if ((await redis("EVAL", LIMIT_LOGIN, 1, rateKey)) > 5) {
					return json(
						{ error: "尝试次数过多，请 15 分钟后重试" },
						429,
						{ "Retry-After": "900" },
					);
				}
				const input = await body(request);
				if (
					typeof input?.password !== "string" ||
					!timingSafeEqual(digest(input.password), digest(password))
				) {
					return json({ error: "管理密码不正确" }, 401);
				}
				// Read storage before issuing a session so the UI starts with the latest revision.
				const { watchlist } = await readList();
				const token = randomBytes(32).toString("hex");
				await redis(
					"SET",
					sessionKey(token),
					"1",
					"EX",
					SESSION_SECONDS,
				);
				const oldToken = tokenFrom(request);
				if (oldToken) await redis("DEL", sessionKey(oldToken));
				await redis("DEL", rateKey);
				return json({ watchlist, authenticated: true }, 200, {
					"Set-Cookie": cookie(request, token, SESSION_SECONDS),
				});
			}
			if (!(await authenticated(request))) {
				return json({ error: "登录已失效，请重新登录" }, 401, {
					"Set-Cookie": cookie(request),
				});
			}
			const input = await body(request);
			const { raw, watchlist } = await readList();
			const updated = updateWatchlist(watchlist, catalog, input);
			// Revision validation alone cannot protect concurrent serverless instances.
			// Atomically compare and replace the exact Redis value, including first save.
			const changed = await redis(
				"EVAL",
				CAS,
				1,
				listKey,
				raw ?? "",
				JSON.stringify(updated),
			);
			if (changed !== 1)
				throw fail(409, "清单已在其他页面更新，请刷新后再试");
			return json(updated);
		} catch (error) {
			const status = [400, 409, 413, 415, 503].includes(error.status)
				? error.status
				: 500;
			return json(
				{
					error:
						status === 500
							? "追番服务暂时不可用，请稍后重试"
							: error.message,
				},
				status,
			);
		}
	};
}
