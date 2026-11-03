import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .db import Base, engine
from .hardening import BodyLimitMiddleware, install_log_redaction, security_middleware
from .routes import bills, public, webhooks
from .routes_manage import manage

install_log_redaction()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # SQLite dev databases are created on the fly. Real databases are managed by `alembic upgrade head`.
    if engine.dialect.name == "sqlite" or os.environ.get("TABLY_AUTO_CREATE") == "1":
        Base.metadata.create_all(engine)
    yield


app = FastAPI(title="TABLY API", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

_origins = [o.strip() for o in get_settings().cors_origins.split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware, allow_origins=_origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-Admin-Token", "X-Participant-Token", "X-Participant-Id", "Idempotency-Key"],
    )
app.middleware("http")(security_middleware)
app.add_middleware(BodyLimitMiddleware)


@app.get("/api/health")
def health():
    return {"ok": True}


app.include_router(manage)  # first: its static paths must win over /{bill_id}
app.include_router(bills)
app.include_router(public)
app.include_router(webhooks)

def mount_web(target_app: FastAPI, dist: Path) -> None:
    """Serve the built shared-bill page (and its client-side routes) from the same server as the API."""
    root = dist.resolve()
    target_app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

    @target_app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "Not found."}, status_code=404)
        target = (root / path).resolve()
        if path and target.is_file() and root in target.parents:  # never serve outside the build folder
            return FileResponse(target)
        return FileResponse(root / "index.html")


if Path(get_settings().web_dist).is_dir():
    mount_web(app, Path(get_settings().web_dist))
