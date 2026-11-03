"""Money math. Mirrors packages/core/src/money.ts; amounts are integer minor units."""

from __future__ import annotations


def allocate(total: int, weights: list[int]) -> list[int]:
    """Split `total` by integer `weights` so parts sum exactly (largest remainder, ties by index)."""
    if not weights:
        return []
    if any(w < 0 for w in weights):
        raise ValueError("weights must be non-negative")
    wsum = sum(weights)
    if wsum == 0:
        raise ValueError("at least one weight must be positive")
    sign = -1 if total < 0 else 1
    absolute = abs(total)
    floors = [absolute * w // wsum for w in weights]
    remainders = [(absolute * w) % wsum for w in weights]
    left = absolute - sum(floors)
    order = sorted(range(len(weights)), key=lambda i: (-remainders[i], i))
    for i in order[:left]:
        floors[i] += 1
    return [f * sign for f in floors]


def extras_total(discounts: int, tax: int, service: int, tip: int, tax_included: bool) -> int:
    return discounts + tip + (0 if tax_included else tax + service)
