import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] ?? "frontend/dist");
if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error(`scan-dist: ${dist}/index.html not found (run \`npm run build\` in frontend/ first)`);
  process.exit(2);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const files = walk(dist);
const rel = (f) => path.relative(dist, f).split(path.sep).join("/");
const failures = [];
const warnings = [];

const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
  if (!src) failures.push(`index.html: inline <script> (script-src 'self' blocks it)`);
  else if (/^(?:[a-z]+:)?\/\//i.test(src[1])) failures.push(`index.html: external script ${src[1]}`);
}
for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
  const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1]);
  if (href && /^(?:[a-z]+:)?\/\//i.test(href[1])) failures.push(`index.html: external <link href="${href[1]}">`);
}
if (/\son[a-z]+\s*=\s*["']/i.test(html)) failures.push("index.html: inline event handler attribute");
if (/\sstyle\s*=\s*["']/i.test(html)) failures.push("index.html: style attribute in the static markup");
if (/<style\b/i.test(html)) warnings.push("index.html: inline <style> element (needs style-src 'unsafe-inline', which is allowed today)");

for (const f of files.filter((x) => x.endsWith(".css"))) {
  const css = fs.readFileSync(f, "utf8");
  for (const m of css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi)) {
    if (/^(?:[a-z]+:)?\/\//i.test(m[1])) failures.push(`${rel(f)}: @import ${m[1]}`);
  }
  for (const m of css.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) failures.push(`${rel(f)}: url(${m[1]}) points to another origin`);
}

const probes = {
  "eval()": /(?<![\w.$])eval\s*\(/g,
  "new Function()": /new\s+Function\s*\(/g,
  "Worker": /new\s+(?:Shared)?Worker\s*\(/g,
  "blob: URL": /createObjectURL|["'`]blob:/g,
  "WebSocket": /new\s+WebSocket\s*\(/g,
  "importScripts": /importScripts\s*\(/g,
  "sendBeacon": /sendBeacon\s*\(/g,
  "document.write": /document\.write\s*\(/g,
  "creates a <style> element (needs style-src 'unsafe-inline', allowed today: Cytoscape)": /createElement\(\s*[`"']style[`"']\s*\)/g,
};

const benign = /Function\(\s*[`"']return this[`"']\s*\)/g;
const allowedHosts = new Set(["www.w3.org", "react.dev", "reactjs.org", "reactrouter.com", "react.i18next.com", "github.com", "developer.mozilla.org"]);
const foreignHosts = new Map();
for (const f of files.filter((x) => /\.(?:js|mjs)$/.test(x))) {
  const text = fs.readFileSync(f, "utf8").replace(benign, "");
  for (const [name, re] of Object.entries(probes)) {
    const n = (text.match(re) ?? []).length;
    if (n) warnings.push(`${rel(f)}: ${name} x${n}`);
  }
  for (const m of text.matchAll(/(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g)) {
    if (!allowedHosts.has(m[1])) foreignHosts.set(m[1], rel(f));
  }
}
for (const [host, file] of foreignHosts) warnings.push(`${file}: absolute URL of ${host} (fetched at runtime? connect-src/img-src allow 'self' only)`);

for (const w of warnings) console.log(`warn  ${w}`);
for (const f of failures) console.error(`FAIL  ${f}`);
console.log(`scan-dist: ${files.length} files, ${failures.length} failure(s), ${warnings.length} warning(s)`);
process.exit(failures.length ? 1 : 0);
