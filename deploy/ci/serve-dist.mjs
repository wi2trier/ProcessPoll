import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dist = path.resolve(arg("dist", "frontend/dist"));
const port = Number(arg("port", process.env.PORT || "8080"));
const backend = new URL(arg("backend", process.env.BACKEND_URL || "http://127.0.0.1:8000"));

const HEADER_NAMES = [
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "X-Frame-Options",
  "Cross-Origin-Opener-Policy",
  "Permissions-Policy",
];

function loadSecurityHeaders(source) {
  if (!source || source === "off") return {};
  const caddyfile =
    source === "production" ? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Caddyfile") : path.resolve(source);
  const text = fs.readFileSync(caddyfile, "utf8");
  const headers = {};
  for (const name of HEADER_NAMES) {
    const m = new RegExp(`^\\s*${name}\\s+"([^"]*)"\\s*$`, "im").exec(text);
    if (!m) throw new Error(`header ${name} not found in ${caddyfile}`);
    headers[name.toLowerCase()] = m[1];
  }
  return headers;
}

const securityHeaders = loadSecurityHeaders(arg("headers", "off"));

if (process.argv.includes("--allow-test-eval") && securityHeaders["content-security-policy"]) {
  securityHeaders["content-security-policy"] = securityHeaders["content-security-policy"].replace(
    "script-src 'self'",
    "script-src 'self' 'unsafe-eval'",
  );
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function proxy(req, res) {
  const upstream = http.request(
    {
      host: backend.hostname,
      port: backend.port || 80,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: backend.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      if ((up.headers["content-type"] || "").includes("text/event-stream")) {
        res.flushHeaders();
      }
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "bad_gateway", message: String(err.message) }));
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

function serveFile(res, file) {
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const headers = { ...securityHeaders, "content-type": type };
  headers["cache-control"] = file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
    return proxy(req, res);
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  const candidate = path.normalize(path.join(dist, rel));
  if (candidate !== dist && !candidate.startsWith(dist + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.stat(candidate, (err, st) => {
    if (!err && st.isFile()) return serveFile(res, candidate);
    if (rel.startsWith("/assets/")) {
      res.writeHead(404).end("not found");
      return;
    }
    serveFile(res, path.join(dist, "index.html"));
  });
});

server.keepAliveTimeout = 0;
server.listen(port, "127.0.0.1", () => {
  const csp = securityHeaders["content-security-policy"];
  console.log(`serving ${dist} on http://127.0.0.1:${port} (api -> ${backend.origin})`);
  console.log(csp ? `CSP: ${csp}` : "security headers: off");
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
