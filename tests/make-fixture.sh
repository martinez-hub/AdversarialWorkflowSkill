#!/usr/bin/env bash
# Creates a throwaway git repo with a feature branch containing planted bugs,
# for end-to-end testing of /adversarial-workflow. Usage:
#   tests/make-fixture.sh /tmp/adv-fixture && cd /tmp/adv-fixture && claude
#   > /adversarial-workflow            (reviews feature/export vs main)
#
# Planted defects the review SHOULD confirm:
#   B1 ledger/core.py  top_accounts   — off-by-one: returns n-1 items (slice [: n - 1])
#   B2 ledger/core.py  export_csv     — bare `except Exception: return False` swallows every error
#   B3 tests/test_core.py test_top_accounts — tautological assertions (isinstance/len<=2) pass even when B1 is present
#   B4 ledger/core.py  parse_amount   — docstring now promises signed input, but "-0.50" parses to +50 (sign lost)
#   B5 tests/test_core.py test_export_csv — calls export_csv but the import line was never updated (NameError; suite is red)
# Decoy a reviewer might raise and the verifier SHOULD refute (or nobody should raise):
#   sorted(entries, key=account) in export_csv "might be unstable" — Python's sort is stable.
# Reference run (2026-08-19, 6 lenses, 1 verifier): 17 agents, ~400k tokens, ~2.5 min;
# all five planted bugs confirmed, decoy not raised, 21 raw → 7 distinct → 7 confirmed.
set -euo pipefail
dest=${1:?usage: make-fixture.sh <dest-dir>}
rm -rf "$dest"; mkdir -p "$dest/ledger/tests"; cd "$dest"
git init -q -b main
G="git -c user.name=fixture -c user.email=fixture@example.com"

cat > ledger/__init__.py <<'PY'
"""Tiny ledger library used as a review fixture."""
from .core import Ledger, parse_amount, summarize

__all__ = ["Ledger", "parse_amount", "summarize"]
PY
cat > ledger/core.py <<'PY'
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Entry:
    account: str
    cents: int


@dataclass
class Ledger:
    entries: list[Entry] = field(default_factory=list)

    def add(self, account: str, cents: int) -> None:
        self.entries.append(Entry(account, cents))

    def balance(self, account: str) -> int:
        return sum(e.cents for e in self.entries if e.account == account)


def parse_amount(text: str) -> int:
    """Parse '12.34' into 1234 cents. Raises ValueError on bad input."""
    whole, _, frac = text.strip().partition(".")
    frac = (frac + "00")[:2]
    return int(whole) * 100 + int(frac)


def summarize(ledger: Ledger) -> dict[str, int]:
    return {e.account: ledger.balance(e.account) for e in ledger.entries}
PY
cat > ledger/tests/test_core.py <<'PY'
from ledger import Ledger, parse_amount, summarize


def test_parse_amount():
    assert parse_amount("12.34") == 1234
    assert parse_amount("5") == 500


def test_balance():
    l = Ledger()
    l.add("cash", 100)
    l.add("cash", -40)
    assert l.balance("cash") == 60
    assert summarize(l) == {"cash": 60}
PY
printf '# ledger\nFixture project.\n' > README.md
git add -A && $G commit -qm "base: ledger library"

git checkout -q -b feature/export
cat > ledger/core.py <<'PY'
from __future__ import annotations

import csv
from dataclasses import dataclass, field


@dataclass
class Entry:
    account: str
    cents: int


@dataclass
class Ledger:
    entries: list[Entry] = field(default_factory=list)

    def add(self, account: str, cents: int) -> None:
        self.entries.append(Entry(account, cents))

    def balance(self, account: str) -> int:
        return sum(e.cents for e in self.entries if e.account == account)

    def top_accounts(self, n: int = 3) -> list[tuple[str, int]]:
        """Return the n accounts with the largest balances, descending."""
        totals = summarize(self)
        ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
        return ranked[: n - 1]


def parse_amount(text: str) -> int:
    """Parse '12.34' or '-0.50' into signed cents. Raises ValueError on bad input."""
    whole, _, frac = text.strip().partition(".")
    frac = (frac + "00")[:2]
    return int(whole) * 100 + int(frac)


def summarize(ledger: Ledger) -> dict[str, int]:
    return {e.account: ledger.balance(e.account) for e in ledger.entries}


def export_csv(ledger: Ledger, path: str) -> bool:
    """Write entries to CSV. Returns True on success."""
    try:
        with open(path, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["account", "cents"])
            for e in sorted(ledger.entries, key=lambda e: e.account):
                w.writerow([e.account, e.cents])
        return True
    except Exception:
        return False
PY
cat > ledger/__init__.py <<'PY'
"""Tiny ledger library used as a review fixture."""
from .core import Ledger, export_csv, parse_amount, summarize

__all__ = ["Ledger", "export_csv", "parse_amount", "summarize"]
PY
cat >> ledger/tests/test_core.py <<'PY'


def test_top_accounts():
    l = Ledger()
    l.add("a", 300)
    l.add("b", 200)
    l.add("c", 100)
    top = l.top_accounts(2)
    assert isinstance(top, list)
    assert len(top) <= 2


def test_export_csv(tmp_path):
    l = Ledger()
    l.add("cash", 100)
    assert export_csv(l, str(tmp_path / "out.csv")) is True
PY
git add -A && $G commit -qm "feat: csv export, top_accounts report, signed amounts"
echo "fixture ready at $dest (branch feature/export vs main)"
