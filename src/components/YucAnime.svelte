<script lang="ts">
	import { onMount } from "svelte";
	import type {
		AnimeWatchlist,
		WatchStatus,
		YucAnime,
		YucCatalog,
	} from "../types/anime";

	export let initialCatalog: YucCatalog;
	export let initialWatchlist: AnimeWatchlist;
	export let currentSeason: string;
	export let localEditor = false;

	let catalog = initialCatalog;
	let watchlist = initialWatchlist;
	let view: "catalog" | "watchlist" = localEditor ? "catalog" : "watchlist";
	let season = initialCatalog.seasons.some(
		(item) => item.season === currentSeason,
	)
		? currentSeason
		: initialCatalog.seasons[0]?.season || "";
	let watchSeason = "all";
	let query = "";
	let statusFilter = "all";
	let busy = false;
	let ready = false;
	let authenticated = false;
	let configured = false;
	let showLogin = false;
	let password = "";
	let loadVersion = 0;
	let lifetime: AbortController;
	$: editable = localEditor || authenticated;
	$: endpoint = localEditor ? "/__anime/watchlist" : "/api/anime";
	let message = "";
	let error = "";
	const statuses: Record<WatchStatus, string> = {
		watching: "在看",
		planned: "想看",
		completed: "看完",
	};
	const seasonLabel = (value: string) =>
		`${value.slice(0, 4)} 年 ${Number(value.slice(4))} 月`;

	$: saved = new Map(watchlist.items.map((item) => [item.id, item]));
	$: selectedCatalog = catalog.seasons.find((item) => item.season === season);
	$: watchSeasons = [...new Set(watchlist.items.map((item) => item.season))]
		.sort()
		.reverse();
	$: sourceItems =
		view === "catalog" ? selectedCatalog?.items || [] : watchlist.items;
	$: results = sourceItems.filter((item) => {
		const words =
			`${item.title} ${item.titleJapanese} ${item.studio} ${item.genres.join(" ")}`.toLowerCase();
		return (
			words.includes(query.trim().toLowerCase()) &&
			(view === "catalog" ||
				watchSeason === "all" ||
				item.season === watchSeason) &&
			(statusFilter === "all" ||
				saved.get(item.id)?.status === statusFilter)
		);
	});

	onMount(() => {
		lifetime = new AbortController();
		void loadList();
		const onFocus = () => {
			if (!busy) void loadList();
		};
		window.addEventListener("focus", onFocus);
		return () => {
			lifetime.abort();
			window.removeEventListener("focus", onFocus);
		};
	});

	async function readResponse(response: Response) {
		if (
			!response.headers.get("content-type")?.includes("application/json")
		) {
			throw new Error("追番服务暂时不可用，请确认网站部署已完成后重试");
		}
		return response.json();
	}

	async function loadList() {
		const version = ++loadVersion;
		try {
			const response = await fetch(endpoint, {
				cache: "no-store",
				credentials: "same-origin",
				signal: lifetime?.signal,
			});
			const data = await readResponse(response);
			if (!response.ok)
				throw new Error(data.error || "清单读取失败，请稍后重试");
			if (version !== loadVersion || lifetime?.signal.aborted) return;
			watchlist = localEditor ? data : data.watchlist;
			if (!localEditor) {
				authenticated = data.authenticated;
				configured = data.configured;
			}
			ready = true;
			error = "";
		} catch (reason) {
			if (version !== loadVersion || lifetime?.signal.aborted) return;
			ready = false;
			error = reason instanceof Error ? reason.message : "清单读取失败";
		}
	}

	async function login() {
		if (busy || !password || !configured) return;
		busy = true;
		++loadVersion;
		error = "";
		message = "";
		try {
			const response = await fetch("/api/anime?action=login", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			const data = await readResponse(response);
			if (!response.ok) throw new Error(data.error || "登录失败");
			watchlist = data.watchlist;
			authenticated = true;
			ready = true;
			showLogin = false;
			message = "已登录，添加和修改会自动保存并公开。";
		} catch (reason) {
			error = reason instanceof Error ? reason.message : "登录失败";
		} finally {
			password = "";
			busy = false;
		}
	}

	async function logout() {
		if (busy) return;
		busy = true;
		++loadVersion;
		error = "";
		try {
			const response = await fetch("/api/anime?action=logout", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			const data = await readResponse(response);
			if (!response.ok) throw new Error(data.error || "退出失败，请重试");
			authenticated = false;
			message = "已退出编辑模式。";
		} catch (reason) {
			error =
				reason instanceof Error ? reason.message : "退出失败，请重试";
		} finally {
			busy = false;
		}
	}

	async function save(
		items: { id: string; status: WatchStatus }[],
		success: string,
	) {
		if (!editable || busy || !ready) return;
		busy = true;
		error = "";
		message = "保存中…";
		++loadVersion;
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ revision: watchlist.updatedAt, items }),
				credentials: "same-origin",
			});
			const data = await readResponse(response);
			if (response.status === 401 && !localEditor) {
				authenticated = false;
				showLogin = true;
			}
			if (response.status === 409) await loadList();
			if (!response.ok)
				throw new Error(
					response.status === 409
						? "清单有更新，已尝试重新读取，请确认后再操作。"
						: data.error || "保存失败，请重试",
				);
			watchlist = data;
			message = success;
		} catch (reason) {
			error =
				reason instanceof Error ? reason.message : "保存失败，请重试";
			message = "";
		} finally {
			busy = false;
		}
	}

	function add(item: YucAnime) {
		if (saved.has(item.id)) return;
		void save(
			[
				...watchlist.items.map(({ id, status }) => ({ id, status })),
				{ id: item.id, status: "watching" },
			],
			`已添加《${item.title}》${localEditor ? "，部署后公开" : "，已在线保存"}`,
		);
	}
	function remove(item: YucAnime) {
		void save(
			watchlist.items
				.filter((entry) => entry.id !== item.id)
				.map(({ id, status }) => ({ id, status })),
			`已移除《${item.title}》`,
		);
	}
	function changeStatus(id: string, status: WatchStatus) {
		void save(
			watchlist.items.map((item) => ({
				id: item.id,
				status: item.id === id ? status : item.status,
			})),
			localEditor ? "追番状态已保存，部署后公开" : "追番状态已在线保存",
		);
	}
	async function sync() {
		if (busy || !localEditor) return;
		busy = true;
		error = "";
		message = "正在同步当季与下一季新番…";
		try {
			const response = await fetch("/__anime/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || "同步失败");
			catalog = data.catalog;
			message = data.warnings.length
				? "部分季度未能更新，已保留可用数据。"
				: "新番数据已更新";
		} catch (reason) {
			error =
				reason instanceof Error ? reason.message : "同步失败，请重试";
			message = "";
		} finally {
			busy = false;
		}
	}
</script>

<section class="yuc-page card-base" aria-label="季度追番">
	<header>
		<p class="eyebrow">ANIME COLLECTION</p>
		<h1>追番清单</h1>
		<p class="intro">从每一季的新故事里，留下想追的那些。</p>
	</header>
	{#if editable}
		<div class="editor-note">
			<span
				>{localEditor
					? "本地编辑 · 自动保存到文件，部署后公开。"
					: "站长编辑 · 修改自动保存，所有访客可见。"}</span
			>
			{#if localEditor}
				<button
					class="soft-button"
					onclick={sync}
					disabled={busy || !ready}
					>{busy ? "处理中…" : "同步新番"}</button
				>
			{:else}
				<button class="soft-button" onclick={logout} disabled={busy}
					>退出登录</button
				>
			{/if}
		</div>
	{:else}
		<div class="admin-entry">
			<span>站长的公开追番清单</span>
			<button
				class="soft-button"
				aria-expanded={showLogin}
				onclick={() => {
					showLogin = !showLogin;
					password = "";
				}}
				disabled={busy}>站长登录</button
			>
		</div>
	{/if}
	{#if showLogin && !editable}
		{#if ready && configured}
			<form
				class="login-form"
				onsubmit={(event) => {
					event.preventDefault();
					void login();
				}}
			>
				<label for="anime-admin-password">管理密码</label>
				<div class="login-fields">
					<input
						id="anime-admin-password"
						name="password"
						type="password"
						autocomplete="current-password"
						bind:value={password}
						required
						maxlength="1024"
						disabled={busy}
					/>
					<button
						class="soft-button"
						type="submit"
						disabled={busy || !password}
						>{busy ? "登录中…" : "登录"}</button
					>
				</div>
			</form>
		{:else if ready}
			<p class="feedback">
				在线编辑尚未配置。请站长在 Vercel 连接 Redis，并设置至少 16 位的
				ANIME_ADMIN_PASSWORD 后重新部署。
			</p>
		{:else}
			<p class="feedback">
				正在确认在线服务状态，请稍候；读取失败时可点击下方重试。
			</p>
		{/if}
	{/if}
	<div class="tabs" aria-label="番单范围">
		<button
			class:active={view === "watchlist"}
			aria-pressed={view === "watchlist"}
			onclick={() => {
				view = "watchlist";
				statusFilter = "all";
			}}>我的追番 <span>{watchlist.items.length}</span></button
		>
		<button
			class:active={view === "catalog"}
			aria-pressed={view === "catalog"}
			onclick={() => {
				view = "catalog";
				statusFilter = "all";
			}}>季度新番</button
		>
	</div>
	<div class="filters">
		<label
			>季度
			{#if view === "catalog"}
				<select bind:value={season} aria-label="新番季度">
					{#each catalog.seasons as entry}<option value={entry.season}
							>{seasonLabel(entry.season)}{entry.season ===
							currentSeason
								? " · 当季"
								: ""}</option
						>{/each}
				</select>
			{:else}
				<select bind:value={watchSeason} aria-label="追番季度"
					><option value="all">全部季度</option>
					{#each watchSeasons as value}<option {value}
							>{seasonLabel(value)}</option
						>{/each}
				</select>
			{/if}
		</label>
		<label
			>状态<select bind:value={statusFilter} aria-label="追番状态"
				><option value="all">全部状态</option>
				{#each Object.entries(statuses) as [value, label]}<option
						{value}>{label}</option
					>{/each}
			</select></label
		>
		<label class="search"
			>搜索<input
				type="search"
				bind:value={query}
				placeholder="番名、制作公司、题材"
				aria-label="搜索番剧"
			/></label
		>
	</div>
	<div class="list-meta">
		<span>共 {results.length} 部</span>
		{#if view === "catalog" && selectedCatalog}
			<a
				href={selectedCatalog.sourceUrl}
				target="_blank"
				rel="noopener noreferrer"
				>yuc.wiki · {selectedCatalog.fetchedAt.slice(0, 10)} 更新 ↗</a
			>
		{/if}
	</div>
	{#if editable || error || message || !ready}<p
			class="feedback"
			class:error
			role="status"
			aria-live="polite"
		>
			{error ||
				message ||
				(!ready
					? "正在读取追番清单…"
					: "选择新番，建立你的公开追番清单。")}
			{#if error}<button
					class="soft-button"
					onclick={() => {
						message = "";
						void loadList();
					}}
					disabled={busy}>重新读取</button
				>{/if}
		</p>{/if}
	{#if results.length}
		<div class="anime-catalog">
			{#each results as item (item.id)}
				<article class="anime-entry" data-anime-id={item.id}>
					<div class="cover">
						<span class="cover-placeholder">{item.title}</span>
						{#if item.cover}<img
								src={item.cover}
								alt={item.title}
								loading="lazy"
								referrerpolicy="no-referrer"
								onerror={(event) => {
									event.currentTarget.style.display = "none";
								}}
							/>{/if}
						{#if saved.has(item.id)}<span class="status-badge"
								>{statuses[saved.get(item.id)!.status]}</span
							>{/if}
					</div>
					<div class="entry-body">
						<p class="season-caption">{seasonLabel(item.season)}</p>
						<h2>{item.title}</h2>
						<p class="japanese" title={item.titleJapanese}>
							{item.titleJapanese}
						</p>
						<p class="detail">
							{item.broadcast || "播出时间待公布"}
						</p>
						<p class="detail">{item.studio || "制作公司待公布"}</p>
						<div class="genres">
							{#each item.genres as genre}<span>{genre}</span
								>{/each}
						</div>
						<div class="entry-links">
							<a
								href={item.sourceUrl}
								target="_blank"
								rel="noopener noreferrer">新番资料 ↗</a
							>
							{#if item.website}<a
									href={item.website}
									target="_blank"
									rel="noopener noreferrer">官网 ↗</a
								>{/if}
						</div>
						{#if editable}
							{#if saved.has(item.id)}
								<div class="entry-actions">
									<select
										aria-label={`${item.title}的追番状态`}
										value={saved.get(item.id)!.status}
										disabled={busy || !ready}
										onchange={(event) => {
											const nextStatus = event
												.currentTarget
												.value as WatchStatus;
											event.currentTarget.value =
												saved.get(item.id)!.status;
											changeStatus(item.id, nextStatus);
										}}
									>
										{#each Object.entries(statuses) as [value, label]}<option
												{value}>{label}</option
											>{/each}
									</select>
									<button
										class="remove-button"
										aria-label={`移除追番：${item.title}`}
										disabled={busy || !ready}
										onclick={() => remove(item)}
										>移除</button
									>
								</div>
							{:else}<button
									class="add-button"
									aria-label={`添加追番：${item.title}`}
									disabled={busy || !ready}
									onclick={() => add(item)}
									>＋ 添加追番</button
								>{/if}
						{/if}
					</div>
				</article>
			{/each}
		</div>
	{:else}
		<div class="empty">
			<h2>
				{view === "watchlist" && !watchlist.items.length
					? "追番清单还没有收录作品"
					: "没有找到符合条件的番剧"}
			</h2>
			<p>
				{view === "watchlist" && !watchlist.items.length
					? editable
						? "切换到季度新番，点击「添加追番」开始选择。"
						: "先逛逛季度新番，看看这一季有哪些故事。"
					: "试试其他季度、状态或关键词。"}
			</p>
			{#if view === "watchlist" && !watchlist.items.length}<button
					class="soft-button"
					onclick={() => {
						view = "catalog";
						query = "";
						statusFilter = "all";
					}}>浏览季度新番</button
				>{/if}
		</div>
	{/if}
	<footer>
		新番资料整理自 <a
			href="https://yuc.wiki/"
			target="_blank"
			rel="noopener noreferrer">長門有C · yuc.wiki</a
		>，遵循原站 BY-NC-SA 许可。追番清单由站长选择。
	</footer>
</section>

<style>
	.yuc-page {
		width: 100%;
		min-width: 0;
		padding: 2rem;
		color: var(--text-90);
	}
	header {
		margin-bottom: 1.6rem;
	}
	.eyebrow {
		font-size: 0.7rem;
		letter-spacing: 0.18em;
		color: var(--primary);
		font-weight: 700;
		margin-bottom: 0.5rem;
	}
	h1 {
		font-size: 1.9rem;
		font-weight: 800;
		color: var(--text-90);
	}
	.intro {
		color: var(--text-60);
		margin-top: 0.4rem;
	}
	.editor-note {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.8rem 1rem;
		background: var(--btn-regular-bg);
		border-radius: 0.8rem;
		font-size: 0.85rem;
		margin-bottom: 1.4rem;
	}
	.admin-entry {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
		color: var(--text-60);
		font-size: 0.85rem;
	}
	.login-form {
		padding: 1rem;
		margin-bottom: 1.4rem;
		border-radius: 0.8rem;
		background: var(--btn-regular-bg);
	}
	.login-fields {
		display: flex;
		flex-wrap: wrap;
		gap: 0.7rem;
		margin-top: 0.5rem;
	}
	.login-fields input {
		flex: 1;
		min-width: 0;
		padding: 0.6rem 0.8rem;
		border-radius: 0.5rem;
		background: var(--card-bg);
		color: var(--text-90);
	}
	button,
	select,
	input {
		font: inherit;
	}
	button,
	select {
		cursor: pointer;
	}
	button:disabled,
	select:disabled {
		opacity: 0.5;
		cursor: wait;
	}
	button:focus-visible,
	select:focus-visible,
	input:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 3px;
	}
	.tabs {
		display: flex;
		gap: 0.7rem;
		margin-bottom: 1.4rem;
	}
	.tabs button {
		padding: 0.65rem 1rem;
		border-radius: 0.7rem;
		color: var(--text-60);
		font-weight: 600;
		background: var(--btn-plain-bg-hover);
	}
	.tabs button.active {
		background: var(--btn-regular-bg);
		color: var(--primary);
	}
	.tabs span {
		margin-left: 0.35rem;
		font-size: 0.8rem;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.8rem;
	}
	.filters label {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: 0.75rem;
		color: var(--text-60);
	}
	select,
	input {
		border: 1px solid var(--line-divider);
		background: var(--card-bg);
		color: var(--text-90);
		border-radius: 0.6rem;
		padding: 0.65rem 0.75rem;
		font-size: 0.85rem;
		min-width: 0;
	}
	.search {
		flex: 1;
		min-width: 150px;
	}
	.list-meta {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-60);
		margin: 1.2rem 0;
	}
	a {
		color: var(--primary);
	}
	a:hover {
		text-decoration: underline;
	}
	.feedback {
		margin: -0.3rem 0 1rem;
		font-size: 0.8rem;
		color: var(--text-60);
	}
	.feedback.error {
		color: #c54141;
	}
	.anime-catalog {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
		gap: 1.2rem;
	}
	.anime-entry {
		border: 1px solid var(--line-divider);
		border-radius: 0.9rem;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		background: var(--card-bg);
	}
	.cover {
		position: relative;
		aspect-ratio: 2 / 3;
		overflow: hidden;
		background: var(--btn-regular-bg);
		display: grid;
		place-items: center;
	}
	.cover-placeholder {
		padding: 1.5rem;
		color: var(--primary);
		text-align: center;
		font-weight: 700;
	}
	.cover img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.status-badge {
		position: absolute;
		top: 0.7rem;
		left: 0.7rem;
		padding: 0.3rem 0.7rem;
		border-radius: 1rem;
		background: var(--card-bg);
		color: var(--primary);
		font-size: 0.75rem;
		font-weight: 700;
	}
	.entry-body {
		padding: 1rem;
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.season-caption {
		font-size: 0.65rem;
		color: var(--text-50);
		margin-bottom: 0.3rem;
	}
	h2 {
		font-size: 1rem;
		font-weight: 700;
		line-height: 1.5;
	}
	.japanese {
		font-size: 0.7rem;
		color: var(--text-50);
		margin: 0.35rem 0 0.7rem;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.detail {
		font-size: 0.75rem;
		color: var(--text-60);
		line-height: 1.7;
		overflow-wrap: anywhere;
	}
	.genres {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.7rem 0;
	}
	.genres span {
		padding: 0.18rem 0.4rem;
		background: var(--btn-plain-bg-hover);
		border-radius: 0.3rem;
		font-size: 0.65rem;
		color: var(--text-60);
	}
	.entry-links {
		display: flex;
		gap: 0.8rem;
		font-size: 0.75rem;
		margin-top: auto;
		padding-top: 0.3rem;
	}
	.add-button,
	.soft-button {
		border-radius: 0.6rem;
		background: var(--btn-regular-bg);
		color: var(--primary);
		padding: 0.65rem 0.8rem;
		font-weight: 600;
	}
	.soft-button {
		white-space: nowrap;
	}
	.add-button {
		margin-top: 1rem;
		width: 100%;
	}
	.entry-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.entry-actions select {
		flex: 1;
	}
	.remove-button {
		color: var(--text-60);
		padding: 0.5rem;
		font-size: 0.8rem;
	}
	.remove-button:hover {
		color: #c54141;
	}
	.empty {
		text-align: center;
		padding: 3.5rem 0.5rem;
	}
	.empty p {
		color: var(--text-60);
		margin: 0.7rem 0 1.2rem;
		font-size: 0.85rem;
	}
	footer {
		font-size: 0.7rem;
		color: var(--text-50);
		line-height: 1.8;
		margin-top: 2rem;
	}
	@media (max-width: 600px) {
		.yuc-page {
			padding: 1.25rem;
		}
		.editor-note {
			align-items: flex-start;
			flex-direction: column;
			gap: 0.6rem;
		}
		.anime-catalog {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.7rem;
		}
		.entry-body {
			padding: 0.7rem;
		}
		.entry-actions {
			flex-wrap: wrap;
		}
		.entry-actions select {
			width: 100%;
		}
		h2 {
			font-size: 0.9rem;
		}
		.filters label {
			flex: 1;
		}
		.filters .search {
			flex-basis: 100%;
		}
	}
	@media (prefers-reduced-motion: no-preference) {
		.anime-entry {
			transition: box-shadow 0.2s;
		}
		.anime-entry:hover {
			box-shadow: 0 5px 18px #0000000d;
		}
	}
</style>
