#!/usr/bin/env python3
"""Licence gate for ProcessPoll dependencies (pure standard library).

Reads the JSON output of ``pip-licenses`` (Python) or ``license-checker`` /
``license-checker-rseidelsohn`` (Node), compares every package with the
allowlist in ``deploy/license-allowlist.json`` and exits non-zero when a
package has a licence that is not allowed (denied copyleft, or unknown).

Examples::

    pip-licenses --format=json --from=mixed > py-licenses.json
    python deploy/license_check.py --kind python --input py-licenses.json

    npx license-checker-rseidelsohn --json --production > node-licenses.json
    python deploy/license_check.py --kind node --input node-licenses.json

    python deploy/license_check.py --selftest

Licence expressions
-------------------
``A OR B`` passes if one alternative is allowed, ``A AND B`` and ``;`` (pip-licenses
joins several classifiers with ``;``) require all parts to be allowed, ``/`` is
treated like ``OR``. Parentheses are supported. A trailing ``*`` (license-checker
"guessed from README") is ignored. If an expression cannot be parsed the whole
string is treated as one name.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
from pathlib import Path
from typing import Any

DEFAULT_ALLOWLIST = Path(__file__).with_name("license-allowlist.json")
_SPLIT_RE = re.compile(r"(\(|\)|;|/|\s+OR\s+|\s+AND\s+)", re.IGNORECASE)


class Policy:
    def __init__(self, data: dict[str, Any]) -> None:
        self.allowed = {s.lower() for s in data.get("allowed_licenses", [])}
        self.denied = [s.lower() for s in data.get("denied_patterns", [])]
        self.aliases = {k.lower(): v.lower() for k, v in data.get("aliases", {}).items()}
        self.ignore = data.get("ignore_packages", {})
        self.exceptions = data.get("package_exceptions", {})


    def _normalise(self, text: str) -> str:
        key = text.strip().rstrip("*").strip().lower()
        return self.aliases.get(key, key)

    def atom_allowed(self, text: str) -> bool:
        key = self._normalise(text)
        if not key:
            return False
        if key in self.allowed:
            return True
        if " with " in key:
            base = self._normalise(key.split(" with ", 1)[0])
            return base in self.allowed
        return False

    def classify(self, text: str) -> str:
        key = text.strip().lower()
        if any(p in key for p in self.denied):
            return "denied"
        return "unknown"


    def check(self, expression: str) -> tuple[bool, list[str]]:
        """Return (ok, offending atoms)."""
        expression = (expression or "").strip()
        if not expression:
            return False, ["<empty>"]
        if self.atom_allowed(expression):
            return True, []
        try:
            tree = self._parse(expression)
        except ValueError:
            tree = ("atom", expression)
        return self._eval(tree)

    def _parse(self, expression: str):
        tokens = [t.strip() for t in _SPLIT_RE.split(expression) if t and t.strip()]
        tokens = [t.upper() if t.upper() in ("OR", "AND") else t for t in tokens]
        node, pos = self._parse_or(tokens, 0)
        if pos != len(tokens):
            raise ValueError("trailing tokens")
        return node

    def _parse_or(self, tokens, pos):
        left, pos = self._parse_and(tokens, pos)
        while pos < len(tokens) and tokens[pos] in ("OR", "/"):
            right, pos = self._parse_and(tokens, pos + 1)
            left = ("or", left, right)
        return left, pos

    def _parse_and(self, tokens, pos):
        left, pos = self._parse_atom(tokens, pos)
        while pos < len(tokens) and tokens[pos] in ("AND", ";"):
            right, pos = self._parse_atom(tokens, pos + 1)
            left = ("and", left, right)
        return left, pos

    def _parse_atom(self, tokens, pos):
        if pos >= len(tokens):
            raise ValueError("unexpected end")
        tok = tokens[pos]
        if tok == "(":
            node, pos = self._parse_or(tokens, pos + 1)
            if pos >= len(tokens) or tokens[pos] != ")":
                raise ValueError("missing )")
            return node, pos + 1
        if tok in (")", "OR", "AND", ";", "/"):
            raise ValueError(f"unexpected {tok}")
        return ("atom", tok), pos + 1

    def _eval(self, node) -> tuple[bool, list[str]]:
        kind = node[0]
        if kind == "atom":
            ok = self.atom_allowed(node[1])
            return ok, [] if ok else [node[1]]
        lok, lbad = self._eval(node[1])
        rok, rbad = self._eval(node[2])
        if kind == "or":
            return (lok or rok), ([] if (lok or rok) else lbad + rbad)
        return (lok and rok), lbad + rbad


    def ignored(self, kind: str, name: str, version: str) -> bool:
        patterns = self.ignore.get(kind, [])
        full = f"{name}@{version}"
        return any(
            fnmatch.fnmatchcase(name.lower(), p.lower()) or fnmatch.fnmatchcase(full.lower(), p.lower())
            for p in patterns
        )

    def exception_reason(self, kind: str, name: str, version: str, licence: str = "") -> str | None:
        """Reason for an accepted exception, or None.

        A key is a package name, ``name@version`` or an fnmatch pattern (``@fontsource-variable/*``).
        The value is a reason string (any licence is accepted for that package) or
        ``{"licenses": [...], "reason": "..."}`` (accepted only while the package still reports
        exactly one of these licence expressions, so a later licence change fails the gate again)."""
        table = self.exceptions.get(kind, {})
        norm = lambda s: s.lower().replace("_", "-")
        for key, entry in table.items():
            if key.startswith("_"):
                continue
            names = (norm(name), norm(f"{name}@{version}"))
            if not any(n == norm(key) or fnmatch.fnmatchcase(n, norm(key)) for n in names):
                continue
            if isinstance(entry, dict):
                allowed = {self._normalise(x) for x in entry.get("licenses", [])}
                if allowed and self._normalise(licence) not in allowed:
                    continue
                return str(entry.get("reason", "no reason given"))
            return str(entry)
        return None


def load_packages(kind: str, path: Path) -> list[tuple[str, str, str]]:
    """Return a list of (name, version, licence-expression)."""
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    packages: list[tuple[str, str, str]] = []
    if kind == "python":
        if not isinstance(raw, list):
            raise SystemExit("python input must be the JSON list written by `pip-licenses --format=json`")
        for row in raw:
            name = row.get("Name") or row.get("name") or "?"
            version = row.get("Version") or row.get("version") or ""
            lic = row.get("License") or row.get("license") or "UNKNOWN"
            packages.append((str(name), str(version), str(lic)))
    else:
        if not isinstance(raw, dict):
            raise SystemExit("node input must be the JSON object written by `license-checker --json`")
        for key, row in raw.items():
            name, _, version = key.rpartition("@")
            if not name:
                name, version = key, ""
            lic = row.get("licenses", "UNKNOWN")
            if isinstance(lic, list):
                lic = " OR ".join(str(x) for x in lic)
            packages.append((name, version, str(lic)))
    return packages


def run(kind: str, input_path: Path, allowlist: Path, warn_only: bool, allow_empty: bool) -> int:
    policy = Policy(json.loads(allowlist.read_text(encoding="utf-8")))
    packages = load_packages(kind, input_path)
    if not packages and not allow_empty:
        print(f"ERROR: no packages found in {input_path} (use --allow-empty to accept)", file=sys.stderr)
        return 2

    checked = ignored = excepted = 0
    violations: list[tuple[str, str, str, str, str]] = []
    for name, version, lic in sorted(packages, key=lambda p: p[0].lower()):
        if policy.ignored(kind, name, version):
            ignored += 1
            continue
        reason = policy.exception_reason(kind, name, version, lic)
        ok, bad = policy.check(lic)
        checked += 1
        if ok:
            continue
        if reason:
            excepted += 1
            print(f"note: {name} {version}: licence '{lic}' accepted by exception ({reason})")
            continue
        category = policy.classify(" ".join(bad) or lic)
        violations.append((category, name, version, lic, ", ".join(bad)))

    print(f"[{kind}] {len(packages)} packages: {checked} checked, {ignored} ignored, "
          f"{excepted} excepted, {len(violations)} violation(s)")
    if violations:
        print()
        print(f"{'category':<9} {'package':<40} {'version':<12} licence")
        for category, name, version, lic, bad in violations:
            print(f"{category.upper():<9} {name:<40} {version:<12} {lic}  (offending: {bad})")
        print()
        print("Fix: replace the dependency, or (after review) add it to 'package_exceptions' in "
              f"{allowlist.name} with a reason, or extend 'aliases'/'allowed_licenses'.")
        if warn_only:
            print("(--warn-only: not failing)")
            return 0
        return 1
    return 0


def selftest() -> int:
    policy = Policy(json.loads(DEFAULT_ALLOWLIST.read_text(encoding="utf-8")))
    cases = [
        ("MIT", True),
        ("MIT License", True),
        ("(MIT OR Apache-2.0)", True),
        ("MIT AND Zlib", True),
        ("BSD License; Apache Software License", True),
        ("Apache Software License; GNU General Public License v3 (GPLv3)", False),
        ("GPL-3.0-only", False),
        ("(GPL-2.0 OR MIT)", True),
        ("LGPL-3.0-or-later", False),
        ("GNU Lesser General Public License v3 (LGPLv3)", False),
        ("AGPL-3.0", False),
        ("UNKNOWN", False),
        ("UNLICENSED", False),
        ("Custom: https://example.org/license", False),
        ("MIT*", True),
        ("BSD/MIT", True),
        ("Apache-2.0 WITH LLVM-exception", True),
        ("MPL-2.0", True),
        ("", False),
        ("((MIT)", False),
    ]
    failures = 0
    for expr, expected in cases:
        ok, bad = policy.check(expr)
        status = "ok " if ok == expected else "FAIL"
        if ok != expected:
            failures += 1
        print(f"{status} {expr!r:70} -> {ok} {bad}")


    exc = Policy(
        {
            "allowed_licenses": ["MIT"],
            "package_exceptions": {
                "node": {
                    "@fonts/*": {"licenses": ["OFL-1.1"], "reason": "fonts"},
                    "plain-pkg": "any licence",
                    "Snake_Case-Pkg@1.0.0": "pinned",
                }
            },
        }
    )
    exc_cases = [
        (("@fonts/figtree", "5.3.0", "OFL-1.1"), True),
        (("@fonts/figtree", "5.3.0", "GPL-3.0"), False),
        (("@other/pkg", "1.0.0", "OFL-1.1"), False),
        (("plain-pkg", "2.0.0", "GPL-3.0"), True),
        (("snake-case-pkg", "1.0.0", "x"), True),
        (("snake-case-pkg", "1.0.1", "x"), False),
    ]
    for (name, version, lic), expected in exc_cases:
        got = exc.exception_reason("node", name, version, lic) is not None
        status = "ok " if got == expected else "FAIL"
        if got != expected:
            failures += 1
        print(f"{status} exception {name}@{version} [{lic}] -> {got}")
    print("selftest:", "passed" if failures == 0 else f"{failures} failure(s)")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kind", choices=["python", "node"])
    parser.add_argument("--input", type=Path)
    parser.add_argument("--allowlist", type=Path, default=DEFAULT_ALLOWLIST)
    parser.add_argument("--warn-only", action="store_true", help="report violations but exit 0")
    parser.add_argument("--allow-empty", action="store_true", help="accept an input without packages")
    parser.add_argument("--selftest", action="store_true", help="run the built-in expression tests")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if not args.kind or not args.input:
        parser.error("--kind and --input are required")
    return run(args.kind, args.input, args.allowlist, args.warn_only, args.allow_empty)


if __name__ == "__main__":
    sys.exit(main())
