export function updateWatchlist(current, catalog, request) {
	if (!request || request.revision !== current.updatedAt) {
		throw Object.assign(new Error("清单已在其他页面更新，请刷新后再试"), {
			status: 409,
		});
	}
	if (!Array.isArray(request.items) || request.items.length > 1000) {
		throw Object.assign(new Error("追番清单格式无效"), { status: 400 });
	}
	const known = new Map(current.items.map((item) => [item.id, item]));
	for (const season of catalog.seasons)
		for (const item of season.items) known.set(item.id, item);
	const seen = new Set();
	const now = new Date(
		Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1),
	).toISOString();
	const items = request.items.map((item) => {
		if (
			!item ||
			!known.has(item.id) ||
			seen.has(item.id) ||
			!["planned", "watching", "completed"].includes(item.status)
		) {
			throw Object.assign(new Error("番剧不存在、重复或状态无效"), {
				status: 400,
			});
		}
		seen.add(item.id);
		return {
			...known.get(item.id),
			status: item.status,
			addedAt:
				current.items.find((old) => old.id === item.id)?.addedAt || now,
		};
	});
	return { version: 1, updatedAt: now, items };
}
