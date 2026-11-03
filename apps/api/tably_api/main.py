from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .db import Base, engine
from .routes import bills, public


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Fine for the MVP; switch to Alembic migrations before the schema changes in production.
    Base.metadata.create_all(engine)
    yield


app = FastAPI(title="TABLY API", lifespan=lifespan, docs_url=None, redoc_url=None)

_origins = [o.strip() for o in get_settings().cors_origins.split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware, allow_origins=_origins, allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Content-Type", "X-Admin-Token", "X-Participant-Token", "X-Participant-Id"],
    )


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    # Share tokens live in URLs, so never leak them through Referer; never cache bill data.
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/health")
def health():
    return {"ok": True}


app.include_router(bills)
app.include_router(public)

_dist = Path(get_settings().web_dist)
if _dist.is_dir():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "Not found."}, status_code=404)
        target = (_dist / path).resolve()
        if path and target.is_file() and _dist.resolve() in target.parents:
            return FileResponse(target)
        return FileResponse(_dist / "index.html")
