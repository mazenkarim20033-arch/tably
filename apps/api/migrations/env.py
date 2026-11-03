from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from tably_api import models  # noqa: F401  (registers every table on Base.metadata)
from tably_api.config import get_settings
from tably_api.db import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# The URL comes from the environment, never from alembic.ini, so secrets stay out of the repo.
# Migrations use the direct (unpooled) connection when one is provided.
_cfg = get_settings()
config.set_main_option("sqlalchemy.url", (_cfg.migration_database_url or _cfg.database_url).replace("%", "%%"))
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata,
        literal_binds=True, dialect_opts={"paramstyle": "named"}, render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
