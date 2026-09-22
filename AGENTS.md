# Anomalica workbench

Parent Product and root Core instructions are loaded through `opencode.json` and remain mandatory.

The workbench is the human review and curation application. It is a Svelte 5 single-page application with a separate FastAPI backend.

## Running the project

- Use `just dev` to start both services. Do not use `npm run dev` alone when the task needs API calls.
- The workbench URL is `http://localhost:1947`; the Vite server proxies `/api` to the backend on port `8073`.
- Keep these distinctive ports and Vite's strict-port behaviour. Do not move the project back to a default `51xx` or `52xx` port.
- Only one `just dev` instance should run. Check for an existing instance and coordinate over the workspace bus before starting or restarting another session's server.

## Stack and conventions

- The front end is plain Svelte 5 plus Vite, not SvelteKit. It has no server-side rendering or SvelteKit server routes.
- Use Svelte 5 runes such as `$state`, `$derived`, `$effect` and `$props`; do not introduce legacy `$:` or `export let` syntax.
- Tailwind CSS is version 4 through `@tailwindcss/vite`.
- Dialogs that intentionally copy an initial prop into local state may use the existing `state_referenced_locally` suppression. Preserve the snapshot semantics.
- Close a modal from its backdrop only when `event.target === event.currentTarget`; do not rely on nested propagation suppression.

## Domain rules

- A segment is one transcript line with speaker, time, seconds, lines and index.
- Speaker groups sort as named, then special, then unnamed. Within a group, sort by first transcript appearance.
- An unnamed `Speaker N` value is a diarisation cluster identifier, not an order of first appearance.
- Special speakers include `[irrelevant]`, `[narrator]` and `[external footage]`.

## Cross-repository reads

- Records are read from `../ingests/store/{hash}.md` or `../ingests/store/{hash}.v2.md`.
- Verification sidecars use `../ingests/store/{hash}.verification.json` where access rules require them. A missing sidecar can mean intentionally ungated content; check the copyright model before treating it as an error.
- Original source files are under `/home/mark/repos/anomalica/records/` and are served locally through `GET /api/sources/{full_hash}`.
- Never return or log a verification challenge's `answer` field.
- The authoritative references are `../anomalica/architecture/ingest-format.md`, `../anomalica/architecture/review-workbench.md` and `../anomalica/decisions/drafts/source-types-and-copyright.md`.

## Verification

```bash
just dev
just build
just check
just test
```

- Vitest uses jsdom. `just test-watch` runs the watch mode.
- Run the relevant backend Pytest suite directly when changing FastAPI behaviour; `just test` currently covers the front-end Vitest suite.
- Render and inspect interface changes at `http://localhost:1947` in addition to running build, type and test checks.
