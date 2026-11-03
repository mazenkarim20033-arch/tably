"""Delete old bills (and with them people, payments and photos): `python -m tably_api.purge [--days N] [--dry-run]`.

TABLY keeps only display names, amounts and the receipt photo. Run this on a schedule so they are not kept forever.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from .config import get_settings
from .db import SessionLocal
from .models import Bill


def purge(days: int, dry_run: bool = False) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    with SessionLocal() as db:
        old = list(db.scalars(select(Bill).where(Bill.created_at < cutoff)))
        if not dry_run:
            for bill in old:
                db.delete(bill)
            db.commit()
        return len(old)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=get_settings().retention_days)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    n = purge(args.days, args.dry_run)
    print(f"{'Would delete' if args.dry_run else 'Deleted'} {n} bill(s) older than {args.days} days.")


if __name__ == "__main__":
    main()
