# RPC response completion repro

Two local Workers reproduce an intact response with a false runtime error and a truncated gzip response. No Cloudflare account or external service is required.

```sh
npm ci
npm run repro
```

Requires Node.js 20+. Pins `workerd 1.20260906.1` and compatibility date `2024-09-23`. The probe starts/stops workerd on `127.0.0.1:28179`, sends five requests per route, checks raw bytes and runtime logs, and writes `evidence/`.

| Route | Caller behavior | Observed result |
| --- | --- | --- |
| `/false-error` | RPC JSON → timer yield → uncompressed HTTP response | Complete `{"ok":true}`; HTTP 200; RPC error logged |
| `/truncated` | RPC JSON → timer yield → caller sets `Content-Encoding: gzip` | HTTP 200; only 10-byte gzip header; decompression fails; RPC error logged |
| `/control` | RPC JSON → immediately return with gzip | Complete JSON after decompression; no RPC error |

The runtime error is `ReadableStream received over RPC disconnected prematurely.`

**Gzip is applied to the caller's HTTP response, not the worker-to-worker RPC transport.** Every probe request advertises gzip; `/false-error` leaves the response encoding unset. This local test does not measure production impact.

To inspect manually, run `npm start` and request the routes above. The probe uses Node's HTTP client because it preserves compressed bytes for strict validation.

Verified on macOS ARM64 with Node.js 22.23.1; captured results and logs are in `verified/`.

Related report: [cloudflare/workerd#7277](https://github.com/cloudflare/workerd/issues/7277).
