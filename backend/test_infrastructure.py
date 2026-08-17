"""The infrastructure reader: what it surfaces and what it must never do."""

import sqlite3

import pytest

from infrastructure import claims, entities, entity, records, summary, title_keys


@pytest.fixture
def db(tmp_path):
    p = tmp_path / "infrastructure.db"
    con = sqlite3.connect(p)
    con.executescript(
        """
        CREATE TABLE records (id INTEGER PRIMARY KEY, title TEXT, content_hash TEXT);
        CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT, name TEXT);
        CREATE TABLE aliases (node_id TEXT, alias TEXT);
        CREATE TABLE claim_node_refs (claim_id INTEGER, node_id TEXT);
        CREATE TABLE claims (
          id INTEGER PRIMARY KEY, content TEXT, claim_type TEXT, attestation TEXT,
          original_excerpt TEXT, location_in_record TEXT, origin TEXT, relay TEXT,
          record_id INTEGER
        );
        INSERT INTO records VALUES (1, 'American Cosmic', 'abc123');
        INSERT INTO nodes VALUES
          ('w1','document','American Cosmic'),
          ('w2','document','Haunted Media'),
          ('w3','document','Messengers of Deception: UFO Contacts and Cults'),
          ('p1','person','Diana Walsh Pasulka'),
          ('o1','organisation','Rice University'),
          ('x1','person','Nobody Mentioned Here');
        INSERT INTO aliases VALUES ('p1','D. W. Pasulka');
        INSERT INTO claims VALUES
          (1,'American Cosmic cites Jeremy Sconce''s Haunted Media','administrative',
             '','the quote','p1','','',1),
          (2,'Pasulka describes a New Mexico donation site','testimony',
             '','the quote','p2','','',1),
          (3,'Pasulka is a professor at Rice University','administrative',
             '','the quote','p3','','',1),
          (4,'Messengers of Deception argues UFO contact is deception','opinion',
             '','the quote','p4','','',1);
        INSERT INTO claim_node_refs VALUES
          (1,'w1'),(1,'w2'),(1,'p1'),
          (2,'p1'),(2,'w1'),
          (3,'p1'),(3,'o1'),
          (4,'w3');
        """
    )
    con.commit()
    con.close()
    return p


def test_counts_are_of_what_is_connected_not_what_is_stored(db):
    s = summary(db)
    assert s["claims"] == 4
    # 'Nobody Mentioned Here' belongs to the domain half of the same extraction
    # and no infrastructure claim touches it. Counting it would inflate the tab
    # by the 7,069 such nodes the live database holds.
    assert s["entities"] == {"document": 3, "person": 1, "organisation": 1}


def test_the_shelf_check_counts_works_we_hold(db):
    s = summary(db, records_held=[{"title": "American Cosmic", "digested": True}])
    assert (s["works_held"], s["works_named"]) == (1, 3)
    assert s["works_by_stage"]["digested"] == 1
    assert s["works_by_stage"]["named"] == 2
    # Without a record list there is nothing to check against, and claiming
    # zero held would be a false statement rather than an unknown one.
    assert summary(db)["works_held"] == 0
    assert summary(db)["works_by_stage"] is None


def test_a_work_carries_how_far_along_the_pipeline_it_got(db):
    # The same track for every work: a title in someone else's bibliography is
    # "named", and acquiring it puts it on the path everything else walks.
    held = [
        {"title": "American Cosmic", "digested": True},
        {"title": "Haunted Media", "digestible": True},
        {"title": "Messengers of Deception: UFO Contacts and Cults"},
    ]
    stage = {
        w["name"]: w["stage"] for w in entities(db, kind="document", records_held=held)
    }
    assert stage["American Cosmic"] == "digested"
    assert stage["Haunted Media"] == "reviewed"
    assert stage["Messengers of Deception: UFO Contacts and Cults"] == "ingested"


def test_a_work_only_ingested_is_not_yet_reviewed(db):
    held = [{"title": "American Cosmic"}]
    got = entities(db, kind="document", records_held=held)[0]
    assert (got["name"], got["stage"]) == ("American Cosmic", "ingested")


def test_a_queued_record_sits_between_not_held_and_ingested(db):
    # The ingester has produced it; it is not a record in the store yet.
    held = [{"title": "Haunted Media", "queued": True}]
    stage = {
        w["name"]: w["stage"] for w in entities(db, kind="document", records_held=held)
    }
    assert stage["Haunted Media"] == "queued"


def test_an_undeclared_generation_is_not_stale(db):
    # A record extracted before the ingester declared generations says nothing
    # about its own age. Absent is not behind.
    old = [
        {
            "title": "American Cosmic",
            "digested": True,
            "pipeline_version": 1,
            "pipeline_current": 3,
        }
    ]
    silent = [{"title": "American Cosmic", "digested": True, "pipeline_current": 3}]
    assert entity("w1", db, records_held=old)["stale"] is True
    assert entity("w1", db, records_held=silent)["stale"] is False


def test_a_title_matches_through_the_acronym_convention(db):
    # Our records write "Unidentified Flying Object (UFO)" on first use, so the
    # same work is named both ways. Literal matching misses half of them.
    held = [
        {
            "title": "Messengers of Deception: Unidentified Flying Object (UFO) Contacts and Cults",
            "digested": True,
        }
    ]
    stage = {
        w["name"]: w["stage"] for w in entities(db, kind="document", records_held=held)
    }
    assert stage["Messengers of Deception: UFO Contacts and Cults"] == "digested"
    assert stage["Haunted Media"] == "named"


def test_title_keys_covers_both_directions_of_the_convention():
    keys = title_keys(
        "Hair of the Alien: Deoxyribonucleic Acid (DNA) and Other Evidence"
    )
    assert "hair of the alien dna and other evidence" in keys
    assert "hair of the alien deoxyribonucleic acid dna and other evidence" in keys


def test_a_lower_case_parenthetical_is_a_disambiguator_not_an_acronym():
    # Matching case-insensitively reduced every "X (book)" to the key "book",
    # so eight unrelated books collided and any record titled "... (book)"
    # would have marked all of them held.
    assert not (title_keys("Moon Shot (book)") & title_keys("Seeing Red (book)"))
    assert "moon shot" in title_keys("Moon Shot (book)")
    # The ALL-CAPS form still folds, which is the case this exists for.
    assert "ufo danger zone" in title_keys(
        "Unidentified Flying Object (UFO) Danger Zone"
    )


def test_a_work_listed_under_two_names_says_so(db):
    # Two nodes for one work, which the counts report twice. The assimilator's
    # merge ledger would fold them, but its replay is only ever passed the
    # domain database, so they are unreachable rather than merely unmerged.
    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO nodes VALUES ('w4','document','American Cosmic (Pasulka book)')"
    )
    con.execute("INSERT INTO claim_node_refs VALUES (4,'w4')")
    con.commit()
    con.close()
    assert entity("w1", db)["also_listed_as"] == ["American Cosmic (Pasulka book)"]
    assert entity("w4", db)["also_listed_as"] == ["American Cosmic"]
    assert summary(db)["works_double_listed"] == 2
    # A person is not a work; the shelf and its duplicates are a works concern.
    assert entity("p1", db)["also_listed_as"] == []


def test_two_documents_sharing_an_acronym_and_a_tail_are_not_one_work(db):
    # "Kirtland ... (UAP) Report" and "Vandenberg ... (UAP) Report" both reduce
    # to "uap report". A shared key alone would pair them; the key has to be one
    # of the names written out, and "uap report" is neither.
    con = sqlite3.connect(db)
    con.executescript(
        """
        INSERT INTO nodes VALUES
          ('d1','document','Kirtland Air Force Base (UAP) Report'),
          ('d2','document','Vandenberg Air Force Base (UAP) Report');
        INSERT INTO claim_node_refs VALUES (1,'d1'),(2,'d2');
        """
    )
    con.commit()
    con.close()
    assert entity("d1", db)["also_listed_as"] == []
    assert summary(db)["works_double_listed"] == 0


def test_a_third_work_that_spells_out_the_key_does_not_join_the_other_two(db):
    # The pairing has to be per pair, not per key. "UAP Report" anchors the
    # group, but that is a reason to pair it with each report - not a reason to
    # pair the two reports with each other through it.
    con = sqlite3.connect(db)
    con.executescript(
        """
        INSERT INTO nodes VALUES
          ('d1','document','Kirtland Air Force Base (UAP) Report'),
          ('d2','document','Vandenberg Air Force Base (UAP) Report'),
          ('d3','document','UAP Report');
        INSERT INTO claim_node_refs VALUES (1,'d1'),(2,'d2'),(3,'d3');
        """
    )
    con.commit()
    con.close()
    assert entity("d1", db)["also_listed_as"] == ["UAP Report"]
    assert entity("d2", db)["also_listed_as"] == ["UAP Report"]
    assert sorted(entity("d3", db)["also_listed_as"]) == [
        "Kirtland Air Force Base (UAP) Report",
        "Vandenberg Air Force Base (UAP) Report",
    ]


def test_an_acronym_written_out_in_full_is_the_same_work(db):
    # The other side of the same rule: one name IS the shared key, so the pair
    # is the corpus's own acronym convention rather than a coincidence.
    con = sqlite3.connect(db)
    con.executescript(
        """
        INSERT INTO nodes VALUES
          ('d1','document','UFO Danger Zone'),
          ('d2','document','Unidentified Flying Object (UFO) Danger Zone');
        INSERT INTO claim_node_refs VALUES (1,'d1'),(2,'d2');
        """
    )
    con.commit()
    con.close()
    assert entity("d1", db)["also_listed_as"] == [
        "Unidentified Flying Object (UFO) Danger Zone"
    ]


def test_a_work_named_once_is_not_reported_as_a_duplicate(db):
    assert entity("w2", db)["also_listed_as"] == []
    assert summary(db)["works_double_listed"] == 0


def test_entities_are_ranked_by_how_often_the_corpus_returns_to_them(db):
    works = entities(db, kind="document")
    assert [w["name"] for w in works][0] == "American Cosmic"
    assert works[0]["mentions"] == 2


def test_entities_can_be_searched_by_name(db):
    assert [w["name"] for w in entities(db, kind="document", query="haunted")] == [
        "Haunted Media"
    ]


def test_an_entity_carries_its_claims_and_what_it_is_named_alongside(db):
    e = entity("w1", db)
    assert e["kind"] == "document"
    assert len(e["claims"]) == 2
    # The connections are the index into an unlabelled citation graph: this
    # work's people are its author and the people who cited it.
    assert {c["name"] for c in e["connected"]} == {
        "Diana Walsh Pasulka",
        "Haunted Media",
    }


def test_an_entity_carries_the_other_names_it_goes_by(db):
    assert entity("p1", db)["aliases"] == ["D. W. Pasulka"]


def test_an_unknown_entity_is_absent_not_empty(db):
    assert entity("no-such-node", db) is None


def test_loosely_typed_claims_come_first(db):
    # This ordering is the whole judgement the view makes: the claims typed as
    # something other than administrative are met on the way in.
    got = [c["claim_type"] for c in claims(db)]
    assert set(got[:2]) == {"testimony", "opinion"}
    assert got[-1] == "administrative"
    assert entity("w1", db)["claims"][0]["claim_type"] == "testimony"


def test_filters_by_type_and_searches_content(db):
    assert len(claims(db, claim_type="opinion")) == 1
    assert len(claims(db, query="donation site")) == 1
    assert len(claims(db, query="American Cosmic")) == 4  # matches every claim's record


def test_claims_carry_the_record_they_came_from(db):
    c = claims(db)[0]
    assert c["record_title"] == "American Cosmic"
    assert c["record_hash"] == "abc123"
    # The excerpt is what makes a claim checkable, but it is long and this view
    # is read hundreds of claims at a time.
    assert "original_excerpt" not in c


def test_records_are_ordered_by_how_much_each_contributed(db):
    # The 56 digested records are not equal contributors, and the spread is how
    # the tab admits it holds a sample rather than a survey.
    got = records(db)
    assert got == [{"title": "American Cosmic", "hash": "abc123", "claims": 4}]


def test_absent_database_is_distinguishable_from_an_empty_one(tmp_path):
    # None means "the assimilator has not built this"; [] would read as "there
    # are no infrastructure claims", which is a different statement.
    missing = tmp_path / "nope.db"
    assert summary(missing) is None
    assert claims(missing) == []
    assert entities(missing) == []
    assert records(missing) == []
    assert entity("w1", missing) is None


def test_opens_read_only(db):
    # The database is derived - rebuilt from the digests on every import - so a
    # write here would not survive, and would desync the two halves meanwhile.
    from infrastructure import _open

    con = _open(db)
    with pytest.raises(sqlite3.OperationalError):
        con.execute("DELETE FROM claims")
    con.close()
