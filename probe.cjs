const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const workerd = require("workerd");

const baseUrl = "http://127.0.0.1:28179";
const errorText = "ReadableStream received over RPC disconnected prematurely";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function get(route) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + route, {
      agent: false,
      headers: { "Accept-Encoding": "gzip" },
      signal: AbortSignal.timeout(3000),
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({
        status: res.statusCode,
        encoding: res.headers["content-encoding"] || "identity",
        httpComplete: res.complete,
        raw: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
  });
}

async function main() {
  let log = "";
  const server = spawn(workerd.default, ["serve", "config.capnp"], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { log += chunk; });
  server.stderr.on("data", (chunk) => { log += chunk; });
  let spawnError;
  server.on("error", (error) => { spawnError = error; });
  const exited = new Promise((resolve) => server.on("exit", resolve));
  const stop = () => server.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const results = [];

  try {
    const deadline = Date.now() + 10000;
    while (true) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error(`workerd exited: ${log}`);
      try {
        if ((await get("/health")).status === 200) break;
      } catch {
        if (Date.now() >= deadline) throw new Error(`workerd did not start: ${log}`);
      }
      await sleep(50);
    }

    for (const route of ["/false-error", "/truncated", "/control"]) {
      const logStart = log.length;
      const samples = [];
      for (let i = 0; i < 5; i++) {
        const response = await get(route);
        let decoded;
        let decodeError;
        try {
          decoded = response.encoding === "gzip"
            ? gunzipSync(response.raw)
            : response.raw;
          assert.deepEqual(JSON.parse(decoded.toString()), { ok: true });
        } catch (error) {
          decodeError = error.message;
        }
        samples.push({
          status: response.status,
          encoding: response.encoding,
          httpComplete: response.httpComplete,
          wireBytes: response.raw.length,
          wireHex: response.raw.toString("hex"),
          decodedBody: decoded?.toString(),
          validBody: !decodeError,
          decodeError,
        });
        await sleep(40);
      }
      await sleep(100);
      const runtimeErrors = log.slice(logStart).split(errorText).length - 1;
      results.push({ route, runtimeErrors, samples });
    }

    const [falseError, truncated, control] = results;
    assert.equal(falseError.runtimeErrors, 5, "Expected 5 logged false errors");
    assert.ok(falseError.samples.every((s) =>
      s.status === 200 && s.httpComplete && s.encoding === "identity" && s.validBody));
    assert.equal(truncated.runtimeErrors, 5, "Expected 5 gzip-path runtime errors");
    assert.ok(truncated.samples.every((s) =>
      s.status === 200 && s.httpComplete && s.encoding === "gzip" &&
      s.wireBytes === 10 && !s.validBody));
    assert.equal(control.runtimeErrors, 0, "Immediate-return control must not log the error");
    assert.ok(control.samples.every((s) =>
      s.status === 200 && s.httpComplete && s.encoding === "gzip" && s.validBody));
    console.table(results.map((r) => ({
      route: r.route,
      requests: r.samples.length,
      validBodies: r.samples.filter((s) => s.validBody).length,
      runtimeErrors: r.runtimeErrors,
      wireBytes: [...new Set(r.samples.map((s) => s.wireBytes))].join(","),
    })));
    console.log("Both failure signatures reproduced; clean control passed.");
  } finally {
    stop();
    await exited;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    fs.mkdirSync(path.join(__dirname, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "evidence/runtime.log"), log);
    fs.writeFileSync(path.join(__dirname, "evidence/results.json"), JSON.stringify({
      workerdVersion: workerd.version,
      compatibilityDate: "2024-09-23",
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      observedAt: new Date().toISOString(),
      results,
    }, null, 2) + "\n");
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
