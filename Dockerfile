# LienRadar web + pre-deploy migrate image (App Platform).
# Uses Playwright base so admin-triggered calendar/day_refresh (Chromium) works
# on the web service the same way as the ingest worker.
FROM mcr.microsoft.com/playwright:v1.65.0-jammy AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/cache/package.json ./packages/cache/
COPY packages/db/package.json ./packages/db/
COPY packages/method/package.json ./packages/method/
COPY packages/ingest/package.json ./packages/ingest/
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Prisma generate / Next build must not require a live DB
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
ENV NEXTAUTH_SECRET="build-time-placeholder"
ENV NEXTAUTH_URL="http://localhost:3000"
RUN npm run db:generate && npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
# Prefer browsers bundled in the Playwright image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app /app
EXPOSE 8080
CMD ["npm", "run", "start", "-w", "@lienradar/web"]
