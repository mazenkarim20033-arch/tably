from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TABLY_", env_file=".env", extra="ignore")

    # Dev default is SQLite. Production: postgresql+psycopg://user:pass@host/db
    database_url: str = "sqlite:///./tably.db"
    upload_dir: str = "uploads"
    max_upload_bytes: int = 10 * 1024 * 1024
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
