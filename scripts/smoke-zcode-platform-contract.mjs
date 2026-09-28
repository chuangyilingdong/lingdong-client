#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.LINGDONG_SMOKE_PORT || 19190);
const sessionToken = "smoke-platform-session";
const gatewayKey = "smoke-gateway-key";
const classroomA = { id: "classroom-a", lessonId: "lesson-a", title: "课堂 A" };
const classroomB = { id: "classroom-b", lessonId: "lesson-b", title: "课堂 B" };

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function contextFor(classroom) {
  return {
    classroom,
    classrooms: [classroomA, classroomB],
    reason: null,
    gateway: { baseUrl: `http://${HOST}:${PORT}/gateway`, key: gatewayKey },
    models: [{ id: "mock-model", displayName: "Mock Model" }],
    defaultModel: "mock-model",
    presets: [{ title: "课堂预设", text: "先检查工作区" }],
    sends: { limit: 5, used: 1, remaining: 4 },
    workspacePath: "C:/mock/classroom",
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/auth/login" && req.method === "POST") {
      await readJson(req);
      return json(res, 200, { token: sessionToken, user: { id: "student-1", login: "smoke" } });
    }
    if (req.url?.startsWith("/api/student/runtime/client-context") && req.method === "GET") {
      const id = new URL(req.url, `http://${HOST}:${PORT}`).searchParams.get("sessionId");
      return json(res, 200, contextFor(id === classroomB.id ? classroomB : classroomA));
    }
    if (req.url?.startsWith("/api/student/runtime/submit-upload") && req.method === "POST") {
      const payload = await readJson(req);
      assert.equal(payload.copyrightConfirmed, true);
      assert.equal(payload.name, "index.html");
      assert.ok(Array.isArray(payload.files));
      assert.ok(payload.files.some((file) => file.name === "index.html" && file.binary === false));
      assert.ok(payload.files.some((file) => file.name === "hero.png" && file.binary === true));
      return json(res, 200, { ok: true, warnings: [], missing: [], works: [] });
    }
    if (req.url?.startsWith("/api/student/works") && req.method === "GET") {
      return json(res, 200, { items: [], total: 0 });
    }
    if (req.url === "/gateway" && req.method === "POST") {
      assert.equal(req.headers.authorization, `Bearer ${gatewayKey}`);
      const payload = await readJson(req);
      assert.equal(payload.model, "mock-model");
      assert.ok(Array.isArray(payload.tools));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read_file", arguments: "{}" } }] } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

function request(path, { method = "GET", body, token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST,
      port: PORT,
      path,
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

await new Promise((resolve) => server.listen(PORT, HOST, resolve));
try {
  const login = await request("/api/auth/login", { method: "POST", body: { login: "smoke", password: "smoke" } });
  assert.equal(login.status, 200);
  const token = JSON.parse(login.body).token;
  assert.equal(token, sessionToken);

  const context = await request("/api/student/runtime/client-context?sessionId=classroom-b", { token });
  assert.equal(context.status, 200);
  const contextBody = JSON.parse(context.body);
  assert.equal(contextBody.classroom.id, classroomB.id);
  assert.equal(contextBody.gateway.key, gatewayKey);
  assert.equal(contextBody.defaultModel, "mock-model");
  assert.equal(contextBody.presets.length, 1);
  assert.equal(contextBody.sends.remaining, 4);

  const upload = await request("/api/student/runtime/submit-upload?sessionId=classroom-b", {
    method: "POST",
    token,
    body: {
      name: "index.html",
      copyrightConfirmed: true,
      files: [
        { name: "index.html", content: "<h1>smoke</h1>", binary: false },
        { name: "hero.png", content: Buffer.from("png").toString("base64"), binary: true },
      ],
    },
  });
  assert.equal(upload.status, 200);

  const stream = await request("/gateway", {
    method: "POST",
    token: gatewayKey,
    body: { model: "mock-model", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read_file" } }], stream: true },
  });
  assert.equal(stream.status, 200);
  assert.match(stream.body, /tool_calls/);
  console.log(JSON.stringify({ pass: true, port: PORT, classroom: classroomB.id, model: contextBody.defaultModel }));
} finally {
  server.close();
}

