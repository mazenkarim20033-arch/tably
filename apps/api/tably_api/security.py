import hashlib
import hmac
import secrets


def new_token(nbytes: int = 24) -> str:
    """URL-safe random token. 24 bytes = 192 bits, infeasible to guess."""
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def token_matches(token: str | None, stored_hash: str) -> bool:
    if not token:
        return False
    return hmac.compare_digest(hash_token(token), stored_hash)
