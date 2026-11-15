// Pure logic: which images load a file that can change on disk, and the URL
// that makes the browser load it again.

/** The query parameter this hack adds. Anything else in the URL is bb's. */
export const VERSION_PARAM = "bb-hacks-v";

/**
 * bb's routes that serve a file as it is on disk now, after `/api/v1/`.
 * A file at a git revision (`environments/<id>/revisions/<ref>/files/...`)
 * never changes, so it is left out.
 */
const LIVE_FILE_ROUTES = [
  /^environments\/[^/]+\/files\/./u,
  /^projects\/[^/]+\/files\/./u,
  /^projects\/[^/]+\/hosts\/[^/]+\/files\/./u,
  /^threads\/[^/]+\/thread-storage\/files\/./u,
  /^threads\/[^/]+\/host-files\/./u,
  /^hosts\/[^/]+\/files\/./u,
];

export interface FileImage {
  /** The image's URL without this hack's parameter: what bb asked for. */
  base: string;
  /** The version this hack last put on it, or null when bb set the src. */
  version: string | null;
}

/**
 * Read an image's src. Returns null for anything that is not one of bb's live
 * file routes on this origin, which the hack leaves alone.
 */
export function readFileImage(src: string, origin: string): FileImage | null {
  let url: URL;
  try {
    url = new URL(src, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = /^\/api\/v1\/(.+)$/u.exec(url.pathname);
  if (match === null) return null;
  if (!LIVE_FILE_ROUTES.some((route) => route.test(match[1]!))) return null;
  const version = url.searchParams.get(VERSION_PARAM);
  url.searchParams.delete(VERSION_PARAM);
  return { base: url.toString(), version };
}

/** The base URL with a version on it, so a new version is a new URL. */
export function versionedUrl(base: string, version: string): string {
  const url = new URL(base);
  url.searchParams.set(VERSION_PARAM, version);
  return url.toString();
}

/**
 * A short, URL-safe version from the response headers. bb sends an ETag made
 * from the file's contents; the fallback covers a route that sends only a
 * modification time and a length.
 */
export function versionFromHeaders(headers: Headers): string | null {
  const etag = headers.get("etag");
  const source =
    etag ??
    (headers.get("last-modified") !== null
      ? `${headers.get("last-modified")}|${headers.get("content-length") ?? ""}`
      : null);
  if (source === null) return null;
  // FNV-1a, so the parameter stays short whatever the header holds.
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
