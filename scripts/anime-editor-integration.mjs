import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { updateYuc, catalogPath } from "./update-yuc.mjs";
import { updateWatchlist } from "./lib/anime-watchlist.mjs";

const watchlistPath = fileURLToPath(
	new URL("../src/data/anime-watchlist.json", import.meta.url),
);
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

function createEditorMiddleware() {
	let queue = Promise.resolve();
	return async (req, res, next) => {
		const route = req.url?.split("?")[0];
		if (!["/__anime/watchlist", "/__anime/sync"].includes(route))
			return next();
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		const send = (status, data) => {
			res.statusCode = status;
			res.end(JSON.stringify(data));
		};
		const host = req.headers.host || "";
		if (
			!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) ||
			!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
				req.socket.remoteAddress,
			)
		) {
			return send(403, { error: "仅可在本机预览中编辑追番" });
		}
		if (req.method === "GET" && route === "/__anime/watchlist") {
			try {
				return send(200, await readJson(watchlistPath));
			} catch {
				return send(500, { error: "追番清单读取失败" });
			}
		}
		if (req.method !== "POST")
			return send(405, { error: "不支持的请求方法" });
		if (
			![`http://${host}`, `https://${host}`].includes(
				req.headers.origin,
			) ||
			!req.headers["content-type"]?.startsWith("application/json")
		) {
			return send(403, { error: "仅接受本站编辑页面的请求" });
		}
		try {
			let body = "";
			for await (const chunk of req) {
				body += chunk;
				if (Buffer.byteLength(body) > 65536)
					throw Object.assign(new Error("请求过大"), { status: 413 });
			}
			let request;
			try {
				request = JSON.parse(body);
			} catch {
				return send(400, { error: "请求格式无效" });
			}
			const task = queue.then(async () => {
				if (route === "/__anime/sync") return updateYuc();
				const updated = updateWatchlist(
					await readJson(watchlistPath),
					await readJson(catalogPath),
					request,
				);
				await fs.writeFile(
					`${watchlistPath}.tmp`,
					`${JSON.stringify(updated, null, 2)}\n`,
				);
				await fs.rename(`${watchlistPath}.tmp`, watchlistPath);
				return updated;
			});
			queue = task.catch(() => {});
			send(200, await task);
		} catch (error) {
			send(error.status || 500, { error: error.message });
		}
	};
}

// 只挂载到本机 Astro 开发服务器；构建、预览和线上静态站点不包含写入接口。
export function animeEditor() {
	return {
		name: "mizuki-anime-editor",
		hooks: {
			"astro:config:setup": ({ command, updateConfig }) => {
				if (command !== "dev") return;
				updateConfig({
					vite: {
						plugins: [
							{
								name: "mizuki-anime-editor-api",
								configureServer(server) {
									server.middlewares.use(
										createEditorMiddleware(),
									);
								},
							},
						],
					},
				});
			},
		},
	};
}
