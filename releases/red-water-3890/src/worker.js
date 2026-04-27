export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // trim trailing slash
    const parts = path.split("/").filter(Boolean);

    // Expected:
    // /android/latest
    // /android/v-1-22-3
    // /ios/latest
    // /ios/v-1-22-3
    if (parts.length < 2) {
      return new Response(
        "Use /android/latest, /ios/latest, /android/v-1-22-3, /ios/v-1-22-3",
        { status: 400 }
      );
    }

    const platform = parts[0].toLowerCase();
    if (platform !== "android" && platform !== "ios") {
      return new Response("Platform must be /android or /ios", { status: 400 });
    }

    const isLatest = parts[1].toLowerCase() === "latest";
    const ext = platform === "android" ? "apk" : "zip";
    const prefix = platform + "/"; // folder in R2
    const baseName = "hypen-gallery-"; // adjust if you ever rename

    // Route: /{platform}/latest
    if (isLatest) {
      const latestKey = await findLatestKey(env.BUCKET, prefix, baseName, ext);
      if (!latestKey) return new Response("No releases found", { status: 404 });
      return serveR2Object(env.BUCKET, latestKey, ext, { immutable: false });
    }

    // Route: /{platform}/v-1-22-3 (or v-1.22.3 etc)
    const versionRaw = parts[1];
    const version = normalizeVersion(versionRaw); // -> "1.22.3"
    if (!version) return new Response("Bad version format", { status: 400 });

    const key = `${prefix}${baseName}${version}.${ext}`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response("Not found", { status: 404 });

    // Versioned files can be cached forever
    return serveR2Object(env.BUCKET, key, ext, { immutable: true });
  },
};

function normalizeVersion(seg) {
  // Accept:
  // v-1-22-3  -> 1.22.3
  // v-1.22.3  -> 1.22.3
  // 1.22.3    -> 1.22.3
  const s = seg.toLowerCase().startsWith("v") ? seg.slice(1) : seg;
  const cleaned = s.replace(/^[-.]+/, "");
  if (!cleaned) return null;

  // If it contains dots already, keep them. Otherwise convert hyphens/underscores to dots.
  const dotted = cleaned.includes(".")
    ? cleaned.replace(/[^0-9.]/g, ".")
    : cleaned.replace(/[^0-9]+/g, ".");

  const parts = dotted.split(".").filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return null; // allow 2-4 segments
  if (!parts.every((p) => /^\d+$/.test(p))) return null;

  return parts.join(".");
}

function parseVersionFromKey(key, prefix, baseName, ext) {
  // key: android/hypen-gallery-1.22.3.apk
  if (!key.startsWith(prefix)) return null;
  const file = key.slice(prefix.length);
  const m = file.match(new RegExp(`^${escapeRegExp(baseName)}(\\d+(?:\\.\\d+){1,3})\\.${escapeRegExp(ext)}$`));
  if (!m) return null;
  return m[1]; // "1.22.3"
}

function compareVersions(a, b) {
  // "1.22.3" vs "1.3.10"
  const pa = a.split(".").map((x) => parseInt(x, 10));
  const pb = b.split(".").map((x) => parseInt(x, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function findLatestKey(bucket, prefix, baseName, ext) {
  let cursor = undefined;
  let bestKey = null;
  let bestVer = null;

  while (true) {
    const res = await bucket.list({
      prefix,
      cursor,
      // You can add `limit` if you want, defaults are fine.
    });

    for (const obj of res.objects) {
      const ver = parseVersionFromKey(obj.key, prefix, baseName, ext);
      if (!ver) continue;
      if (!bestVer || compareVersions(ver, bestVer) > 0) {
        bestVer = ver;
        bestKey = obj.key;
      }
    }

    if (res.truncated) cursor = res.cursor;
    else break;
  }

  return bestKey;
}

function serveR2Object(bucket, key, ext, { immutable }) {
  return bucket.get(key).then((obj) => {
    if (!obj) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);

    // Content-Type (R2 may set this from upload metadata; we enforce a fallback)
    if (!headers.get("content-type")) {
      headers.set(
        "content-type",
        ext === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream"
      );
    }

    // Suggest download filename
    headers.set("content-disposition", `attachment; filename="${key.split("/").pop()}"`);

    // Cache strategy:
    // - versioned: immutable, cache forever
    // - latest: cache briefly (or not at all) so it updates fast
    headers.set(
      "cache-control",
      immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60" // change to "no-store" if you want instant flips
    );

    return new Response(obj.body, { headers });
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}