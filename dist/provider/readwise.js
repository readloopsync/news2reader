import fs from "node:fs";
import path from "node:path";
import got from "got";
import { OPDSFeed } from "../opds.js";
import { htmlToEpub } from "../epub.js";
export default class ReadwiseProvider {
    constructor(app, configDir) {
        var _a, _b, _c, _d;
        this.BASE_URL = (_a = process.env.READWISE_BASE_URL) !== null && _a !== void 0 ? _a : "https://readwise.io";
        this.TOKEN = (_b = process.env.READWISE_TOKEN) !== null && _b !== void 0 ? _b : null;
        // Bound how many list pages we page through per feed request, to respect the
        // 20 req/min rate limit (100 docs/page => up to 300 docs shown).
        this.MAX_PAGES = Number((_c = process.env.READWISE_MAX_PAGES) !== null && _c !== void 0 ? _c : 3);
        // Short in-memory cache of list responses per location, to avoid hammering
        // the API when a reader re-opens a feed.
        this.LIST_TTL_MS = Number((_d = process.env.READWISE_LIST_TTL_MS) !== null && _d !== void 0 ? _d : 60000);
        this.listCache = new Map();
        this.FEEDS = [
            { name: "Inbox (New)", id: "new", description: "Unread items in your Readwise Reader inbox" },
            { name: "Later", id: "later", description: "Items saved for later" },
            { name: "Shortlist", id: "shortlist", description: "Your shortlisted items" },
            { name: "Feed", id: "feed", description: "Items from your Reader feeds" },
            { name: "Archive", id: "archive", description: "Archived items" },
        ];
        this.cacheDir = path.join(configDir, "readwise-epub-cache");
        fs.mkdirSync(this.cacheDir, { recursive: true });
        this.registerRoutes(app);
    }
    isConnected() {
        return typeof this.TOKEN === "string" && this.TOKEN.length > 0;
    }
    authHeaders() {
        return {
            Accept: "application/json",
            Authorization: `Token ${this.TOKEN}`,
        };
    }
    registerRoutes(app) {
        // Navigation feed: list the per-location sub-feeds
        app.get("/opds/provider/readwise", (req, res) => {
            const feed = new OPDSFeed({
                id: "readwise",
                links: {
                    self: "/opds/provider/readwise",
                    start: "/opds",
                    up: "/opds",
                },
                title: "Readwise Reader",
            });
            feed.addEntries(this.FEEDS.map((entry) => ({
                title: entry.name,
                id: `readwise-${entry.id}`,
                link: `/opds/provider/readwise/${entry.id}`,
                content: entry.description,
            })));
            res.type("application/xml").send(feed.toXmlString());
        });
        // Acquisition feeds (one per location)
        for (const entry of this.FEEDS) {
            app.get(`/opds/provider/readwise/${entry.id}`, async (req, res) => {
                var _a;
                if (!this.isConnected()) {
                    res.status(401).send("Readwise is not configured. Set READWISE_TOKEN.");
                    return;
                }
                const feed = new OPDSFeed({
                    id: `readwise-${entry.id}`,
                    links: {
                        self: `/opds/provider/readwise/${entry.id}`,
                        start: "/opds",
                        up: "/opds/provider/readwise",
                    },
                    title: `Readwise — ${entry.name}`,
                });
                try {
                    const docs = await this.getDocuments(entry.id);
                    for (const doc of docs) {
                        const title = ((_a = doc.title) === null || _a === void 0 ? void 0 : _a.trim()) || doc.url || "Untitled";
                        feed.addAcquisitionEntry({
                            id: `readwise:${doc.id}`,
                            title,
                            href: `/opds/provider/readwise/content.epub?id=${encodeURIComponent(doc.id)}`,
                            author: doc.author || doc.site_name || undefined,
                            summary: doc.summary || undefined,
                            updated: doc.updated_at || undefined,
                        });
                    }
                }
                catch (e) {
                    console.error("Readwise: failed to list documents", e);
                    res.status(502).send("Failed to fetch documents from Readwise");
                    return;
                }
                res.type("application/xml").send(feed.toXmlString());
            });
        }
        // On-demand EPUB for a single document, built from its html_content
        app.get("/opds/provider/readwise/content.epub", async (req, res) => {
            if (!this.isConnected()) {
                res.status(401).send("Readwise is not configured. Set READWISE_TOKEN.");
                return;
            }
            const id = req.query.id;
            if (typeof id !== "string" || id.length === 0) {
                res.status(400).send("Missing document id");
                return;
            }
            try {
                const epubPath = await this.documentToEpub(id);
                res.type("application/epub+zip").sendFile(epubPath);
            }
            catch (e) {
                console.error(`Readwise: failed to build EPUB for ${id}`, e);
                res.status(404).send("Could not retrieve this document");
            }
        });
    }
    /**
     * Fetch documents for a location, paging up to MAX_PAGES, with a short cache.
     * Metadata only (no html_content) — content is fetched lazily at download.
     */
    async getDocuments(location) {
        var _a, _b, _c, _d;
        const cached = this.listCache.get(location);
        if (cached && Date.now() - cached.fetchedAt < this.LIST_TTL_MS) {
            return cached.docs;
        }
        const docs = [];
        let pageCursor;
        for (let page = 0; page < this.MAX_PAGES; page++) {
            const searchParams = {
                location,
                withHtmlContent: "false",
            };
            if (pageCursor)
                searchParams.pageCursor = pageCursor;
            const data = (await got
                .get(`${this.BASE_URL}/api/v3/list/`, {
                headers: this.authHeaders(),
                searchParams,
            })
                .json());
            if (process.env.VERBOSE) {
                console.log(`Readwise list [${location}] page ${page}: ${(_b = (_a = data.results) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0} docs`);
            }
            docs.push(...((_c = data.results) !== null && _c !== void 0 ? _c : []));
            pageCursor = (_d = data.nextPageCursor) !== null && _d !== void 0 ? _d : undefined;
            if (!pageCursor)
                break;
        }
        this.listCache.set(location, { fetchedAt: Date.now(), docs });
        return docs;
    }
    /** Fetch a single document with html_content and build (or reuse) its EPUB. */
    async documentToEpub(id) {
        var _a, _b, _c, _d;
        const outputPath = path.join(this.cacheDir, `readwise-${sanitizeId(id)}.epub`);
        if (fs.existsSync(outputPath)) {
            return outputPath;
        }
        const data = (await got
            .get(`${this.BASE_URL}/api/v3/list/`, {
            headers: this.authHeaders(),
            searchParams: { id, withHtmlContent: "true" },
        })
            .json());
        const doc = (_a = data.results) === null || _a === void 0 ? void 0 : _a[0];
        if (!doc) {
            throw new Error(`Document ${id} not found`);
        }
        let html = doc.html_content && doc.html_content.trim().length > 0
            ? doc.html_content
            : `<h1>${escapeHtml((_b = doc.title) !== null && _b !== void 0 ? _b : "Untitled")}</h1>` +
                (doc.summary ? `<p>${escapeHtml(doc.summary)}</p>` : "") +
                (doc.url ? `<p><a href="${escapeHtml(doc.url)}">${escapeHtml(doc.url)}</a></p>` : "");
        // Image handling. Some e-ink EPUB engines (incl. Crosspoint) can't decode
        // webp, which epub-gen embeds as-is; that can make the whole book fail to
        // open. `strip` removes images entirely for maximum compatibility.
        //   READWISE_IMAGES = keep (default) | strip
        const imageMode = (_c = process.env.READWISE_IMAGES) !== null && _c !== void 0 ? _c : "keep";
        if (imageMode === "strip") {
            html = html
                .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, "")
                .replace(/<img\b[^>]*>/gi, "")
                .replace(/<source\b[^>]*>/gi, "");
        }
        return htmlToEpub({
            html,
            title: ((_d = doc.title) === null || _d === void 0 ? void 0 : _d.trim()) || doc.url || "Untitled",
            author: doc.author || doc.site_name || null,
            publisher: doc.site_name || (doc.url ? hostOf(doc.url) : null),
            outputPath,
        });
    }
}
function sanitizeId(id) {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function hostOf(url) {
    try {
        return new URL(url).hostname;
    }
    catch (_a) {
        return null;
    }
}
function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
