// The sync loop: what keeps bb's file images current when the file changes.
//
// bb loads an image file from a URL built only from its path. When the file
// is rewritten, the URL is the same, so an <img> already showing it keeps the
// old picture: the browser has no reason to ask again. The fix is a new URL.
// This loop asks bb's server for each image's version (a HEAD request, which
// answers with the file's ETag) and, when the version differs from the one
// showing, points the <img> at the same URL with the version in its query.
import { readFileImage, versionedUrl } from "./rules";

export interface EngineDeps {
  /** Aborted when the content script generation is torn down. */
  signal: AbortSignal;
  /** The document holding bb's app. */
  doc: Document;
  /** The app's origin. Images from anywhere else are left alone. */
  origin: string;
  /** Defer a pass. Returns a cancel function. `requestAnimationFrame` in bb. */
  defer: (run: () => void) => () => void;
  /** Run on a timer. Returns a cancel function. `setInterval` in bb. */
  every: (ms: number, run: () => void) => () => void;
  /** The file's current version, or null when the server did not say. */
  fetchVersion: (base: string) => Promise<string | null>;
}

export interface Engine {
  /** Run a pass now, skipping the scheduler. Tests use this. */
  syncNow: () => void;
  /** Check every tracked image's version now. Tests use this. */
  pollNow: () => Promise<void>;
  dispose: () => void;
}

/** How often a visible window checks its images. */
export const POLL_MS = 3_000;

const REFRESH_SELECTOR = 'button[aria-label="Refresh file"]';

export function startEngine(deps: EngineDeps): Engine {
  const { signal, doc, origin, defer, every, fetchVersion } = deps;

  /** Images showing one of bb's live files. */
  const tracked = new Set<HTMLImageElement>();
  /**
   * The src each image had when it was last checked, so a pass over an
   * unchanged image does not ask the server again. Every DOM change in the
   * chat runs a pass, and most of them are not about images.
   */
  const checkedSrc = new WeakMap<HTMLImageElement, string>();
  /** One request per file at a time, shared between its images. */
  const inflight = new Map<string, Promise<string | null>>();
  let cancel: (() => void) | null = null;

  function versionOf(base: string): Promise<string | null> {
    let pending = inflight.get(base);
    if (pending === undefined) {
      pending = fetchVersion(base)
        .catch(() => null)
        .finally(() => inflight.delete(base));
      inflight.set(base, pending);
    }
    return pending;
  }

  async function check(img: HTMLImageElement): Promise<void> {
    const before = readFileImage(img.getAttribute("src") ?? "", origin);
    if (before === null) return;
    checkedSrc.set(img, img.getAttribute("src") ?? "");
    const version = await versionOf(before.base);
    if (signal.aborted || version === null) return;
    // bb may have pointed the image at another file while the request ran.
    const now = readFileImage(img.getAttribute("src") ?? "", origin);
    if (now === null || now.base !== before.base) return;
    if (now.version === version) return;
    const next = versionedUrl(now.base, version);
    checkedSrc.set(img, next);
    img.setAttribute("src", next);
  }

  function schedule(): void {
    if (signal.aborted || cancel !== null) return;
    cancel = defer(() => {
      cancel = null;
      syncNow();
    });
  }

  function syncNow(): void {
    if (signal.aborted) return;
    for (const img of tracked) {
      if (!img.isConnected) tracked.delete(img);
    }
    for (const img of doc.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      if (readFileImage(src, origin) === null) {
        tracked.delete(img);
        continue;
      }
      tracked.add(img);
      if (checkedSrc.get(img) !== src) void check(img);
    }
  }

  async function pollNow(): Promise<void> {
    if (signal.aborted || doc.visibilityState !== "visible") return;
    await Promise.all(
      [...tracked].filter((img) => img.isConnected).map((img) => check(img)),
    );
  }

  const observer = new doc.defaultView!.MutationObserver(schedule);
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });

  const stopTimer = every(POLL_MS, () => void pollNow());

  const onVisible = () => void pollNow();
  doc.addEventListener("visibilitychange", onVisible, { signal });
  doc.defaultView!.addEventListener("focus", onVisible, { signal });
  // bb's own Refresh file button re-reads the file but keeps the same URL.
  doc.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      if (target?.closest?.(REFRESH_SELECTOR)) void pollNow();
    },
    { capture: true, signal },
  );

  schedule();

  return {
    syncNow,
    pollNow,
    dispose() {
      observer.disconnect();
      stopTimer();
      if (cancel !== null) cancel();
      cancel = null;
      tracked.clear();
    },
  };
}
