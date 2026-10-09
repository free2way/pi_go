/**
 * Cache-Control / 404 policy for the served build output.
 *
 * Why this exists: every response used to get an unconditional
 * `Cache-Control: no-store` from the global `onSend` hook, which also covered the
 * content-hashed files under `/assets/`. The browser (and any CDN in front of it)
 * therefore re-downloaded the whole ~700 KB bundle on every reload, even though
 * the file name changes whenever the bytes change.
 *
 * Policy:
 *   - `/api/**`            → `no-store` (never cache data or auth-scoped reads)
 *   - `/assets/<hash>.**`  → `public, max-age=31536000, immutable` (the URL is the
 *                            version; a new build ships a new name)
 *   - everything else      → `no-cache` (i.e. "store, but revalidate every time"):
 *                            this is `index.html` and the SPA fallback, where a
 *                            stale copy would point at assets that no longer exist
 *
 * Kept pure and separate from the Fastify wiring so the policy is unit-testable.
 */

/** A Vite/Rollup content-hashed build asset, e.g. `/assets/index-C4pICr6h.js`. */
const BUILD_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

/** Strip the query string (cache decisions are made per path). */
function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** True for requests that address the build output directory (hashed or stale). */
export function isBuildAssetRequest(url: string): boolean {
  return pathOf(url).startsWith("/assets/");
}

/** True only for a currently-shipped, content-hashed asset. */
export function isImmutableBuildAsset(url: string): boolean {
  return BUILD_ASSET.test(pathOf(url));
}

/** The `Cache-Control` value for a response served at `url`. */
export function cacheControlFor(url: string): "no-store" | "no-cache" | "public, max-age=31536000, immutable" {
  const path = pathOf(url);
  if (path.startsWith("/api/")) return "no-store";
  if (isImmutableBuildAsset(path)) return "public, max-age=31536000, immutable";
  return "no-cache";
}
