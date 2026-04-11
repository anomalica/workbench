# Anomalica Workbench

# Start both the FastAPI backend and Vite dev server
dev:
    #!/usr/bin/env bash
    trap 'kill 0' EXIT
    uvicorn backend.server:app --port 8000 --reload &
    npm run dev &
    wait

# Start only the FastAPI backend
backend:
    uvicorn backend.server:app --port 8000 --reload

# Start only the Vite dev server
frontend:
    npm run dev

# Production build
build:
    npm run build

# Type check
check:
    npm run check
