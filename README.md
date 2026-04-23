# Anomalica Workbench

Review and correction tool for Anomalica ingests and digests.

A separate web application where reviewers verify the output of the ingestion and digestion pipeline against original source material. Not part of the main Anomalica site.

## Architecture

Plain Svelte 5 single-page application. No server-side rendering, no meta-framework. The frontend builds to static files served by FastAPI (or any static host) in production.

- **Svelte 5** with runes for reactivity
- **Vite** as the build tool
- **Tailwind CSS v4** with shared design tokens from anomalica-brand
- **FastAPI** (Python) backend in `backend/`, serving git repository operations

The backend lives in this repository under `backend/` and is started alongside the frontend during development. During development, Vite (port 5173) proxies `/api` requests to the FastAPI backend (port 8000). In production, FastAPI serves both the API and the built static files.

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
just dev          # Starts FastAPI on :8000 and Vite on :5173 together
```

Individual services:

```bash
just backend      # FastAPI only (uvicorn with --reload on :8000)
just frontend     # Vite dev server only (:5173) - API calls will fail without backend
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
