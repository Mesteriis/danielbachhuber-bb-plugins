// @vitest-environment jsdom
//
// The loop driven against <img> elements shaped like bb's file preview, with
// a fake server whose file versions the test changes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngine, type Engine } from "./engine";
import { readFileImage, versionFromHeaders, versionedUrl } from "./rules";

const ORIGIN = "http://127.0.0.1:4000";
const FILE = "/api/v1/environments/env_1/files/content/chart.png";

let controller: AbortController;
let engine: Engine;
let pending: (() => void)[] = [];
let versions: Map<string, string | null>;
let requests: string[];

function flush(): void {
  for (let guard = 0; guard < 20 && pending.length > 0; guard += 1) {
    const queued = pending;
    pending = [];
    for (const run of queued) run();
  }
}

/** Let observers and requests deliver, then run what they scheduled. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
  }
}

function renderImage(src: string): HTMLImageElement {
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Open chart.png in full screen preview");
  const img = document.createElement("img");
  img.setAttribute("src", src);
  button.append(img);
  document.body.append(button);
  return img;
}

function start(): Engine {
  return startEngine({
    signal: controller.signal,
    doc: document,
    origin: ORIGIN,
    defer: (run) => {
      pending.push(run);
      return () => {
        pending = pending.filter((queued) => queued !== run);
      };
    },
    every: () => () => {},
    fetchVersion: async (base) => {
      requests.push(base);
      return versions.get(new URL(base).pathname) ?? null;
    },
  });
}

beforeEach(() => {
  controller = new AbortController();
  pending = [];
  versions = new Map([[FILE, "a1"]]);
  requests = [];
  engine = start();
});

afterEach(() => {
  engine.dispose();
  controller.abort();
  document.body.innerHTML = "";
});

describe("fresh-file-images", () => {
  it("puts the file's version on an image when it appears", async () => {
    const img = renderImage(FILE);
    await settle();
    expect(img.getAttribute("src")).toBe(`${ORIGIN}${FILE}?bb-hacks-v=a1`);
  });

  it("loads the image again when the file changes", async () => {
    const img = renderImage(FILE);
    await settle();
    versions.set(FILE, "b2");
    await engine.pollNow();
    expect(img.getAttribute("src")).toBe(`${ORIGIN}${FILE}?bb-hacks-v=b2`);
  });

  it("leaves the src alone while the file is unchanged", async () => {
    const img = renderImage(FILE);
    await settle();
    const before = img.getAttribute("src");
    await engine.pollNow();
    await engine.pollNow();
    expect(img.getAttribute("src")).toBe(before);
  });

  it("asks once per image, not on every DOM change", async () => {
    renderImage(FILE);
    await settle();
    document.body.append(document.createElement("p"));
    document.body.append(document.createElement("p"));
    await settle();
    expect(requests).toHaveLength(1);
  });

  it("follows bb when it points the image at another file", async () => {
    const other = "/api/v1/environments/env_1/files/content/other.png";
    versions.set(other, "c3");
    const img = renderImage(FILE);
    await settle();
    img.setAttribute("src", other);
    await settle();
    expect(img.getAttribute("src")).toBe(`${ORIGIN}${other}?bb-hacks-v=c3`);
  });

  it("leaves images from elsewhere alone", async () => {
    const revision = "/api/v1/environments/env_1/revisions/HEAD/files/a.png";
    const outside = renderImage("https://example.com/a.png");
    const atRevision = renderImage(revision);
    await settle();
    expect(outside.getAttribute("src")).toBe("https://example.com/a.png");
    expect(atRevision.getAttribute("src")).toBe(revision);
    expect(requests).toHaveLength(0);
  });

  it("leaves the image alone when the server gives no version", async () => {
    versions.set(FILE, null);
    const img = renderImage(FILE);
    await settle();
    expect(img.getAttribute("src")).toBe(FILE);
  });
});

describe("rules", () => {
  it("reads bb's live file routes", () => {
    for (const path of [
      "/api/v1/environments/e/files/a.png",
      "/api/v1/projects/p/files/a.png",
      "/api/v1/projects/p/hosts/h/files/a.png",
      "/api/v1/threads/t/thread-storage/files/a.png",
      "/api/v1/threads/t/host-files/Users/a.png",
      "/api/v1/hosts/h/files/Users/a.png",
    ]) {
      expect(readFileImage(path, ORIGIN)?.base).toBe(`${ORIGIN}${path}`);
    }
  });

  it("strips its own parameter and keeps bb's", () => {
    const src = versionedUrl(`${ORIGIN}/api/v1/projects/p/files/a.png?x=1`, "v9");
    expect(readFileImage(src, ORIGIN)).toEqual({
      base: `${ORIGIN}/api/v1/projects/p/files/a.png?x=1`,
      version: "v9",
    });
  });

  it("makes a short version from the ETag", () => {
    const etag = new Headers({ etag: 'W/"file-9e2a42df"' });
    const other = new Headers({ etag: 'W/"file-0000"' });
    expect(versionFromHeaders(etag)).toMatch(/^[0-9a-z]+$/u);
    expect(versionFromHeaders(etag)).not.toBe(versionFromHeaders(other));
    expect(versionFromHeaders(new Headers())).toBeNull();
  });
});
