import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import got from "got";
import { OPDSFeed } from "../opds.js";
import { htmlToEpub } from "../epub.js";
const IMG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
export default class ReadwiseProvider {
    constructor(app, configDir) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        this.BASE_URL = (_a = process.env.READWISE_BASE_URL) !== null && _a !== void 0 ? _a : "https://readwise.io";
        this.TOKEN = (_b = process.env.READWISE_TOKEN) !== null && _b !== void 0 ? _b : null;
        this.PORT = String((_c = process.env.PORT) !== null && _c !== void 0 ? _c : "8080");
        // Optional category allow-list (e.g. "article,email,rss,pdf,epub"). Reader
        // categories include video/tweet/podcast which make poor EPUBs on e-ink;
        // set this to keep feeds to readable types. Empty = all categories.
        this.CATEGORIES = ((_d = process.env.READWISE_CATEGORIES) !== null && _d !== void 0 ? _d : "")
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        this.MAX_PAGES = Number((_e = process.env.READWISE_MAX_PAGES) !== null && _e !== void 0 ? _e : 3);
        // Max entries per feed. Big feeds (100+ entries) can exceed the RAM of a
        // constrained reader (e.g. Crosspoint on an ESP32-C3) parsing the OPDS XML,
        // especially over TLS — capping keeps feeds small and reliable.
        this.FEED_LIMIT = Number((_f = process.env.READWISE_FEED_LIMIT) !== null && _f !== void 0 ? _f : 40);
        this.LIST_TTL_MS = Number((_g = process.env.READWISE_LIST_TTL_MS) !== null && _g !== void 0 ? _g : 60000);
        this.listCache = new Map();
        // id -> download filename (with the [rw-<id>] stamp), populated when listing
        // or building so the content route can set a meaningful Content-Disposition.
        this.downloadNames = new Map();
        // Image transcoding
        this.IMG_MAX_WIDTH = Number((_h = process.env.READWISE_IMG_MAX_WIDTH) !== null && _h !== void 0 ? _h : 1000);
        this.IMG_QUALITY = Number((_j = process.env.READWISE_IMG_QUALITY) !== null && _j !== void 0 ? _j : 80);
        // e-ink displays are grayscale; pre-converting (with contrast normalization)
        // renders cleaner than letting the device reduce a color image itself.
        this.IMG_GRAYSCALE = ((_k = process.env.READWISE_IMG_GRAYSCALE) !== null && _k !== void 0 ? _k : "1") !== "0";
        this.placeholderJpeg = null;
        this.sharpModule = null;
        // Per-process secret guarding the internal image route (which is exempt from
        // Basic auth because epub-gen fetches it server-side). Prevents the route
        // being abused as an open image proxy when the server is exposed publicly.
        this.imgSecret = randomBytes(16).toString("hex");
        // Number of live EPUB downloads in flight; background warming yields to these.
        this.liveDownloads = 0;
        // Background cache warming (so cold-build latency never hits a reader's
        // download timeout): pre-build the top N docs of a feed when it's opened.
        this.WARM_COUNT = Number((_l = process.env.READWISE_WARM_COUNT) !== null && _l !== void 0 ? _l : 8);
        this.WARM_INTERVAL_MS = Number((_m = process.env.READWISE_WARM_INTERVAL_MS) !== null && _m !== void 0 ? _m : 4000);
        this.warmQueue = [];
        this.warmSet = new Set();
        this.warming = false;
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
    imageMode() {
        var _a;
        const m = ((_a = process.env.READWISE_IMAGES) !== null && _a !== void 0 ? _a : "keep").toLowerCase();
        return m === "strip" || m === "transcode" ? m : "keep";
    }
    authHeaders() {
        return { Accept: "application/json", Authorization: `Token ${this.TOKEN}` };
    }
    cachePathFor(id) {
        return path.join(this.cacheDir, `readwise-${sanitizeId(id)}.epub`);
    }
    /**
     * Render the Readwise navigation feed (the per-location sub-feeds). Exposed so
     * the catalog root can serve it directly when Readwise is the only provider.
     */
    renderNavFeed(selfHref = "/opds/provider/readwise") {
        const feed = new OPDSFeed({
            id: "readwise",
            links: { self: selfHref, start: "/opds", up: "/opds" },
            title: "Readwise Reader",
        });
        feed.addEntries(this.FEEDS.map((entry) => ({
            title: entry.name,
            id: `readwise-${entry.id}`,
            link: `/opds/provider/readwise/${entry.id}`,
            content: entry.description,
        })));
        return feed.toXmlString();
    }
    registerRoutes(app) {
        // Navigation feed: the per-location sub-feeds
        app.get("/opds/provider/readwise", (req, res) => {
            res.type("application/xml").send(this.renderNavFeed());
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
                    // Warm the top of the feed in the background (skip in strip mode,
                    // where builds are already instant).
                    if (this.imageMode() !== "strip") {
                        this.enqueueWarm(docs.slice(0, this.WARM_COUNT).map((d) => d.id));
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
        // On-demand EPUB for a single document
        app.get("/opds/provider/readwise/content.epub", async (req, res) => {
            var _a;
            if (!this.isConnected()) {
                res.status(401).send("Readwise is not configured. Set READWISE_TOKEN.");
                return;
            }
            const id = req.query.id;
            if (typeof id !== "string" || id.length === 0) {
                res.status(400).send("Missing document id");
                return;
            }
            // Mark a live download so background warming backs off and this request
            // (cached or cold) gets priority.
            this.liveDownloads++;
            let released = false;
            const release = () => {
                if (!released) {
                    released = true;
                    this.liveDownloads = Math.max(0, this.liveDownloads - 1);
                }
            };
            res.on("finish", release);
            res.on("close", release);
            try {
                const epubPath = await this.documentToEpub(id);
                // Stamp the Readwise id into the download filename: it gives the file a
                // real name in the reader's Files view, and lets the v2 read-state
                // KOSync connector map the finished book back to its Reader document
                // for archive-on-finish. The id is always present (from the route);
                // the title is added when known. See docs/V2-READ-STATE.md.
                const name = (_a = this.downloadNames.get(id)) !== null && _a !== void 0 ? _a : `readwise [rw-${id}].epub`;
                res.setHeader("Content-Disposition", contentDisposition(name));
                res.type("application/epub+zip").sendFile(epubPath);
            }
            catch (e) {
                console.error(`Readwise: failed to build EPUB for ${id}`, e);
                res.status(404).send("Could not retrieve this document");
                release();
            }
        });
        // Image transcoding proxy (used by transcode mode). epub-gen fetches the
        // rewritten <img src> (which ends in `.jpg`) from here; we fetch the
        // original image and return a downscaled JPEG that e-ink readers can decode.
        app.get("/opds/provider/readwise/img/:secret/:file", async (req, res) => {
            var _a;
            if (req.params.secret !== this.imgSecret) {
                res.status(404).end();
                return;
            }
            const file = String((_a = req.params.file) !== null && _a !== void 0 ? _a : "");
            const b64 = file.replace(/\.jpe?g$/i, "");
            let src = "";
            try {
                src = Buffer.from(b64, "base64url").toString("utf8");
            }
            catch (_b) {
                /* fall through to placeholder */
            }
            if (!/^https?:\/\//i.test(src)) {
                res.type("image/jpeg").send(await this.getPlaceholder());
                return;
            }
            try {
                const sharp = await this.getSharp();
                const resp = await got(src, {
                    responseType: "buffer",
                    timeout: { request: 20000 },
                    retry: { limit: 1 },
                    headers: { "user-agent": IMG_UA, accept: "image/*,*/*" },
                });
                let pipe = sharp(resp.body, { animated: false, failOn: "none" })
                    .rotate()
                    .resize({ width: this.IMG_MAX_WIDTH, withoutEnlargement: true });
                if (this.IMG_GRAYSCALE) {
                    // Grayscale + contrast stretch reads better on e-ink than a color
                    // image the device has to reduce itself. toColourspace("b-w") emits a
                    // true single-channel JPEG (smaller, no color subsampling artifacts).
                    pipe = pipe.grayscale().normalise().toColourspace("b-w");
                }
                const out = await pipe.jpeg({ quality: this.IMG_QUALITY, mozjpeg: true }).toBuffer();
                res.type("image/jpeg").send(out);
            }
            catch (e) {
                // Return a placeholder rather than erroring, so the EPUB stays valid.
                console.warn("Readwise img transcode failed:", src, e.message);
                res.type("image/jpeg").send(await this.getPlaceholder());
            }
        });
    }
    /** Fetch documents for a location, paging up to MAX_PAGES, with a short cache. */
    async getDocuments(location) {
        var _a, _b, _c, _d;
        const cached = this.listCache.get(location);
        if (cached && Date.now() - cached.fetchedAt < this.LIST_TTL_MS) {
            return cached.docs;
        }
        const docs = [];
        let pageCursor;
        for (let page = 0; page < this.MAX_PAGES; page++) {
            const searchParams = { location, withHtmlContent: "false" };
            if (pageCursor)
                searchParams.pageCursor = pageCursor;
            const data = (await got
                .get(`${this.BASE_URL}/api/v3/list/`, { headers: this.authHeaders(), searchParams })
                .json());
            if (process.env.VERBOSE) {
                console.log(`Readwise list [${location}] page ${page}: ${(_b = (_a = data.results) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0} docs`);
            }
            docs.push(...((_c = data.results) !== null && _c !== void 0 ? _c : []));
            pageCursor = (_d = data.nextPageCursor) !== null && _d !== void 0 ? _d : undefined;
            if (!pageCursor)
                break;
            // Stop paging once we have enough to fill the (capped) feed.
            if (this.FEED_LIMIT > 0 && docs.length >= this.FEED_LIMIT)
                break;
        }
        let filtered = this.CATEGORIES.length
            ? docs.filter((d) => d.category && this.CATEGORIES.includes(d.category.toLowerCase()))
            : docs;
        if (this.FEED_LIMIT > 0)
            filtered = filtered.slice(0, this.FEED_LIMIT);
        this.listCache.set(location, { fetchedAt: Date.now(), docs: filtered });
        for (const doc of filtered)
            this.downloadNames.set(doc.id, downloadFilename(doc));
        return filtered;
    }
    /** Fetch a single document with html_content and build (or reuse) its EPUB. */
    async documentToEpub(id) {
        var _a, _b, _c;
        const outputPath = this.cachePathFor(id);
        if (fs.existsSync(outputPath))
            return outputPath;
        const data = (await got
            .get(`${this.BASE_URL}/api/v3/list/`, {
            headers: this.authHeaders(),
            searchParams: { id, withHtmlContent: "true" },
        })
            .json());
        const doc = (_a = data.results) === null || _a === void 0 ? void 0 : _a[0];
        if (!doc)
            throw new Error(`Document ${id} not found`);
        this.downloadNames.set(id, downloadFilename(doc));
        let html = doc.html_content && doc.html_content.trim().length > 0
            ? doc.html_content
            : `<h1>${escapeHtml((_b = doc.title) !== null && _b !== void 0 ? _b : "Untitled")}</h1>` +
                (doc.summary ? `<p>${escapeHtml(doc.summary)}</p>` : "") +
                (doc.url ? `<p><a href="${escapeHtml(doc.url)}">${escapeHtml(doc.url)}</a></p>` : "");
        const mode = this.imageMode();
        if (mode === "strip")
            html = stripImages(html);
        else if (mode === "transcode")
            html = this.rewriteImagesToProxy(html);
        return htmlToEpub({
            html,
            title: ((_c = doc.title) === null || _c === void 0 ? void 0 : _c.trim()) || doc.url || "Untitled",
            author: doc.author || doc.site_name || null,
            publisher: doc.site_name || (doc.url ? hostOf(doc.url) : null),
            outputPath,
        });
    }
    /** Rewrite <img> sources to the transcoding proxy (ending in `.jpg`). */
    rewriteImagesToProxy(html) {
        html = html.replace(/<source\b[^>]*>/gi, "").replace(/<\/?picture\b[^>]*>/gi, "");
        const proxyBase = `http://127.0.0.1:${this.PORT}/opds/provider/readwise/img/${this.imgSecret}`;
        return html.replace(/<img\b[^>]*>/gi, (tag) => {
            var _a;
            const t = tag.replace(/\bsrcset\s*=\s*("[^"]*"|'[^']*')/gi, "");
            const m = t.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i);
            const src = m ? (_a = m[2]) !== null && _a !== void 0 ? _a : m[3] : undefined;
            if (!src || !/^https?:\/\//i.test(src))
                return t;
            const enc = Buffer.from(src, "utf8").toString("base64url");
            return t.replace(m[0], `src="${proxyBase}/${enc}.jpg"`);
        });
    }
    /** Lazy-load sharp and pin its thread pool to 1 so warming can't hog the CPU. */
    async getSharp() {
        if (!this.sharpModule) {
            const s = (await import("sharp")).default;
            try {
                s.concurrency(1);
            }
            catch (_a) {
                /* older sharp: ignore */
            }
            this.sharpModule = s;
        }
        return this.sharpModule;
    }
    async getPlaceholder() {
        if (this.placeholderJpeg)
            return this.placeholderJpeg;
        const sharp = await this.getSharp();
        const buf = await sharp({
            create: { width: 2, height: 2, channels: 3, background: "#ffffff" },
        })
            .jpeg()
            .toBuffer();
        this.placeholderJpeg = buf;
        return buf;
    }
    // ---- Background cache warming ----
    enqueueWarm(ids) {
        for (const id of ids) {
            if (this.warmSet.has(id))
                continue;
            if (fs.existsSync(this.cachePathFor(id)))
                continue;
            this.warmSet.add(id);
            this.warmQueue.push(id);
        }
        void this.runWarm();
    }
    async runWarm() {
        if (this.warming)
            return;
        this.warming = true;
        try {
            while (this.warmQueue.length) {
                // Yield to any live download so the user's tap is never starved.
                while (this.liveDownloads > 0)
                    await sleep(500);
                const id = this.warmQueue.shift();
                this.warmSet.delete(id);
                try {
                    if (!fs.existsSync(this.cachePathFor(id))) {
                        await this.documentToEpub(id);
                        if (process.env.VERBOSE)
                            console.log(`Readwise warm: cached ${id}`);
                    }
                }
                catch (e) {
                    console.warn(`Readwise warm failed for ${id}:`, e.message);
                }
                if (this.warmQueue.length)
                    await sleep(this.WARM_INTERVAL_MS);
            }
        }
        finally {
            this.warming = false;
        }
    }
}
function sanitizeId(id) {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
/**
 * Download filename for a document: "<title> [rw-<id>].epub". The [rw-<id>]
 * stamp is what the v2 read-state connector parses to map the finished book
 * back to its Readwise Reader document. Title is sanitized and length-capped.
 */
function downloadFilename(doc) {
    const raw = (doc.title || doc.url || "Untitled").trim();
    const safeTitle = raw
        .replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "Untitled";
    return `${safeTitle} [rw-${doc.id}].epub`;
}
/**
 * Build a Content-Disposition header value. Provides an ASCII-safe `filename`
 * and an RFC 5987 `filename*` for the full UTF-8 name.
 */
function contentDisposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
function stripImages(html) {
    return html
        .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, "")
        .replace(/<img\b[^>]*>/gi, "")
        .replace(/<source\b[^>]*>/gi, "");
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
