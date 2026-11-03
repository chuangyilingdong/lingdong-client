import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLingdongWorkPreviewServer } from "../src/main/lingdongWorkPreviewServer.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("本地作品预览注入 worksLlm、内联样式并代理平台模型请求", async () => {
  const root = await mkdtemp(join(tmpdir(), "lingdong-preview-"));
  const upstreamRequests = [];
  const upstream = createServer(async (request, response) => {
    if (request.url === "/api/works-llm/chat") {
      let body = "";
      for await (const chunk of request) body += chunk;
      upstreamRequests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: { ok: true, content: "OK" } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const upstreamUrl = await listen(upstream);
  const preview = createLingdongWorkPreviewServer({
    platformBaseUrl: upstreamUrl,
    getPlatformToken: () => "platform-token",
  });
  try {
    await writeFile(join(root, "index.html"), '<html><head><link rel="stylesheet" href="style.css"></head><body><h1>Hello</h1></body></html>');
    await writeFile(join(root, "style.css"), "h1 { color: red; }");
    const url = await preview.prepareLocal({
      root,
      entryDir: root,
      entryName: "index.html",
      files: { "index.html": await readFileText(join(root, "index.html")), "style.css": "h1 { color: red; }" },
      worksLlm: { grant: "grant-123" },
    });
    const html = await (await fetch(url)).text();
    assert.match(html, /window\.__ZCODE_WORK_PREVIEW_NATIVE_ASSETS__=true/u);
    assert.match(html, /window\.__PLATFORM_WORK_LLM__=/u);
    assert.match(html, /grant-123/u);
    assert.match(html, /h1 \{ color: red; \}/u);
    const asset = await fetch(new URL("style.css", url));
    assert.equal(await asset.text(), "h1 { color: red; }");

    const response = await fetch(new URL("/platform/api/works-llm/chat", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: "grant-123", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].authorization, "Bearer platform-token");
    assert.equal(upstreamRequests[0].body.grant, "grant-123");
  } finally {
    await preview.close();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("已提交作品预览使用文件映射，过期 token 返回 404", async () => {
  let clock = 1_000;
  const preview = createLingdongWorkPreviewServer({
    platformBaseUrl: "http://127.0.0.1:9",
    getPlatformToken: () => null,
    now: () => clock,
    ttlMs: 100,
  });
  try {
    const url = await preview.prepareUploaded({
      entryName: "index.html",
      files: { "index.html": "<html><body>submitted</body></html>" },
      worksLlm: null,
    });
    assert.match(await (await fetch(url)).text(), /submitted/u);
    clock = 2_000;
    assert.equal((await fetch(url)).status, 404);
  } finally {
    await preview.close();
  }
});

async function readFileText(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}