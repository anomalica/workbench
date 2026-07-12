# Anomalica Workbench

# Start both the FastAPI backend and Vite dev server
dev:
    #!/usr/bin/env bash
    set -a; [ -f .env ] && source .env; set +a
    trap 'kill 0' EXIT
    # Watch the shared anomalica-common package too: a bare --reload only sees
    # this repo, so digester/materialise changes there would silently serve a
    # stale pre-digest until a manual restart.
    uvicorn backend.server:app --port 8073 --reload --reload-dir backend --reload-dir ../anomalica-common/src &
    npm run dev &
    wait

# Start only the FastAPI backend
backend:
    #!/usr/bin/env bash
    set -a; [ -f .env ] && source .env; set +a
    uvicorn backend.server:app --port 8073 --reload --reload-dir backend --reload-dir ../anomalica-common/src

# Start only the Vite dev server
frontend:
    npm run dev

# Production build
build:
    npm run build

# Type check
check:
    npm run check

# Run tests
test:
    npm test

# Run tests in watch mode
test-watch:
    npm run test:watch
