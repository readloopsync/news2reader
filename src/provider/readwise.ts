import fs from "node:fs";
import path from "node:path";
import got from "got";
import { Express, Request, Response } from "express";
import { OPDSFeed } from "../opds.js";
import { htmlToEpub } from "../epub.js";

/**
 * Readwise Reader provider.
 *
 * Exposes your Readwise Reader library as OPDS feeds (one per "location":
 * new / later / shortlist / archive / feed) and converts each document to an
 * EPUB on demand using the document's own `html_content` from the Reader API
 * (so paywalled articles, newsletters, and reader-mode cleanups survive).
 *
 * Auth: set READWISE_TOKEN to a Readwise access token (https://readwise.io/access_token).
 *
 * Reader API: https://readwise.io/reader_api
 *  - GET /api/v3/list/            (paginated; 20 requests/min per token)
 *  - Authorization: Token <token>
 *  - withHtmlContent=true adds the full `html_content` field (slower).
 */

/** A subset of the Reader document shape we rely on. */
interface ReaderDocument {
  id: string;
  url?: string;
  source_url?: string;
  title?: string;
  author?: string;
  source?: string;
  site_name?: string;
  category?: string; // article | email | rss | highlight | note | pdf | epub | tweet | video
  location?: string; // new | later | shortlist | archive | feed
  word_count?: number;
  created_at?: string;
  updated_at?: string;
  published_date?: number | string | null;
  summary?: string;
  html_content?: string;
  reading_progress?: number;
}

interface ReaderListResponse {
  count: number;
  nextPageCursor?: string | null;
  results: ReaderDocument[];
}

interface FeedDescription {
  name: string;
  id: string;       // also the Reader `location` value
  description: string;
}

interface CachedList {
  fetchedAt: number;
  docs: ReaderDocument[];
}

export default class ReadwiseProvider {
  public readonly BASE_URL = process.env.READWISE_BASE_URL ?? "https://readwise.io";
  private readonly TOKEN = process.env.READWISE_TOKEN ?? null;

  // Bound how many list pages we page through per feed request, to respect the
  // 20 req/min rate limit (100 docs/page => up to 300 docs shown).
  private readonly MAX_PAGES = Number(process.env.READWISE_MAX_PAGES ?? 3);
  // Short in-memory cache of list responses per location, to avoid hammering
  // the API when a reader re-opens a feed.
  private readonly LIST_TTL_MS = Number(process.env.READWISE_LIST_TTL_MS ?? 60_000);
  private listCache: Map<string, CachedList> = new Map();

  private readonly cacheDir: string;

  private readonly FEEDS: FeedDescription[] = [
    { name: "Inbox (New)", id: "new", description: "Unread items in your Readwise Reader inbox" },
    { name: "Later", id: "later", description: "Items saved for later" },
    { name: "Shortlist", id: "shortlist", description: "Your shortlisted items" },
    { name: "Feed", id: "feed", description: "Items from your Reader feeds" },
    { name: "Archive", id: "archive", description: "Archived items" },
  ];

  public constructor(app: Express, configDir: string) {
    this.cacheDir = path.join(configDir, "readwise-epub-cache");
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.registerRoutes(app);
  }

  public isConnected() {
    return typeof this.TOKEN === "string" && this.TOKEN.length > 0;
  }

  private authHeaders() {
    return {
      Accept: "application/json",
      Authorization: `Token ${this.TOKEN}`,
    };
  }

  private registerRoutes(app: Express) {
    // Navigation feed: list the per-location sub-feeds
    app.get("/opds/provider/readwise", (req: Request, res: Response) => {
      const feed = new OPDSFeed({
        id: "readwise",
        links: {
          self: "/opds/provider/readwise",
          start: "/opds",
          up: "/opds",
        },
        title: "Readwise Reader",
      });
      feed.addEntries(
        this.FEEDS.map((entry) => ({
          title: entry.name,
          id: `readwise-${entry.id}`,
          link: `/opds/provider/readwise/${entry.id}`,
          content: entry.description,
        }))
      );
      res.type("application/xml").send(feed.toXmlString());
    });

    // Acquisition feeds (one per location)
    for (const entry of this.FEEDS) {
      app.get(
        `/opds/provider/readwise/${entry.id}`,
        async (req: Request, res: Response) => {
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
              const title = doc.title?.trim() || doc.url || "Untitled";
              feed.addAcquisitionEntry({
                id: `readwise:${doc.id}`,
                title,
                href: `/opds/provider/readwise/content.epub?id=${encodeURIComponent(doc.id)}`,
                author: doc.author || doc.site_name || undefined,
                summary: doc.summary || undefined,
                updated: doc.updated_at || undefined,
              });
            }
          } catch (e) {
            console.error("Readwise: failed to list documents", e);
            res.status(502).send("Failed to fetch documents from Readwise");
            return;
          }

          res.type("application/xml").send(feed.toXmlString());
        }
      );
    }

    // On-demand EPUB for a single document, built from its html_content
    app.get(
      "/opds/provider/readwise/content.epub",
      async (req: Request, res: Response) => {
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
        } catch (e) {
          console.error(`Readwise: failed to build EPUB for ${id}`, e);
          res.status(404).send("Could not retrieve this document");
        }
      }
    );
  }

  /**
   * Fetch documents for a location, paging up to MAX_PAGES, with a short cache.
   * Metadata only (no html_content) — content is fetched lazily at download.
   */
  private async getDocuments(location: string): Promise<ReaderDocument[]> {
    const cached = this.listCache.get(location);
    if (cached && Date.now() - cached.fetchedAt < this.LIST_TTL_MS) {
      return cached.docs;
    }

    const docs: ReaderDocument[] = [];
    let pageCursor: string | undefined;
    for (let page = 0; page < this.MAX_PAGES; page++) {
      const searchParams: Record<string, string> = {
        location,
        withHtmlContent: "false",
      };
      if (pageCursor) searchParams.pageCursor = pageCursor;

      const data = (await got
        .get(`${this.BASE_URL}/api/v3/list/`, {
          headers: this.authHeaders(),
          searchParams,
        })
        .json()) as ReaderListResponse;

      if (process.env.VERBOSE) {
        console.log(`Readwise list [${location}] page ${page}: ${data.results?.length ?? 0} docs`);
      }

      docs.push(...(data.results ?? []));
      pageCursor = data.nextPageCursor ?? undefined;
      if (!pageCursor) break;
    }

    this.listCache.set(location, { fetchedAt: Date.now(), docs });
    return docs;
  }

  /** Fetch a single document with html_content and build (or reuse) its EPUB. */
  private async documentToEpub(id: string): Promise<string> {
    const outputPath = path.join(this.cacheDir, `readwise-${sanitizeId(id)}.epub`);
    if (fs.existsSync(outputPath)) {
      return outputPath;
    }

    const data = (await got
      .get(`${this.BASE_URL}/api/v3/list/`, {
        headers: this.authHeaders(),
        searchParams: { id, withHtmlContent: "true" },
      })
      .json()) as ReaderListResponse;

    const doc = data.results?.[0];
    if (!doc) {
      throw new Error(`Document ${id} not found`);
    }

    let html = doc.html_content && doc.html_content.trim().length > 0
      ? doc.html_content
      : `<h1>${escapeHtml(doc.title ?? "Untitled")}</h1>` +
        (doc.summary ? `<p>${escapeHtml(doc.summary)}</p>` : "") +
        (doc.url ? `<p><a href="${escapeHtml(doc.url)}">${escapeHtml(doc.url)}</a></p>` : "");

    // Image handling. Some e-ink EPUB engines (incl. Crosspoint) can't decode
    // webp, which epub-gen embeds as-is; that can make the whole book fail to
    // open. `strip` removes images entirely for maximum compatibility.
    //   READWISE_IMAGES = keep (default) | strip
    const imageMode = process.env.READWISE_IMAGES ?? "keep";
    if (imageMode === "strip") {
      html = html
        .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, "")
        .replace(/<img\b[^>]*>/gi, "")
        .replace(/<source\b[^>]*>/gi, "");
    }

    return htmlToEpub({
      html,
      title: doc.title?.trim() || doc.url || "Untitled",
      author: doc.author || doc.site_name || null,
      publisher: doc.site_name || (doc.url ? hostOf(doc.url) : null),
      outputPath,
    });
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
