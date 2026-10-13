export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ready");
    if (!["/false-error", "/truncated", "/control"].includes(path)) {
      return new Response("Not found", { status: 404 });
    }

    const rpcResponse = await env.CALLEE.getJson();
    if (path !== "/control") {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const response = new Response(rpcResponse.body, rpcResponse);
    if (path !== "/false-error") {
      // Compress the HTTP response in THIS Worker, not the RPC transport.
      response.headers.set("Content-Encoding", "gzip");
    }
    return response;
  },
};
