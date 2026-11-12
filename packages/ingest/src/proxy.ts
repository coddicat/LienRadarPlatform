export type PlaywrightProxy = {
  server: string;
  username?: string;
  password?: string;
};

function parseProxyUrl(raw: string): PlaywrightProxy | undefined {
  try {
    const u = new URL(raw);
    // Chromium cannot authenticate SOCKS5 proxies.
    if (u.protocol.startsWith("socks") && (u.username || u.password)) {
      return undefined;
    }
    return {
      server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return { server: raw };
  }
}

/**
 * Prefer HTTP residential proxy for Chromium (SOCKS5+auth unsupported).
 * Env: RA_HTTP_PROXY / RA_PROXY
 */
export function resolveAuctionProxy(): PlaywrightProxy | undefined {
  const http = (process.env.RA_HTTP_PROXY || "").trim();
  if (http) {
    const p = parseProxyUrl(http);
    if (p) return p;
  }
  const socks = (process.env.RA_PROXY || "").trim();
  if (socks) return parseProxyUrl(socks);
  return undefined;
}

/** Proxy candidates Chromium can actually launch (skip SOCKS5+auth). */
export function resolveAuctionProxyCandidates(): PlaywrightProxy[] {
  const urls = [process.env.RA_HTTP_PROXY, process.env.RA_PROXY]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  const out: PlaywrightProxy[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const p = parseProxyUrl(raw);
    if (!p) continue;
    const key = `${p.server}|${p.username ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function auctionProxySummary(): string {
  const p = resolveAuctionProxy();
  if (!p) return "direct (no RA_PROXY)";
  try {
    const u = new URL(p.server);
    return `${u.protocol}//${u.hostname}:${u.port || ""}`;
  } catch {
    return "configured";
  }
}
