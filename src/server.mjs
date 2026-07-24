import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderAppPage } from "./app-page.mjs";
import { buildMemoryContext, loadDailyPlayback, loadEntries, searchEntries } from "./lifelog.mjs";
import { handleMcpRequest, sendMcpPreflight } from "./mcp.mjs";

const MIME_TYPES = new Map([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".txt", "text/plain; charset=utf-8"],
  [".vtt", "text/vtt; charset=utf-8"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
]);

const PRIVATE_TOP_LEVEL = new Set(["audio", "memory", "metadata", "transcripts"]);
const PRIVATE_PREFIX = /^\/(?:audio|memory|metadata|transcripts)(?:\/|$)/;

let CANVASUI_RIPPLE_SOURCE = "";
try {
  CANVASUI_RIPPLE_SOURCE = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "canvasui-ripple.mjs"),
    "utf8",
  );
} catch {
  // Optional WebGL ripple effect — skip if file is absent.
}

function isLifelogOnlyPath(pathname) {
  return PRIVATE_PREFIX.test(pathname)
    || pathname === "/app"
    || pathname === "/mcp"
    || pathname === "/.well-known/mcp.json"
    || pathname === "/api"
    || pathname.startsWith("/api/");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function secureEqual(left, right) {
  const leftDigest = createHash("sha256").update(String(left)).digest();
  const rightDigest = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function normalizeAuth(auth = {}) {
  const token = String(auth.token || "").trim();
  const username = String(auth.username || "");
  const password = String(auth.password || "");
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("auth username and password must be configured together");
  }
  return { token, username, password, enabled: Boolean(token || username) };
}

function isAuthorized(request, auth) {
  if (!auth.enabled) return true;
  const authorization = String(request.headers.authorization || "");
  const separator = authorization.indexOf(" ");
  if (separator < 1) return false;
  const scheme = authorization.slice(0, separator).toLowerCase();
  const credential = authorization.slice(separator + 1).trim();

  if (scheme === "bearer" && auth.token) {
    return secureEqual(credential, auth.token);
  }
  if (scheme === "basic" && auth.username) {
    const decoded = Buffer.from(credential, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return false;
    return secureEqual(decoded.slice(0, colon), auth.username)
      && secureEqual(decoded.slice(colon + 1), auth.password);
  }
  return false;
}

function authChallenges(auth) {
  const challenges = [];
  if (auth.username) challenges.push('Basic realm="afterimage", charset="UTF-8"');
  if (auth.token) challenges.push('Bearer realm="afterimage"');
  return challenges;
}

function baseHeaders(privateResource = false) {
  const headers = {
    "cross-origin-resource-policy": privateResource ? "same-origin" : "cross-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
  };
  if (!privateResource) {
    headers["access-control-allow-origin"] = "*";
    headers["access-control-expose-headers"] = "accept-ranges,content-length,content-range,etag,last-modified";
  }
  return headers;
}

function sendBuffer(response, status, body, headers = {}, method = "GET", privateResource = false) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, {
    ...baseHeaders(privateResource),
    "content-length": String(bytes.length),
    ...headers,
  });
  response.end(method === "HEAD" ? undefined : bytes);
}

function sendUnauthorized(response, method, auth) {
  sendBuffer(response, 401, "authentication_required\n", {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": authChallenges(auth),
  }, method, true);
}

function sendError(response, status, message, method = "GET") {
  sendBuffer(response, status, `${message}\n`, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  }, method);
}

function sendJson(response, status, value, method = "GET", headers = {}) {
  const body = JSON.stringify(value);
  sendBuffer(response, status, body, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    ...headers,
  }, method, true);
}

function decodeRequestPathname(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid_path");
  }
  if (decoded.includes("\0") || decoded.includes("\\")) throw new HttpError(400, "invalid_path");
  return decoded;
}

function requestSegments(decodedPathname) {
  const segments = decodedPathname.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new HttpError(400, "invalid_path");
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    throw new HttpError(404, "not_found");
  }
  return segments;
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolvePublicPath(root, pathname) {
  const segments = requestSegments(pathname);
  const rootReal = await realpath(root);
  const candidate = path.resolve(rootReal, ...segments);
  if (!isWithin(rootReal, candidate)) throw new HttpError(400, "invalid_path");

  let candidateReal;
  try {
    candidateReal = await realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw new HttpError(404, "not_found");
    throw error;
  }
  if (!isWithin(rootReal, candidateReal)) throw new HttpError(404, "not_found");

  const info = await lstat(candidateReal);
  if (info.isSymbolicLink()) throw new HttpError(404, "not_found");
  return { candidate: candidateReal, info };
}

function parseRange(value, size) {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, "range_not_satisfiable");

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new HttpError(416, "range_not_satisfiable");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new HttpError(416, "range_not_satisfiable");
  }
  return { start, end: Math.min(end, size - 1) };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function publicPath(pathname) {
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

async function directoryItems(directory, pathname, hiddenRootNames = new Set()) {
  const entries = await readdir(directory, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !entry.name.startsWith(".")
      && !(pathname === "/" && hiddenRootNames.has(entry.name))
      && (entry.isDirectory() || entry.isFile()))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  return Promise.all(visible.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    const info = await stat(entryPath);
    const encodedName = encodeURIComponent(entry.name);
    return {
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      size: entry.isFile() ? info.size : null,
      modifiedAt: info.mtime.toISOString(),
      url: `${publicPath(pathname)}${encodedName}${entry.isDirectory() ? "/" : ""}`,
    };
  }));
}

function renderDirectory(pathname, items) {
  const rows = items.length === 0
    ? '<div class="empty">This directory is empty.</div>'
    : items.map((item) => `
      <a class="row" href="${escapeHtml(item.url)}">
        <span class="kind" aria-hidden="true">${item.type === "directory" ? "DIR" : "FILE"}</span>
        <span class="name">${escapeHtml(item.name)}</span>
        <span class="meta">${item.type === "file" ? escapeHtml(formatBytes(item.size)) : ""}</span>
      </a>`).join("");

  const title = pathname === "/" ? "afterimage" : pathname;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)} | afterimage</title>
  <style>
    :root { color-scheme: light dark; --bg:#f6f7f9; --panel:#ffffff; --text:#16181d; --muted:#69707d; --line:#dfe3e8; --accent:#0b63ce; }
    @media (prefers-color-scheme: dark) { :root { --bg:#111318; --panel:#181b21; --text:#eef1f5; --muted:#9ca4b1; --line:#2b3039; --accent:#6aaefc; } }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(960px,calc(100% - 32px)); margin:0 auto; padding:56px 0 80px; }
    header { margin-bottom:28px; }
    h1 { margin:0 0 8px; font-size:clamp(25px,4vw,38px); line-height:1.15; letter-spacing:-.03em; }
    code { color:var(--muted); font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    .list { overflow:hidden; border:1px solid var(--line); border-radius:14px; background:var(--panel); }
    .row { display:grid; grid-template-columns:52px minmax(0,1fr) auto; gap:14px; align-items:center; min-height:58px; padding:10px 18px; color:inherit; text-decoration:none; border-bottom:1px solid var(--line); }
    .row:last-child { border-bottom:0; }
    .row:hover, .row:focus-visible { background:color-mix(in srgb,var(--accent) 8%,transparent); outline:none; }
    .kind { color:var(--muted); font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.05em; }
    .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .meta { color:var(--muted); font-variant-numeric:tabular-nums; }
    .empty { padding:30px 18px; color:var(--muted); }
    footer { margin-top:18px; color:var(--muted); font-size:12px; }
    @media (max-width:600px) { main { width:min(100% - 20px,960px); padding-top:32px; } .row { grid-template-columns:44px minmax(0,1fr); padding-inline:14px; } .meta { display:none; } }
  </style>
</head>
<body>
  <main>
    <header><h1>afterimage</h1><code>${escapeHtml(pathname)}</code></header>
    <section class="list" aria-label="File listing">${rows}</section>
    <footer>JSON: <a href="?format=json">?format=json</a></footer>
  </main>
</body>
</html>`;
}

async function serveDirectory(request, response, pathname, directory, method, searchParams, privateResource = false, hiddenRootNames = new Set()) {
  const items = await directoryItems(directory, pathname, hiddenRootNames);
  if (searchParams.get("format") === "json") {
    const body = JSON.stringify({ path: publicPath(pathname), items });
    return sendBuffer(response, 200, body, {
      "cache-control": privateResource ? "private, no-store" : "no-cache",
      "content-type": "application/json; charset=utf-8",
    }, method, privateResource);
  }

  const body = renderDirectory(publicPath(pathname), items);
  return sendBuffer(response, 200, body, {
    "cache-control": privateResource ? "private, no-store" : "no-cache",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
  }, method, privateResource);
}

async function serveFile(request, response, filename, info, method, privateResource = false) {
  let range;
  try {
    range = parseRange(request.headers.range, info.size);
  } catch (error) {
    if (error.status === 416) {
      response.writeHead(416, {
        ...baseHeaders(privateResource),
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "content-range": `bytes */${info.size}`,
      });
      response.end();
      return;
    }
    throw error;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const status = range ? 206 : 200;
  const headers = {
    ...baseHeaders(privateResource),
    "accept-ranges": "bytes",
    "cache-control": privateResource ? "private, no-store" : "public, max-age=60, must-revalidate",
    "content-length": String(end - start + 1),
    "content-type": MIME_TYPES.get(path.extname(filename).toLowerCase()) || "application/octet-stream",
    etag: `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
    "last-modified": info.mtime.toUTCString(),
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${info.size}`;

  response.writeHead(status, headers);
  if (method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(filename, { start, end });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

export function createAfterimageServer({
  root,
  mode = "lifelog",
  lifelogOrigin = "",
  assetOrigin = "",
  auth = {},
}) {
  if (!root) throw new Error("root is required");
  if (mode !== "public" && mode !== "lifelog") throw new Error("mode must be public or lifelog");
  const lifelogMode = mode === "lifelog";
  const resolvedLifelogOrigin = lifelogOrigin || `http://localhost:${process.env.PORT || 8901}`;
  const resolvedAssetOrigin = assetOrigin || resolvedLifelogOrigin;
  const assetCspOrigin = new URL(resolvedAssetOrigin).origin;
  const resolvedAuth = normalizeAuth(auth);

  return http.createServer(async (request, response) => {
    const method = request.method || "GET";
    try {
      const url = new URL(request.url, "http://afterimage.local");
      const pathname = decodeRequestPathname(url.pathname);

      if (pathname === "/_health" && (method === "GET" || method === "HEAD")) {
        await realpath(root);
        return sendBuffer(response, 200, JSON.stringify({
          ok: true,
          service: "afterimage",
          mode,
          features: lifelogMode ? ["lifelog", "search", "mcp"] : ["public-files"],
        }), {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        }, method);
      }

      if (method !== "OPTIONS" && !isAuthorized(request, resolvedAuth)) {
        return sendUnauthorized(response, method, resolvedAuth);
      }

      if (!lifelogMode && isLifelogOnlyPath(pathname)) throw new HttpError(404, "not_found");

      if (lifelogMode && pathname === "/" && (method === "GET" || method === "HEAD")) {
        response.writeHead(302, { ...baseHeaders(), location: "/app", "cache-control": "no-store" });
        response.end();
        return;
      }

      if (lifelogMode && pathname === "/assets/canvasui-ripple.mjs" && (method === "GET" || method === "HEAD")) {
        if (!CANVASUI_RIPPLE_SOURCE) throw new HttpError(404, "not_found");
        return sendBuffer(response, 200, CANVASUI_RIPPLE_SOURCE, {
          "cache-control": "public, max-age=3600",
          "content-type": "text/javascript; charset=utf-8",
        }, method, true);
      }

      if (lifelogMode && pathname === "/app" && (method === "GET" || method === "HEAD")) {
        return sendBuffer(response, 200, renderAppPage(), {
          "cache-control": "no-store",
          "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: ${assetCspOrigin}; media-src 'self' blob: ${assetCspOrigin}; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
          "content-type": "text/html; charset=utf-8",
        }, method, true);
      }

      if (lifelogMode && pathname === "/.well-known/mcp.json" && (method === "GET" || method === "HEAD")) {
        const endpoint = new URL("/mcp", resolvedLifelogOrigin).href;
        return sendJson(response, 200, {
          name: "afterimage",
          transport: "streamable-http",
          endpoint,
          authentication: resolvedAuth.token ? "bearer" : (resolvedAuth.username ? "basic" : "none"),
          mcpServers: { afterimage: { url: endpoint } },
        }, method);
      }

      if (lifelogMode && pathname === "/mcp" && method === "OPTIONS") return sendMcpPreflight(response);
      if (lifelogMode && pathname === "/mcp") {
        if (method !== "POST") {
          response.setHeader("allow", "POST, OPTIONS");
          return sendJson(response, 405, { jsonrpc: "2.0", error: { code: -32000, message: "SSE stream is not supported." }, id: null });
        }
        return await handleMcpRequest(request, response, { root, lifelogOrigin: resolvedLifelogOrigin, assetOrigin: resolvedAssetOrigin });
      }

      if (lifelogMode && pathname.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") {
          response.setHeader("allow", "GET, HEAD");
          return sendJson(response, 405, { error: "method_not_allowed" }, method);
        }

        if (pathname === "/api/entries") {
          const date = url.searchParams.get("date") || "";
          const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 100, 100));
          const entries = await loadEntries(root, { date, assetOrigin: resolvedAssetOrigin });
          const playback = date ? await loadDailyPlayback(root, entries, date, { assetOrigin: resolvedAssetOrigin }) : null;
          return sendJson(response, 200, { date, total: entries.length, playback, items: entries.slice(-limit) }, method);
        }
        if (pathname.startsWith("/api/entries/")) {
          const id = pathname.slice("/api/entries/".length);
          const entries = await loadEntries(root, { assetOrigin: resolvedAssetOrigin });
          const entry = entries.find((item) => item.id === id);
          if (!entry) return sendJson(response, 404, { error: "entry_not_found" }, method);
          return sendJson(response, 200, entry, method);
        }
        if (pathname === "/api/search") {
          const query = url.searchParams.get("q") || "";
          if (!query.trim()) return sendJson(response, 400, { error: "query_required" }, method);
          const date = url.searchParams.get("date") || "";
          const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 20, 100));
          const entries = await loadEntries(root, { date, assetOrigin: resolvedAssetOrigin });
          return sendJson(response, 200, searchEntries(entries, query, { date, limit }), method);
        }
        if (pathname === "/api/memory") {
          const date = url.searchParams.get("date") || "";
          if (!date) return sendJson(response, 400, { error: "date_required" }, method);
          const entries = await loadEntries(root, { date, assetOrigin: resolvedAssetOrigin });
          return sendJson(response, 200, buildMemoryContext(entries, date, { origin: resolvedAssetOrigin }), method);
        }
        return sendJson(response, 404, { error: "not_found" }, method);
      }

      if (lifelogMode && !PRIVATE_PREFIX.test(pathname)) throw new HttpError(404, "not_found");
      const privateResource = lifelogMode && PRIVATE_PREFIX.test(pathname);
      if (method !== "GET" && method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        return sendError(response, 405, "method_not_allowed", method);
      }

      const resolved = await resolvePublicPath(root, pathname);
      if (resolved.info.isDirectory()) {
        return await serveDirectory(
          request,
          response,
          pathname,
          resolved.candidate,
          method,
          url.searchParams,
          privateResource,
          lifelogMode ? new Set() : PRIVATE_TOP_LEVEL,
        );
      }
      if (resolved.info.isFile()) {
        return await serveFile(request, response, resolved.candidate, resolved.info, method, privateResource);
      }
      throw new HttpError(404, "not_found");
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : (error?.message === "invalid_date" ? 400 : 500);
      if (status === 500) console.error(`afterimage server request failed`, error instanceof Error ? error.message : String(error));
      if (response.headersSent) {
        response.destroy();
        return;
      }
      return sendError(response, status, status === 500 ? "internal_error" : error.message, method);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.AFTERIMAGE_ROOT;
  if (!root) {
    console.error("AFTERIMAGE_ROOT is required");
    process.exit(1);
  }
  const mode = process.env.AFTERIMAGE_MODE || "lifelog";
  const lifelogOrigin = process.env.AFTERIMAGE_ORIGIN || "";
  const assetOrigin = process.env.AFTERIMAGE_ASSET_ORIGIN || "";
  const auth = {
    token: process.env.AFTERIMAGE_AUTH_TOKEN || "",
    username: process.env.AFTERIMAGE_AUTH_USER || "",
    password: process.env.AFTERIMAGE_AUTH_PASSWORD || "",
  };
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8901);
  const server = createAfterimageServer({ root, mode, lifelogOrigin, assetOrigin, auth });
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.listen(port, host, () => console.log(`afterimage ${mode} server ready on ${host}:${port}`));

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
