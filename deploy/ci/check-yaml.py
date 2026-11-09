#!/usr/bin/env python3
"""Static consistency checks for the deployment parts of ProcessPoll (no Docker, no Caddy needed).

Run from anywhere:  python deploy/ci/check-yaml.py      (needs PyYAML: pip install pyyaml)

What is checked, against the REAL files of the repository:

* syntax of .gitlab-ci.yml, renovate.json, compose files, licence allowlist (GitLab ``!reference`` and
  Compose ``!override`` / ``!reset`` tags are understood);
* GitLab CI: stages, ``extends`` chains, ``needs``, literal image tags, Playwright image tag == locked
  ``@playwright/test`` version, ``npm run <script>`` names exist in frontend/package.json;
* compose.yml: required services, only the proxy publishes ports, restart/healthcheck, every
  ``${VARIABLE}`` is documented in deploy/.env.example, PROCESSPOLL_* names are real settings;
* Caddyfile: SSE matcher matches the backend stream route (and nothing else), only /api/* and /healthz are
  proxied (not /metrics, /docs), body limit >= backend limit, CSP sane, no access log, loopback admin;
* Dockerfiles: COPY sources exist and are not removed by the per-Dockerfile .dockerignore;
* docs: every PROCESSPOLL_* / LT_* name used anywhere is a real setting, relative Markdown links resolve.

Exit code 0 = all fine, 1 = findings (printed).
"""
from __future__ import annotations

import ast
import fnmatch
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
errors: list[str] = []


def err(message: str) -> None:
    errors.append(message)


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


class Loader(yaml.SafeLoader):
    pass


def _passthrough(loader: Loader, tag_suffix: str, node: yaml.Node):
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    return loader.construct_scalar(node)


for _tag in ("!reference", "!override", "!reset"):
    Loader.add_multi_constructor(_tag, _passthrough)


def load_yaml(path: Path):
    with path.open(encoding="utf-8") as fh:
        return yaml.load(fh, Loader=Loader)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def backend_settings() -> tuple[set[str], int]:
    """(env names of backend/app/config.py Settings, default max_request_bytes)"""
    tree = ast.parse(read(ROOT / "backend" / "app" / "config.py"))
    names: set[str] = set()
    max_bytes = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    names.add("PROCESSPOLL_" + stmt.target.id.upper())
                    if stmt.target.id == "max_request_bytes" and stmt.value is not None:
                        max_bytes = int(eval(compile(ast.Expression(stmt.value), "<cfg>", "eval"), {"__builtins__": {}}))
    return names, max_bytes


EXTRA_ENV = {"PROCESSPOLL_RUN_MIGRATIONS", "PROCESSPOLL_TEST_DATABASE_URL"}


def stream_route() -> str:
    """Path of the SSE route as defined in backend/app/routes.py (prefix included)."""
    text = read(ROOT / "backend" / "app" / "routes.py")
    prefix = re.search(r'APIRouter\([^)]*?prefix="([^"]+)"', text, flags=re.S)
    route = re.search(r'@router\.get\(\s*"(/sessions/\{code\}/stream)"', text)
    if not prefix or not route:
        err("routes.py: cannot find the stream route / router prefix")
        return "/api/v1/sessions/{code}/stream"
    return prefix.group(1) + route.group(1)


def check_ci(ci: dict) -> None:
    stages = set(ci.get("stages", []))
    templates = {k: v for k, v in ci.items() if k.startswith(".") and isinstance(v, dict)}
    reserved = {"workflow", "default", "variables", "stages", "include"}
    jobs = {k: v for k, v in ci.items() if isinstance(v, dict) and not k.startswith(".") and k not in reserved}

    def resolve(name: str, seen: tuple[str, ...] = ()) -> dict:
        item = jobs.get(name) or templates.get(name) or {}
        merged: dict = {}
        parents = item.get("extends", [])
        for parent in [parents] if isinstance(parents, str) else parents:
            if parent not in templates:
                err(f".gitlab-ci.yml: {name} extends unknown template {parent}")
                continue
            if parent in seen:
                err(f".gitlab-ci.yml: extends cycle at {parent}")
                continue
            merged.update(resolve(parent, (*seen, name)))
        merged.update({k: v for k, v in item.items() if k != "extends"})
        return merged

    default_image = (ci.get("default") or {}).get("image")
    for name, job in jobs.items():
        full = resolve(name)
        if full.get("stage") not in stages:
            err(f".gitlab-ci.yml: job {name}: stage {full.get('stage')!r} not in stages")
        if "script" not in full and "trigger" not in full:
            err(f".gitlab-ci.yml: job {name}: no script")
        image = full.get("image") or default_image
        if not image and not full.get("tags"):
            err(f".gitlab-ci.yml: job {name}: no image")
        for ref in [image, *[(s.get("name") if isinstance(s, dict) else s) for s in full.get("services", [])]]:
            if isinstance(ref, str) and "$" in ref:
                err(f".gitlab-ci.yml: job {name}: image {ref!r} uses a variable (Renovate cannot update it)")
        for need in job.get("needs", []) or []:
            needed = need["job"] if isinstance(need, dict) else need
            if needed not in jobs:
                err(f".gitlab-ci.yml: job {name} needs unknown job {needed}")
    print(f"ok   .gitlab-ci.yml: {len(jobs)} jobs, {len(templates)} templates")


    lock = json.loads(read(ROOT / "frontend" / "package-lock.json"))
    locked = lock["packages"].get("node_modules/@playwright/test", {}).get("version")
    image = resolve("e2e").get("image", "")
    m = re.search(r"playwright:v(\d+\.\d+\.\d+)-", image)
    if not m:
        err(f".gitlab-ci.yml: e2e image {image!r} is not mcr.microsoft.com/playwright:vX.Y.Z-<os>")
    elif m.group(1) != locked:
        err(f".gitlab-ci.yml: e2e image is Playwright {m.group(1)} but frontend/package-lock.json locks @playwright/test {locked}")
    else:
        print(f"ok   Playwright image {m.group(1)} == locked @playwright/test")


def check_npm_scripts() -> None:
    scripts = set(json.loads(read(ROOT / "frontend" / "package.json")).get("scripts", {}))
    files = [ROOT / ".gitlab-ci.yml", *ROOT.rglob("README.md")]
    files = [p for p in files if p.exists() and not {"node_modules", ".venv", ".pytest_cache"}.intersection(p.parts)]
    for path in files:
        for m in re.finditer(r"npm run ([A-Za-z0-9:_-]+)", read(path)):
            if m.group(1) not in scripts:
                err(f"{rel(path)}: `npm run {m.group(1)}` is not a script in frontend/package.json ({sorted(scripts)})")
    print(f"ok   npm scripts referenced in READMEs/CI exist ({len(scripts)} scripts)")


def check_compose(compose: dict, valid_env: set[str]) -> None:
    services = compose.get("services", {})
    for required in ("proxy", "backend", "postgres"):
        if required not in services:
            err(f"compose.yml: service {required} missing")
    published = [n for n, s in services.items() if s.get("ports")]
    if published != ["proxy"]:
        err(f"compose.yml: only the proxy may publish ports, found {published}")
    for name, svc in services.items():
        if "restart" not in svc:
            err(f"compose.yml: service {name} has no restart policy")
        if "healthcheck" not in svc and name != "backup":
            err(f"compose.yml: service {name} has no healthcheck")
    for name, net in (compose.get("networks") or {}).items():
        if name == "internal" and not (net or {}).get("internal"):
            err("compose.yml: network `internal` must be internal: true")
    backend_env = services.get("backend", {}).get("environment", {}) or {}
    for key in backend_env:
        if key.startswith("PROCESSPOLL_") and key not in valid_env:
            err(f"compose.yml: backend environment {key} is not a setting of backend/app/config.py")
    for key, value in {"PROCESSPOLL_ENV": "prod", "PROCESSPOLL_TRUSTED_PROXY": "true"}.items():
        if str(backend_env.get(key)).lower() != value:
            err(f"compose.yml: backend must set {key}={value}")
    if not str(backend_env.get("PROCESSPOLL_DATABASE_URL", "")).startswith("postgresql+asyncpg://"):
        err("compose.yml: PROCESSPOLL_DATABASE_URL must use the postgresql+asyncpg:// scheme")

    env_example = read(ROOT / "deploy" / ".env.example")
    documented = set(re.findall(r"^[# ]*([A-Z][A-Z0-9_]+)=", env_example, flags=re.M))
    text = read(ROOT / "deploy" / "compose.yml")
    for var in sorted(set(re.findall(r"(?<!\$)\$\{([A-Z][A-Z0-9_]*)", text))):
        if var not in documented:
            err(f"deploy/.env.example: compose.yml uses ${{{var}}} but .env.example does not document it")
    for var in sorted(documented):
        if var.startswith("PROCESSPOLL_") and var not in valid_env:
            err(f"deploy/.env.example: {var} is not a setting of backend/app/config.py")
    print(f"ok   compose.yml: services {sorted(services)}; {len(documented)} variables documented in .env.example")


UNITS = {"b": 1, "kb": 1000, "kib": 1024, "mb": 1000**2, "mib": 1024**2}


def check_caddyfile(backend_max_bytes: int) -> None:
    text = read(ROOT / "deploy" / "Caddyfile")
    code_lines = [ln for ln in text.splitlines() if not ln.strip().startswith("#")]
    body = "\n".join(code_lines)
    site_start = body.index("{$SITE_ADDRESS")
    global_block, site_block = body[:site_start], body[site_start:]


    m = re.search(r"@sse\s+path_regexp\s+(\S+)", body)
    if not m:
        err("Caddyfile: no @sse path_regexp matcher")
    else:
        pattern = re.compile(m.group(1))
        stream = stream_route().replace("{code}", "MORN-24")
        if not pattern.search(stream):
            err(f"Caddyfile: @sse regex {m.group(1)} does not match the backend route {stream}")
        for other in ("/api/v1/sessions/MORN-24/analytics", "/api/v1/sessions/MORN-24/stream/x", "/api/v1/sessions/stream", "/api/v1/sessions/a/b/stream"):
            if pattern.search(other):
                err(f"Caddyfile: @sse regex matches {other}, which is not the stream route")
    if "handle @sse" in site_block and "handle @api" in site_block and site_block.index("handle @sse") > site_block.index("handle @api"):
        err("Caddyfile: `handle @sse` must come before `handle @api` (handle blocks with named matchers keep their order; /api/* would swallow the stream URL)")
    if "flush_interval -1" not in site_block:
        err("Caddyfile: SSE handler needs `flush_interval -1`")
    sse_handler = re.search(r"handle @sse \{(.*?)\n\t\}\n", site_block, flags=re.S)
    if sse_handler and "encode" in sse_handler.group(1):
        err("Caddyfile: the SSE handler must not compress (`encode`)")


    m = re.search(r"@api\s+path\s+(.+)", body)
    if not m:
        err("Caddyfile: no @api path matcher")
    else:
        patterns = m.group(1).split()
        for path, expected in (("/api/v1/sessions", True), ("/healthz", True), ("/metrics", False), ("/docs", False), ("/openapi.json", False), ("/apix", False)):
            hit = any(fnmatch.fnmatchcase(path, p) for p in patterns)
            if hit != expected:
                err(f"Caddyfile: @api {patterns} {'does not forward' if expected else 'must not forward'} {path}")


    m = re.search(r"max_size\s+(\d+)\s*([A-Za-z]*)", site_block)
    if not m:
        err("Caddyfile: no request_body max_size")
    else:
        unit = UNITS.get(m.group(2).lower() or "b")
        if unit is None:
            err(f"Caddyfile: unknown size unit {m.group(2)!r}")
        elif int(m.group(1)) * unit < backend_max_bytes:
            err(f"Caddyfile: request_body max_size {m.group(0)} is below the backend limit of {backend_max_bytes} bytes")


    if re.search(r"^\s*log\b", site_block, flags=re.M):
        err("Caddyfile: the site block must not contain a `log` directive (no access log)")
    if "request>remote_ip delete" not in global_block:
        err("Caddyfile: the runtime log must delete request>remote_ip")
    if not re.search(r"^\s*admin\s+(127\.0\.0\.1|localhost|\[::1\]):\d+", global_block, flags=re.M):
        err("Caddyfile: the admin API must listen on the loopback interface")


    m = re.search(r'^\s*Content-Security-Policy\s+"([^"]+)"', body, flags=re.M)
    if not m:
        err("Caddyfile: no Content-Security-Policy header")
    else:
        csp = {part.split()[0]: part.split()[1:] for part in (p.strip() for p in m.group(1).split(";")) if part}
        for directive in ("default-src", "script-src", "object-src", "frame-ancestors", "base-uri"):
            if directive not in csp:
                err(f"Caddyfile: CSP lacks {directive}")
        if "'unsafe-inline'" in csp.get("script-src", []) or "'unsafe-eval'" in csp.get("script-src", []):
            err("Caddyfile: CSP script-src must not allow 'unsafe-inline' / 'unsafe-eval'")
        if any(re.match(r"https?:|wss?:|\*", v) for values in csp.values() for v in values):
            err("Caddyfile: CSP names an external origin (the app loads nothing from third parties)")
        if csp.get("frame-ancestors") != ["'none'"]:
            err("Caddyfile: CSP frame-ancestors must be 'none'")
    if "Strict-Transport-Security" not in body:
        err("Caddyfile: no HSTS header")
    print("ok   Caddyfile: routes, SSE matcher, body limit, CSP, logging")


def dockerignore_regex(pattern: str) -> re.Pattern[str]:
    pattern = pattern.strip("/")
    out = ""
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        elif pattern[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile(f"^{out}$")


def ignored(path: str, patterns: list[tuple[bool, re.Pattern[str]]]) -> bool:
    """Docker semantics: the last matching pattern wins; a pattern matches a path or one of its parents."""
    parts = path.split("/")
    candidates = ["/".join(parts[: i + 1]) for i in range(len(parts))]
    result = False
    for negate, regex in patterns:
        if any(regex.match(c) for c in candidates):
            result = not negate
    return result


EXPECT = {
    "Dockerfile.backend": (
        ["backend/pyproject.toml", "backend/app/main.py", "backend/app/__init__.py", "backend/alembic.ini",
         "backend/alembic/env.py", "backend/alembic/versions/0001_initial.py", "deploy/entrypoint.sh"],
        ["backend/.venv/pyvenv.cfg", "backend/tests/conftest.py", "backend/app/__pycache__/main.cpython-312.pyc", "backend/x.db", "backend/.env"],
    ),
    "Dockerfile.proxy": (
        ["frontend/package.json", "frontend/package-lock.json", "frontend/index.html", "frontend/src/main.tsx",
         "frontend/vite.config.ts", "frontend/tsconfig.json", "deploy/Caddyfile"],
        ["frontend/node_modules/react/index.js", "frontend/dist/index.html", "frontend/.env.local"],
    ),
}


def check_dockerfiles() -> None:
    for dockerfile in sorted((ROOT / "deploy").glob("Dockerfile.*")):
        if dockerfile.name.endswith(".dockerignore"):
            continue
        text = read(dockerfile)
        ignore_file = dockerfile.with_name(dockerfile.name + ".dockerignore")
        patterns: list[tuple[bool, re.Pattern[str]]] = []
        if not ignore_file.exists():
            err(f"{rel(dockerfile)}: no {ignore_file.name} (BuildKit reads <Dockerfile>.dockerignore next to the Dockerfile)")
        else:
            for line in read(ignore_file).splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    negate = line.startswith("!")
                    patterns.append((negate, dockerignore_regex(line.lstrip("!"))))

        for m in re.finditer(r"^(?:COPY|ADD)\s+(.*)$", text, flags=re.M):
            tokens = m.group(1).split()
            flags = [t for t in tokens if t.startswith("--")]
            args = [t for t in tokens if not t.startswith("--")]
            if any(f.startswith("--from") for f in flags):
                continue
            for source in args[:-1]:
                src = ROOT / source.rstrip("/")
                if not src.exists():
                    err(f"{rel(dockerfile)}: COPY source {source} does not exist")
                    continue
                files = [src] if src.is_file() else [p for p in src.rglob("*") if p.is_file()]
                kept = [p for p in files if not ignored(rel(p), patterns)]
                if files and not kept:
                    err(f"{rel(dockerfile)}: COPY source {source} is completely removed by {ignore_file.name}")
        must_keep, must_drop = EXPECT.get(dockerfile.name, ([], []))
        for path in must_keep:
            if not (ROOT / path).exists():
                err(f"{rel(dockerfile)}: expected build file {path} does not exist")
            elif ignored(path, patterns):
                err(f"{ignore_file.name}: removes {path}, which the image build needs")
        for path in must_drop:
            if not ignored(path, patterns):
                err(f"{ignore_file.name}: should exclude {path}")
        for m in re.finditer(r"^FROM\s+(\S+)", text, flags=re.M):
            if m.group(1).count(":") == 0 and "${" not in m.group(1) and m.group(1) not in {"scratch"} and not re.search(r"AS\s", m.group(0)):
                err(f"{rel(dockerfile)}: FROM {m.group(1)} has no tag")
    print("ok   Dockerfiles: COPY sources exist and survive their .dockerignore")


def text_files() -> list[Path]:
    files = [ROOT / ".gitlab-ci.yml", *ROOT.rglob("README.md")]
    files = [p for p in files if not {"node_modules", ".venv", ".pytest_cache"}.intersection(p.parts)]
    files += list((ROOT / "docs").glob("*.md")) if (ROOT / "docs").exists() else []
    files += [p for p in (ROOT / "deploy").rglob("*") if p.is_file() and p.suffix in {".md", ".yml", ".sh", ".service", ".timer", ""} and "/.deploy/" not in p.as_posix()]
    return [p for p in files if p.exists() and p.name != "check-yaml.py"]


def check_env_names(valid_env: set[str]) -> None:
    allowed = valid_env | EXTRA_ENV
    for path in text_files():
        for token in sorted(set(re.findall(r"PROCESSPOLL_[A-Z0-9_]+", read(path)))):
            if not token.endswith("_") and token not in allowed:
                err(f"{rel(path)}: {token} is not a setting of backend/app/config.py (valid: {sorted(allowed)})")
    print("ok   PROCESSPOLL_* names in project/deploy files are real settings")


def check_loadtest_env() -> None:
    code = set(re.findall(r'_env\("(LT_[A-Z0-9_]+)"', read(ROOT / "loadtest" / "locustfile.py")))
    readme = read(ROOT / "loadtest" / "README.md")
    documented = set(re.findall(r"`(LT_[A-Z0-9_]+)`", readme)) | set(re.findall(r"\b(LT_[A-Z0-9_]+)=", readme))
    for name in sorted(code - documented):
        err(f"loadtest/README.md: {name} is read by locustfile.py but not documented")
    for name in sorted(documented - code):
        err(f"loadtest/README.md: {name} is documented but locustfile.py does not read it")
    print(f"ok   loadtest/README.md documents all {len(code)} LT_* variables")


LINK = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


def check_markdown_links() -> None:
    count = 0
    for path in text_files():
        if path.suffix != ".md":
            continue
        for target in LINK.findall(read(path)):
            if re.match(r"[a-z]+:", target) or target.startswith("#"):
                continue
            count += 1
            clean = target.split("#", 1)[0]
            if clean and not (path.parent / clean).exists():
                err(f"{rel(path)}: broken link {target}")
    print(f"ok   {count} relative Markdown links resolve")


def main() -> int:
    targets = [
        ROOT / ".gitlab-ci.yml",
        ROOT / "renovate.json",
        ROOT / "deploy" / "compose.yml",
        ROOT / "deploy" / "compose.build.yml",
        ROOT / "deploy" / "compose.dev.yml",
        ROOT / "deploy" / "license-allowlist.json",
    ]
    docs: dict[str, object] = {}
    for path in targets:
        if not path.exists():
            err(f"missing: {rel(path)}")
            continue
        try:
            docs[path.name] = json.loads(read(path)) if path.suffix == ".json" else load_yaml(path)
            print(f"ok   {rel(path)}")
        except Exception as exc:
            err(f"{rel(path)}: {exc}")

    valid_env, backend_max_bytes = backend_settings()
    if isinstance(docs.get(".gitlab-ci.yml"), dict):
        check_ci(docs[".gitlab-ci.yml"])
    check_npm_scripts()
    if isinstance(docs.get("compose.yml"), dict):
        check_compose(docs["compose.yml"], valid_env)
    check_caddyfile(backend_max_bytes)
    check_dockerfiles()
    check_env_names(valid_env)
    check_loadtest_env()
    check_markdown_links()

    if errors:
        print("\nERRORS:", *errors, sep="\n  - ")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
