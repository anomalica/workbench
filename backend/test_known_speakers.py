#!/usr/bin/env python3
"""The speaker names the corpus already uses, offered when the next one is typed.

A speaker may be introduced with where they are from - `Scott Gordon [KXAS]`,
the reporter and his station. The station belongs to that line and that record;
the person is Scott Gordon, and the person is what another record reuses. Offered
with the station attached, the next reviewer files the same man a second time and
the graph carries two of him.

Stripped HERE as well as where the list is written, because a record whose list
was written before the rule existed still holds the qualified form and nothing
rewrites it retrospectively.
"""

import backend.server as server

identity = server.source.__class__._speaker_identity


class TestWhoASpeakerIs:
    def test_a_qualifier_comes_off(self):
        assert identity("Scott Gordon [KXAS]") == "Scott Gordon"
        assert identity("  Ross Coulthart [NewsNation] ") == "Ross Coulthart"

    def test_a_plain_name_is_untouched(self):
        assert identity("Ross Coulthart") == "Ross Coulthart"

    def test_a_description_keeps_its_brackets(self):
        # The opposite meaning: nobody to identify. Stripping the brackets would
        # turn a description into a person, which is the failure the notation
        # exists to prevent, arrived at from the other direction.
        for described in ("[narrator]", "[speaker 3]", "[audience member]"):
            assert identity(described) == described


class TestTheOfferedList:
    def _scan(self, records):
        class _Fake(server.source.__class__):
            def __init__(self, data):
                self._data = data

            def _scan(self):
                return self._data

        return _Fake(records)

    def test_one_person_under_two_stations_is_offered_once(self):
        src = self._scan(
            {
                "a": ("a.md", {"speakers": ["Scott Gordon [KXAS]"]}),
                "b": ("b.md", {"speakers": ["Scott Gordon [NBC]"]}),
                "c": ("c.md", {"speakers": ["Scott Gordon"]}),
            }
        )
        offered = src.known_speakers()
        assert offered == [{"name": "Scott Gordon", "ingests": 3}]

    def test_a_described_speaker_is_never_offered(self):
        # It is scoped to its own record: the [interviewer 2] in one recording is
        # not the one in another, so offering it invites two strangers to be
        # filed under one name.
        src = self._scan(
            {
                "a": (
                    "a.md",
                    {"speakers": ["[interviewer 2]", "[speaker 3]", "Speaker 4"]},
                ),
            }
        )
        assert src.known_speakers() == []

    def test_a_superseded_record_does_not_count(self):
        src = self._scan(
            {
                "a": ("a.md", {"speakers": ["Ross Coulthart"], "superseded_by": "b"}),
                "b": ("b.md", {"speakers": ["Ross Coulthart"]}),
            }
        )
        assert src.known_speakers() == [{"name": "Ross Coulthart", "ingests": 1}]
