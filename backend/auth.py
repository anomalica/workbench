#!/usr/bin/env python3
"""OAuth authentication for the Anomalica Workbench.

Uses Authlib to handle GitHub OAuth. The flow:
1. Frontend redirects to /api/auth/login
2. Backend redirects to GitHub's authorisation page
3. GitHub redirects back to /api/auth/callback with a code
4. Backend exchanges the code for user info, sets a signed session cookie
5. Frontend reads /api/auth/me to check who's logged in

Session data is stored in a signed cookie (no server-side session store).
The cookie contains the user's name, email, and avatar URL.
"""

from __future__ import annotations

import os
import secrets
from typing import Any

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

router = APIRouter(prefix="/api/auth")

# OAuth setup
oauth = OAuth()

GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
# In development, the frontend runs on a different port from the backend.
# The OAuth callback must go through the frontend's proxy so cookies are
# set on the right origin.
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:1947")

if GITHUB_CLIENT_ID:
    oauth.register(
        name="github",
        client_id=GITHUB_CLIENT_ID,
        client_secret=GITHUB_CLIENT_SECRET,
        access_token_url="https://github.com/login/oauth/access_token",
        authorize_url="https://github.com/login/oauth/authorize",
        api_base_url="https://api.github.com/",
        client_kwargs={"scope": "read:user user:email"},
    )


def get_session_secret() -> str:
    """Return a stable session secret.

    In production this comes from the environment (``SESSION_SECRET``), which is
    populated from Bitwarden and stays consistent across restarts and instances.
    For local development, fall back to a per-machine cached file so logins
    survive restarts without any configuration.
    """
    env_secret = os.environ.get("SESSION_SECRET")
    if env_secret:
        return env_secret
    secret_file = os.path.expanduser("~/.config/anomalica/workbench/session-secret")
    os.makedirs(os.path.dirname(secret_file), exist_ok=True)
    if os.path.exists(secret_file):
        with open(secret_file) as f:
            return f.read().strip()
    secret = secrets.token_hex(32)
    with open(secret_file, "w") as f:
        f.write(secret)
    return secret


def setup_auth(app: Any) -> None:
    """Add session middleware and auth routes to the FastAPI app."""
    app.add_middleware(
        SessionMiddleware,
        secret_key=get_session_secret(),
        session_cookie="workbench_session",
        max_age=60 * 60 * 24 * 30,  # 30 days
        same_site="lax",
        https_only=False,  # Allow HTTP in development
    )
    app.include_router(router)


@router.get("/login")
async def login(request: Request) -> RedirectResponse:
    """Redirect to GitHub's OAuth authorisation page."""
    if not GITHUB_CLIENT_ID:
        return RedirectResponse(url=PUBLIC_URL)
    redirect_uri = f"{PUBLIC_URL}/api/auth/callback"
    return await oauth.github.authorize_redirect(request, redirect_uri)


@router.get("/callback")
async def auth_callback(request: Request) -> RedirectResponse:
    """Handle the OAuth callback from GitHub."""
    token = await oauth.github.authorize_access_token(request)

    # Fetch user profile
    resp = await oauth.github.get("user", token=token)
    profile = resp.json()

    # Fetch primary email (might not be in the profile if private)
    email = profile.get("email")
    if not email:
        resp = await oauth.github.get("user/emails", token=token)
        emails = resp.json()
        primary = next((e for e in emails if e.get("primary")), None)
        if primary:
            email = primary["email"]

    # Store user info in the session
    request.session["user"] = {
        "name": profile.get("name") or profile.get("login"),
        "email": email or "",
        "login": profile.get("login"),
        "avatar_url": profile.get("avatar_url", ""),
    }

    return RedirectResponse(url=PUBLIC_URL)


@router.get("/me")
async def get_current_user(request: Request) -> JSONResponse:
    """Return the currently logged-in user, or null."""
    user = request.session.get("user")
    return JSONResponse({"user": user})


@router.get("/logout")
async def logout(request: Request) -> RedirectResponse:
    """Clear the session and redirect to the home page."""
    request.session.clear()
    return RedirectResponse(url=PUBLIC_URL)
