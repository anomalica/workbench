# Edge ledger fixtures

Golden samples of the curation ledger entries the edge function writes, emitted by
the real `edge/lib/ledger.ts` writer (`@std/yaml` block serialisation). They exist
so the assimilator can replay the workbench's ACTUAL bytes through its
`read_ledger`/`replay_ledger` and `read_rejections`/`replay_rejections` against a
throwaway graph, confirming the TS->Python ledger seam end to end.

These are NOT live ledger files - never copy them into the `curation` repo's
`merges.yaml`/`rejections.yaml`, which the rebuild replays against the real graph.

- `sample-merges.yaml` - a `merge` then its `undo`.
- `sample-rejections.yaml` - a `reject` then its `unreject`.

They deliberately cover the `@std/yaml` quirks worth pinning: an empty list
(`prior_names: []` flow), a block list, a unicode name, a `null` actor, and names
that force quoting (a colon, a leading `@`, a leading `#`).
