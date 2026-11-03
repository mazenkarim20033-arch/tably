# One container serves the API and the shared bill web page.
# Build: docker build -t tably .     Run: docker run -p 8000:8000 -e TABLY_DATABASE_URL=... tably

# ---- build the shared page ----
FROM node:22-alpine AS web
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --workspace @tably/web --include-workspace-root
COPY packages/core packages/core
COPY apps/web apps/web
RUN npm run build -w @tably/web

# ---- API runtime ----
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TABLY_WEB_DIST=/app/web/dist
WORKDIR /app/api
COPY apps/api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/api/ .
COPY --from=web /repo/apps/web/dist /app/web/dist
RUN useradd --create-home --uid 10001 tably
USER tably
EXPOSE 8000
# Migrations run on every start (a no-op when up to date). The proxy in front of the container is trusted
# for the client IP, so rate limits apply per real visitor.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn tably_api.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
