import os
from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine

from tably_api.db import Base

API_DIR = Path(__file__).resolve().parents[1]


def test_migrations_build_exactly_the_model_schema(tmp_path, monkeypatch):
    """`alembic upgrade head` on an empty database must produce the same schema the models describe."""
    url = f"sqlite:///{tmp_path / 'mig.db'}"
    monkeypatch.setenv("TABLY_DATABASE_URL", url)
    from tably_api.config import get_settings

    get_settings.cache_clear()
    try:
        cfg = Config(str(API_DIR / "alembic.ini"))
        cfg.set_main_option("script_location", str(API_DIR / "migrations"))
        command.upgrade(cfg, "head")
        eng = create_engine(url)
        with eng.connect() as conn:
            diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
        assert diff == [], f"models and migrations disagree: {diff}"
        command.downgrade(cfg, "base")
        with eng.connect() as conn:
            left = [t for t in create_engine(url).connect().connection.dbapi_connection.execute(
                "select name from sqlite_master where type='table' and name != 'alembic_version'")]
        assert left == []
    finally:
        get_settings.cache_clear()
        os.environ.pop("TABLY_DATABASE_URL", None)
