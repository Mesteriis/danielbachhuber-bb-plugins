// The hack, as the content-script registration bb mounts.
import { startEngine } from "./engine";
import { versionFromHeaders } from "./rules";

export const id = "fresh-file-images";

export function mount(signal: AbortSignal): () => void {
  const engine = startEngine({
    signal,
    doc: document,
    origin: window.location.origin,
    defer: (run) => {
      const frame = window.requestAnimationFrame(run);
      return () => window.cancelAnimationFrame(frame);
    },
    every: (ms, run) => {
      const timer = window.setInterval(run, ms);
      return () => window.clearInterval(timer);
    },
    async fetchVersion(base) {
      const response = await fetch(base, {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) return null;
      return versionFromHeaders(response.headers);
    },
  });

  return () => {
    engine.dispose();
  };
}
