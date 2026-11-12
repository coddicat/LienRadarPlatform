import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export const CacheKeys = {
  paLand: (folio13: string) => `lr:pa:land:${folio13}`,
  paJson: (folio13: string) => `lr:pa:json:${folio13}`,
  gisAddr: (street: string) => `lr:gis:addr:${sha1(street.toUpperCase())}`,
  dashStats: "lr:dash:stats:v1",
  adminJobs: "lr:admin:jobs:v1",
} as const;

export const CacheTtl = {
  paLandSec: 7 * 24 * 60 * 60,
  paJsonSec: 7 * 24 * 60 * 60,
  gisAddrSec: 30 * 24 * 60 * 60,
  gisAddrNegativeSec: 24 * 60 * 60,
  dashStatsSec: 45,
  adminJobsSec: 4,
} as const;

let client: RedisClientType | null = null;
let connectPromise: Promise<RedisClientType | null> | null = null;
let disabled = false;

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function redisUrl(): string | null {
  const raw = (process.env.REDIS_URL || "").trim();
  return raw || null;
}

export function isRedisConfigured(): boolean {
  return Boolean(redisUrl()) && !disabled;
}

async function getClient(): Promise<RedisClientType | null> {
  if (disabled) return null;
  const url = redisUrl();
  if (!url) return null;
  if (client?.isOpen) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const c = createClient({ url }) as RedisClientType;
      c.on("error", (err) => {
        console.warn("[cache] redis error", err instanceof Error ? err.message : err);
      });
      await c.connect();
      client = c;
      return c;
    } catch (e) {
      console.warn("[cache] redis unavailable — continuing without cache", e instanceof Error ? e.message : e);
      disabled = true;
      client = null;
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const c = await getClient();
  if (!c) return null;
  try {
    const raw = await c.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<boolean> {
  const c = await getClient();
  if (!c) return false;
  try {
    await c.set(key, JSON.stringify(value), { EX: Math.max(1, Math.floor(ttlSec)) });
    return true;
  } catch {
    return false;
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (!keys.length) return;
  const c = await getClient();
  if (!c) return;
  try {
    await c.del(keys);
  } catch {
    /* ignore */
  }
}

/** Drop short-lived UI snapshots after ingest mutations. */
export async function invalidateUiCaches(): Promise<void> {
  await cacheDel(CacheKeys.dashStats, CacheKeys.adminJobs);
}

export async function cacheGetOrSetJson<T>(
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const hit = await cacheGetJson<T>(key);
  if (hit !== null) return { value: hit, hit: true };
  const value = await loader();
  await cacheSetJson(key, value, ttlSec);
  return { value, hit: false };
}

export async function pingRedis(): Promise<{ ok: boolean; detail: string }> {
  const url = redisUrl();
  if (!url) return { ok: false, detail: "REDIS_URL not set" };
  try {
    const c = await getClient();
    if (!c) return { ok: false, detail: "connect failed" };
    const pong = await c.ping();
    return { ok: pong === "PONG", detail: `ping=${pong}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
