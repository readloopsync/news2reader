/**
 * This application generates OPDS feeds (https://specs.opds.io/opds-1.2)
 * based on items fetched from link aggregators, and EPUBs based on
 * those links upon request.
 */
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import express, { Express, Request, Response } from "express";
import xdg from "@folder/xdg";
import { OPDSFeed } from "./opds.js";
import { articleToEpub } from "./epub.js";
import PocketProvider from "./provider/pocket.js";
import HackerNewsProvider from "./provider/hacker-news.js";
import TildesProvider from "./provider/tildes.js";
import KarakeepProvider from "./provider/karakeep.js";
import ReadwiseProvider from "./provider/readwise.js";

//import dotenv from 'dotenv';
//dotenv.config();
const dirs = xdg({
  subdir: "news2reader",
});
const configDir = dirs.config;
fs.mkdirSync(configDir, { recursive: true });

const app: Express = express();
const port = process.env.PORT ?? 8080;

// Basic request/response logging
app.use((req, res, next) => {
  res.on("finish", () => {
    const now = new Date().toISOString();
    console.log(`${now} ${req.method} ${req.url} (HTTP ${res.statusCode})`);
  });
  next();
});

// Optional HTTP Basic auth for the whole server. Set OPDS_AUTH_USER and
// OPDS_AUTH_PASS to require credentials — essential when exposing the server
// publicly (e.g. via a tunnel). Crosspoint's OPDS client has username/password
// fields, so Basic auth works on-device.
const AUTH_USER = process.env.OPDS_AUTH_USER;
const AUTH_PASS = process.env.OPDS_AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  const expected = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`);
  app.use((req, res, next) => {
    // The internal image-transcode route is only called server-side during EPUB
    // generation and self-guards with a per-process secret, so exempt it here
    // (otherwise epub-gen's own fetches would be rejected).
    if (req.path.startsWith("/opds/provider/readwise/img/")) return next();
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Basic ")) {
      const got = Buffer.from(header.slice(6), "base64");
      if (got.length === expected.length && timingSafeEqual(got, expected)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Readloop"');
    res.status(401).send("Authentication required");
  });
  console.log("HTTP Basic auth is ENABLED");
}

const catalogAuthor = {
  name: "news2reader",
  uri: "https://github.com/BHSPitMonkey/news2reader",
};

// Initialize providers
const hackerNewsProvider = new HackerNewsProvider(app, configDir);
const pocketProvider = new PocketProvider(app, configDir);
const tildesProvider = new TildesProvider(app, configDir);
const karakeepProvider = new KarakeepProvider(app, configDir);
const readwiseProvider = new ReadwiseProvider(app, configDir);

// Which providers to advertise at the catalog root. Default: all.
// Set OPDS_PROVIDERS to a comma-separated list (e.g. "readwise") to run a
// focused instance so readers don't have to scroll past sources they don't use.
const providerFilter = (process.env.OPDS_PROVIDERS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const showAllProviders = providerFilter.length === 0;
const providerEnabled = (key: string) => showAllProviders || providerFilter.includes(key);
const onlyReadwise =
  !showAllProviders && providerFilter.length === 1 && providerFilter[0] === "readwise";

// Catalog Root
app.get("/opds", (req: Request, res: Response) => {
  // Single-provider shortcut: when only Readwise is enabled, serve its feed as
  // the root so readers land directly on the locations — no extra tap, and no
  // need to hand-type a deep URL on an e-ink keyboard.
  if (onlyReadwise && readwiseProvider.isConnected()) {
    res.type("application/xml").send(readwiseProvider.renderNavFeed("/opds"));
    return;
  }

  const feed = new OPDSFeed({
    id: "foo",
    links: {
      self: "/opds",
      start: "/opds",
    },
    title: "News2Reader Catalog Root",
    author: catalogAuthor,
  });
  const entries = [];
  if (providerEnabled("hackernews")) {
    entries.push({ title: "Hacker News", id: "hn", link: "/opds/provider/hackernews", content: "Stories from Hacker News" });
  }
  if (providerEnabled("tildes")) {
    entries.push({ title: "Tildes", id: "tildes", link: "/opds/provider/tildes", content: "Articles from Tildes" });
  }
  if (providerEnabled("karakeep")) {
    entries.push({ title: "Karakeep", id: "karakeep", link: "/opds/provider/karakeep", content: "Saved articles from your Karakeep account" });
  }
  if (providerEnabled("pocket")) {
    entries.push({ title: "Pocket", id: "pocket", link: "/opds/provider/pocket", content: "Saved articles from your Pocket account" });
  }
  feed.addEntries(entries);
  // Only advertise Readwise when enabled and a token is configured
  if (providerEnabled("readwise") && readwiseProvider.isConnected()) {
    feed.addEntry({
      title: "Readwise Reader",
      id: "readwise",
      link: "/opds/provider/readwise",
      content: "Saved articles from your Readwise Reader library",
    });
  }
  res.type("application/xml").send(feed.toXmlString());
});

// Generate and serve an epub based on the 'url' query param
app.get("/content.epub", async (req: Request, res: Response) => {
  let url = req.query.url;
  if (typeof url !== "string") {
    console.error("Query string did not contain a string as the URL");
    res.status(400).send("Could not retrieve this article");
    return;
  }

  // URL may need to be base64 decoded
  if (!url.startsWith("http:") || !url.startsWith("https:")) {
    url = Buffer.from(url, "base64").toString();
  }

  const title = typeof req.query.title === "string" ? req.query.title : null;

  try {
    const epubFilePath = await articleToEpub(url, title);
    res.sendFile(epubFilePath);
  } catch (error) {
    console.error("Failed to create EPUB from article URL");
    console.error(error);
    res.status(404).send("Could not retrieve this article");
    return;
  }
});

// Generate and serve an epub based on the 'url' query param
app.get("/", async (req: Request, res: Response) => {
  let pocketHtml;
  if (pocketProvider.isConnected()) {
    pocketHtml = `<p>Connected! <a href="/pocket/setup">Switch to another Pocket account</a></p>`;
  } else {
    pocketHtml = `<p>Not connected. <a href="/pocket/setup">Connect to Pocket</a></p>`;
  }
  let karakeepHtml;
  if (karakeepProvider.isConnected()) {
    karakeepHtml = `<p>Connected! Using Karakeep server at ${karakeepProvider.BASE_URL}</p>`;
  } else {
    karakeepHtml = `<p>Not connected. Set <code>KARAKEEP_API_URL</code> and <code>KARAKEEP_API_KEY</code> to configure.</p>`;
  }
  let readwiseHtml;
  if (readwiseProvider.isConnected()) {
    readwiseHtml = `<p>Connected! Using Readwise Reader.</p>`;
  } else {
    readwiseHtml = `<p>Not connected. Set <code>READWISE_TOKEN</code> (from <a href="https://readwise.io/access_token">readwise.io/access_token</a>) to configure.</p>`;
  }
  const body = `
  <html>
  <head>
    <title>news2reader server</title>
    <style>
      html { background: #ddd; }
      body { background: #eee; font-family:sans-serif; max-width: 800px; margin: 22px auto; padding: 22px; }
    </style>
  </head>
  <body>
    <h1>news2reader server</h1>
    <p>Learn more on GitHub: <a href="https://github.com/BHSPitMonkey/news2reader">BHSPitMonkey/news2reader</a></p>
    <h2>Add to your e-reader</h2>
    <p>
      Add this server as an OPDS Catalog in supported e-reader software (such as koreader)
      using the <code>/opds</code> URI.
    </p>
    <p>For example, <code>http://localhost:8080/opds</code> 
      (substitute <code>localhost:8080</code> if you are using a different host or port.)
    </p>
    <h2>Connected accounts</h2>
    <h3>Hacker News</h3>
    <p>Not yet supported</h3>
    <h3>Tildes.net</h3>
    <p>Not yet supported</h3>
    <h3>Karakeep</h3>
    ${karakeepHtml}
    <h3>Readwise Reader</h3>
    ${readwiseHtml}
    <h3>Pocket-compatible server at ${pocketProvider.BASE_URL}</h3>
    ${pocketHtml}
  </body>
  `;
  res.send(body);
});

app.use((req, res, next) => {
  res.status(404).send("Sorry can't find that!");
});

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});
