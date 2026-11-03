from functools import lru_cache

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TABLY_", env_file=".env", extra="ignore")

    # Dev default is SQLite. Production: postgresql+psycopg://user:pass@host/db
    # TABLY_DATABASE_URL wins; DATABASE_URL is the name Neon (and most hosts) provide. Use the POOLED string here.
    database_url: str = Field(default="sqlite:///./tably.db", validation_alias=AliasChoices("TABLY_DATABASE_URL", "DATABASE_URL"))
    # Direct (unpooled) string for schema migrations: PgBouncer transaction pooling breaks session-level DDL.
    migration_database_url: str | None = Field(default=None, validation_alias=AliasChoices("TABLY_MIGRATION_DATABASE_URL", "DATABASE_URL_UNPOOLED"))

    @field_validator("database_url", "migration_database_url")
    @classmethod
    def _driver(cls, v: str | None) -> str | None:
        """Hosts hand out postgres:// or postgresql:// URLs; SQLAlchemy needs the psycopg 3 driver named."""
        for prefix in ("postgres://", "postgresql://"):
            if v and v.startswith(prefix):
                return "postgresql+psycopg://" + v[len(prefix):]
        return v

    max_upload_bytes: int = 8 * 1024 * 1024
    max_json_bytes: int = 256 * 1024
    retention_days: int = 180  # bills older than this are deleted by `python -m tably_api.purge`
    share_link_days: int = 30
    # Only enable behind a reverse proxy you control; otherwise clients can spoof X-Forwarded-For.
    trust_proxy: bool = False
    rate_limit_enabled: bool = True
    web_dist: str = "../web/dist"
    cors_origins: str = ""
    # Hosts a creator's InstaPay payment link may point to (comma separated). Verify before relying on it.
    payment_link_hosts: str = "ipn.eg"
    payment_initiated_hours: int = 24  # an unfinished payment attempt expires after this
    sse_poll_seconds: float = 1.0
    sse_max_seconds: int = 300  # clients reconnect, which also re-checks the link is still valid


@lru_cache
def get_settings() -> Settings:
    return Settings()
