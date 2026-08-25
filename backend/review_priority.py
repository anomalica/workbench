"""What to read next.

Mark's attention is now the only route into the graph: unreviewed content is not
digested at all, so every record passes through him. That makes the ORDER he
reads in the highest-leverage thing the workbench decides, and a flat list of
180 unreviewed records decides it badly - the cheapest is a 69-word news piece
and the dearest is a 90-hour book, and nothing on the list says which is which.

Three inputs, and they answer different questions:

  READING COST - what it takes from him. Content units, annotations stripped, at
  a careful reading pace. This is the input with the widest spread and therefore
  the one that moves the ordering most.

  REACH - what digesting it pays back. A record that names entities which
  already earn pages adds claims to pages that exist; one about entities nobody
  else covers creates thin new nodes. The former is worth more while assembly is
  filling gaps in the published corpus.

  HOUSEKEEPING - whether it is ready to be read at all. A record whose
  frontmatter is wrong produces badly-attributed claims however good the
  extraction, so an open housekeeping proposal means "not yet", not "worth less".
  It gates rather than scores.

The score is reach per minute, because that is the question actually being
asked: for the next half hour of his attention, which records pay back most.
Ranking on reach alone would put a 90-hour book above ten news pieces that
between them touch more pages.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

# A careful read, not a skim. The absolute figure matters less than that it is
# applied identically to every record - the ordering is what is being computed,
# and it is unchanged by the rate.
WORDS_PER_MINUTE = 220

# Below this, a term is too short to be evidence that a record is ABOUT the
# thing rather than merely containing the letters.
MIN_TERM_LENGTH = 4

# Terms that name a real entity but are written so often in passing that a match
# says nothing about what a record covers.
GENERIC_TERMS = frozenset(
    {
        "united states",
        "the phenomenon",
        "congress",
        "navy",
        "air force",
        "army",
        "department",
        "government",
        "project",
        "program",
        "programme",
        "committee",
        "office",
        "agency",
        "science",
        "military",
        "witness",
    }
)


def _initials(text: str) -> str:
    return "".join(
        word[0] for word in re.findall(r"[A-Za-z][\w'’-]*", text) if word[0].isupper()
    ).upper()


def _is_acronym(outer: str, inner: str) -> bool:
    """Whether `(inner)` abbreviates `outer` rather than disambiguating it."""
    if len(inner) < 2:
        return False
    if inner.upper() == _initials(outer):
        return True
    # `(DoD)`, `(Caltech)`, `(MKUltra)` do not match their initials but are
    # plainly what people write instead of the full name: a single capitalised
    # token. The test is capitalisation rather than a count of capitals, which
    # would have failed `Caltech` on its one. Lowercase parentheticals are
    # descriptions - `(magazine)`, `(type)`, `(alleged)` - and a leading digit
    # marks a date or a year, which disambiguates rather than abbreviates.
    return " " not in inner and inner[0].isupper()


def match_terms(name: str) -> set[str]:
    """The strings whose presence in a record means it is about this node.

    A parenthetical is either an ACRONYM or a DISAMBIGUATOR, and the two need
    opposite treatment - the distinction this project had to draw for speaker
    names, arriving here as a matching problem.

    `United States Navy (USN)` may be matched by either half: both name the
    thing. `Science (magazine)` may NOT be matched by its bare outer name -
    the parenthetical exists precisely because `Science` alone does not
    identify it, so matching the bare word would score every record that
    mentions science at all. Treating both alike is how a ranking quietly
    fills with noise while still looking plausible.

    A disambiguated name still contributes its outer form when that form is
    distinctive on its own (`Roswell incident (1947)`, `Nordic alien (type)`) -
    the risk is a single common word, not a parenthetical as such.
    """
    name = name.strip()
    matched = re.match(r"^(.*?)\s*\(([^)]+)\)\s*$", name)
    if not matched:
        return {name}

    outer, inner = matched.group(1).strip(), matched.group(2).strip()
    if _is_acronym(outer, inner):
        return {outer, inner}

    terms = {name}
    # Multi-word or long outer names identify on their own; a single short word
    # is exactly the case the parenthetical was added to resolve.
    if " " in outer or len(outer) >= 12:
        terms.add(outer)
    return terms


def usable_terms(terms: set[str]) -> set[str]:
    return {
        t for t in terms if len(t) >= MIN_TERM_LENGTH and t.lower() not in GENERIC_TERMS
    }


def reading_minutes(body: str) -> float:
    """Minutes to read a record's content, annotations and comments removed.

    What is stripped is what a reviewer does not read: `{{t:...}}` timestamps,
    highlight and note markers, and the HTML comments carrying speaker turns and
    structure. Leaving them in made a per-word transcript look several times
    longer than the prose a human actually passes their eyes over.
    """
    clean = re.sub(r"\{\{[^}]*\}\}", " ", body)
    clean = re.sub(r"<!--.*?-->", " ", clean, flags=re.S)
    words = len(clean.split())
    # A floor, so a near-empty record cannot divide its way to the top.
    return max(words / WORDS_PER_MINUTE, 0.2)


# Words as the matcher sees them. Hyphens and apostrophes stay inside a token so
# `CVW-11` and `O'Neill` survive; everything else separates.
_TOKEN = re.compile(r"[A-Za-z0-9][\w'’-]*")


def tokenise(text: str) -> list[str]:
    return _TOKEN.findall(text)


@dataclass
class PageWorthy:
    """The nodes that already earn a page, and how to spot them in text.

    Matching is a token index rather than one big alternation. A compiled
    alternation over ~1,500 terms is correct but took over two minutes across
    the store - unusable for a view somebody opens - because the engine tries
    the branches at every position. Indexing terms by their first token turns
    that into one dictionary lookup per word of the record, and only the
    handful of terms starting with that word are ever compared.
    """

    # first token -> the term token-tuples starting with it, longest first
    by_first: dict[str, list[tuple[tuple[str, ...], str]]] = field(default_factory=dict)
    node_name: dict[str, str] = field(default_factory=dict)
    high_bar: set[str] = field(default_factory=set)
    term_count: int = 0

    @property
    def available(self) -> bool:
        """Whether there is a graph behind this at all. `no graph` and `nothing
        matched` are different answers and only the second is a finding."""
        return bool(self.by_first)

    def reach(self, text: str) -> list[str]:
        """Distinct page-worthy nodes this text names, most-mentioned first.

        Distinct, not total: a record repeating one name forty times has the
        reach of one node, and counting mentions would rank a monologue above a
        survey that touches five pages.
        """
        if not self.by_first:
            return []
        words = tokenise(text)
        counts: dict[str, int] = {}
        for i, word in enumerate(words):
            candidates = self.by_first.get(word)
            if not candidates:
                continue
            for tokens, node_id in candidates:
                # Longest first, so `United States Navy` is credited rather
                # than a shorter term that happens to start at the same word.
                if words[i : i + len(tokens)] == list(tokens):
                    counts[node_id] = counts.get(node_id, 0) + 1
                    break
        return sorted(counts, key=lambda n: -counts[n])


def build_matcher(
    nodes: list[tuple[str, str, str]], aliases: dict[str, list[str]] | None = None
) -> PageWorthy:
    """Build the matcher from `(node_id, name, tier)` rows."""
    aliases = aliases or {}
    by_first: dict[str, list[tuple[tuple[str, ...], str]]] = {}
    node_name: dict[str, str] = {}
    high_bar: set[str] = set()
    seen: set[tuple[str, ...]] = set()

    for node_id, name, tier in nodes:
        node_name[node_id] = name
        if tier == "high-bar":
            high_bar.add(node_id)
        terms = match_terms(name)
        for alias in aliases.get(node_id, []):
            terms |= match_terms(alias)
        for term in usable_terms(terms):
            tokens = tuple(tokenise(term))
            if not tokens or tokens in seen:
                # First writer wins, so a term shared by two nodes attaches to
                # the one seen first rather than flickering between them.
                continue
            seen.add(tokens)
            by_first.setdefault(tokens[0], []).append((tokens, node_id))

    for bucket in by_first.values():
        bucket.sort(key=lambda pair: -len(pair[0]))
    return PageWorthy(by_first, node_name, high_bar, term_count=len(seen))


def graph_db_path() -> Path:
    return Path(
        os.environ.get(
            "GRAPH_DB_PATH",
            str(Path.home() / ".local" / "share" / "assimilator" / "knowledge.db"),
        )
    )


def load_page_worthy(db_path: Path | None = None) -> PageWorthy:
    """Build the matcher from the graph's page proposals.

    Only the ~650 page-worthy nodes, not all ~10,000: the question is whether
    digesting a record feeds pages that exist, so a node nobody would publish
    is not payoff. It is also fifteen times less matching, which is why this can
    run over the whole store on request rather than as a batch job.

    A missing or unreadable database is not an error - the deployed workbench
    has no graph - so the matcher comes back empty and the ranking falls back to
    reading cost alone.
    """
    path = db_path or graph_db_path()
    if not path.exists():
        return PageWorthy()
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return PageWorthy()
    try:
        rows = con.execute(
            """
            select n.id, n.name, p.tier
            from page_proposals p join nodes n on n.id = p.node_id
            where n.retired_at is null
            """
        ).fetchall()
        aliases: dict[str, list[str]] = {}
        for alias, node_id in con.execute("select alias, node_id from aliases"):
            aliases.setdefault(node_id, []).append(alias)
    except sqlite3.Error:
        # A schema older or newer than this query expects: degrade to
        # reading-cost ranking rather than failing the whole queue.
        return PageWorthy()
    finally:
        con.close()

    return build_matcher(rows, aliases)


def open_housekeeping(sidecar: dict | None) -> int:
    """How many housekeeping proposals are still undecided.

    Non-zero means the record's own metadata is disputed, so reading it now
    risks signing off content whose publisher, date or speakers are about to
    change underneath the review.
    """
    if not sidecar:
        return 0
    items = sidecar.get("items")
    if not isinstance(items, list):
        return 0
    return sum(
        1
        for item in items
        if isinstance(item, dict) and item.get("status") == "proposed"
    )


@dataclass
class Priority:
    content_hash: str
    minutes: float
    reach: int
    high_bar: int
    housekeeping_open: int
    unlocks: list[str]

    @property
    def score(self) -> float:
        """Pages reached per minute of reading, zero while housekeeping is open.

        Zero rather than a penalty: an open proposal is a statement that the
        record is not ready to be read, and a record that is not ready should
        not appear near the top however cheap it is.
        """
        if self.housekeeping_open:
            return 0.0
        return self.reach / self.minutes

    def as_dict(self) -> dict:
        return {
            "content_hash": self.content_hash,
            "minutes": round(self.minutes, 1),
            "reach": self.reach,
            "high_bar": self.high_bar,
            "housekeeping_open": self.housekeeping_open,
            "unlocks": self.unlocks,
            "score": round(self.score, 3),
        }


def rank(
    records: list[tuple[str, str]],
    page_worthy: PageWorthy,
    sidecars: dict[str, dict | None],
    unlocks_shown: int = 3,
) -> list[Priority]:
    """Rank `(content_hash, body)` pairs, best value for attention first."""
    out: list[Priority] = []
    for content_hash, body in records:
        reached = page_worthy.reach(body)
        out.append(
            Priority(
                content_hash=content_hash,
                minutes=reading_minutes(body),
                reach=len(reached),
                high_bar=sum(1 for n in reached if n in page_worthy.high_bar),
                housekeeping_open=open_housekeeping(sidecars.get(content_hash)),
                unlocks=[page_worthy.node_name[n] for n in reached[:unlocks_shown]],
            )
        )
    # Cheapest first among equals, so a tie between two records with no reach
    # still orders usefully rather than arbitrarily.
    out.sort(key=lambda p: (-p.score, p.minutes))
    return out


def load_sidecar(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None
