export interface YucAnime {
	id: string;
	season: string;
	title: string;
	titleJapanese: string;
	cover: string;
	studio: string;
	genres: string[];
	broadcast: string;
	website: string;
	sourceUrl: string;
}

export interface YucCatalog {
	version: number;
	seasons: {
		season: string;
		sourceUrl: string;
		fetchedAt: string;
		items: YucAnime[];
	}[];
}

export type WatchStatus = "planned" | "watching" | "completed";
export interface AnimeWatchlist {
	version: number;
	updatedAt: string | null;
	items: (YucAnime & { status: WatchStatus; addedAt: string })[];
}
