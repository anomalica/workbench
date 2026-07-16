# Anomalica Workbench

Review and correction tool for Anomalica ingests and digests.

A separate web application where reviewers verify the output of the ingestion and digestion pipeline against original source material. Not part of the main Anomalica site.

## Architecture

Plain Svelte 5 single-page application. No server-side rendering, no meta-framework. The frontend builds to static files served by FastAPI (or any static host) in production.

- **Svelte 5** with runes for reactivity
- **Vite** as the build tool
- **Tailwind CSS v4** with shared design tokens from brand
- **FastAPI** (Python) backend in `backend/`, serving git repository operations

The backend lives in this repository under `backend/` and is started alongside the frontend during development. During development, Vite (port 5273) proxies `/api` requests to the FastAPI backend (port 8073). These ports are deliberately not Vite's default 5173: every Vite app defaults to it and silently increments on a clash, so two projects would fight over one port. `strictPort` now fails loudly instead.

In production the FastAPI backend is **not** deployed. The built SPA is served as static files from the CDN, and `/api` is answered by the Deno edge script in `edge/` (Bunny Edge Scripting), which reads prerendered JSON snapshots. A change to `backend/` therefore has no effect on production unless it is mirrored in `edge/`.

## Key libraries (planned)

| Purpose | Library | Reason |
|---------|---------|--------|
| Resizable panels | PaneForge | Svelte 5 native, supports nested panel groups |
| PDF viewing | pdfjs-dist | Framework-agnostic, thin Svelte wrapper |
| Video/audio sync | Native HTML5 elements | Svelte's `bind:currentTime` makes sync trivial |
| File hashing | hash-wasm | Streaming SHA-256 for large files via Web Worker |

## Development

Requires `just`, Node.js, and Python with `uvicorn` + FastAPI available (see `backend/` for Python dependencies).

```bash
npm install
just dev          # Starts FastAPI on :8073 and Vite on :5273 together
```

Individual services:

```bash
just backend      # FastAPI only (uvicorn with --reload on :8073)
just frontend     # Vite dev server only (:5273) - API calls will fail without backend
```

`npm run dev` is the same as `just frontend` - frontend-only, backend must be started separately.

## Build

```bash
npm run build    # Outputs to dist/
npm run preview  # Preview production build locally
```

## Technology decisions

This was deliberately chosen as a plain Svelte 5 + Vite application rather than SvelteKit because:

- The workbench is a single-page application with no need for server-side rendering
- The backend is a separate Python FastAPI service, not a Node.js server
- Fewer dependencies and a smaller attack surface (supply chain discipline)
- Simpler build and deployment: static files served from anywhere
