# Heads up: source file serving endpoint

A new endpoint `GET /api/sources/{full_hash}` was added to `backend/server.py` by the meta-repo AI on 2026-04-11. It serves original source files (PDFs, audio, video) to the frontend so reviewers can see the original alongside the ingested markdown.

## What changed

In `backend/server.py`:

- Added `SOURCES_PATH` configuration (env var `SOURCES_PATH`, defaults to `../../sources` relative to the backend, which resolves to `~/repos/anomalica/sources/`)
- Added `GET /api/sources/{full_hash}` endpoint that looks up `{hash}.{ext}` in the sources directory and returns the file with the correct content type
- Same hash validation as the ingests endpoint (64-char SHA-256 required, 404 for invalid or missing, responses are indistinguishable by design)

## Where the files come from

The ingester now copies original source files to `~/repos/anomalica/sources/` after ingestion, named `{content_hash}.{ext}`. This directory currently has 8 audio files (.opus) from the existing test corpus. Future ingestions will populate it automatically.

The sources directory is not a git repo. In production it will be backed by object storage (Bunny Storage) with private and public zones based on copyright status.

## What the frontend needs to do

The frontend currently uses drag-and-drop via the File System Access API for all source files. The new backend endpoint means the frontend can now also REQUEST source files from the server. The suggested approach:

1. When displaying a record's source panel, first try `GET /api/sources/{content_hash}`
2. If it returns 200, use the response as the source (create a blob URL from it)
3. If it returns 404, fall back to the existing drag-and-drop flow

This way records that have archived originals show them automatically, and records without (or where the server denies access) still work via the existing bring-your-own-copy flow.

## Access control (not yet implemented)

The endpoint currently serves files without any access checking. This is fine for single-user development. In production, the endpoint must check one of:

1. **Hash verification** - the viewer has already proven possession of the file by providing its hash (this is the hash they're requesting with, so it's circular for this endpoint - hash verification is really for the ingest endpoint, not the source endpoint)
2. **Manual access grant** - the viewer is authenticated and has been granted access to this specific record by an Anomalica member
3. **Copyright status** - the record is `public_domain` or `open_licence`, in which case anyone can see it

The access grant system uses hashed email addresses stored in a YAML file. See the copyright decision in the meta-repo for the full design: `~/repos/anomalica/anomalica/decisions/drafts/source-types-and-copyright.md`

## Related

- Copyright decision: `~/repos/anomalica/anomalica/decisions/drafts/source-types-and-copyright.md`
- Workbench architecture: `~/repos/anomalica/anomalica/architecture/review-workbench.md`
- Ingester change: `~/repos/anomalica/anomalica-ingester/headsup.md`
