import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { buildPreviewDocument } from "@zcode/shared";

type WorksLlmInput = Readonly<{ grant?: unknown }> | null | undefined;
type PreviewFileMap = Readonly<Record<string, string>>;

type LocalPreviewRecord = Readonly<{
  kind: "local";
  createdAt: number;
  root: string;
  entryDir: string;
  entryName: string;
  files: PreviewFileMap;
  worksLlm: WorksLlmInput;
}>;

type UploadedPreviewRecord = Readonly<{
  kind: "uploaded";
  createdAt: number;
  entryName: string;
  files: PreviewFileMap;
  worksLlm: WorksLlmInput;
}>;

type PreviewRecord = LocalPreviewRecord | UploadedPreviewRecord;

export interface LingdongWorkPreviewServer {
  prepareLocal(input: {
    root: string;
    entryDir: string;
    entryName: string;
    files: PreviewFileMap;
    worksLlm?: WorksLlmInput;
  }): Promise<string>;
  prepareUploaded(input: {
    entryName: string;
    files: PreviewFileMap;
    worksLlm?: WorksLlmInput;
  }): Promise<string>;
  close(): Promise<void>;
}

const PREVIEW_TTL_MS = 60 * 60 * 1000;
const PREVIEW_MAX_RECORDS = 32;

function worksLlmForPreview(worksLlm: WorksLlmInput): { grant: string; endpoint: string } | null {
  if (typeof worksLlm?.grant !== "string" || !worksLlm.grant.trim()) return null;
  return { grant: worksLlm.grant.trim(), endpoint: "/platform/api/works-llm/chat" };
}

function contentTypeForPath(path: string): string {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".htm": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".cjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".pdf": "application/pdf",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
    } as Record<string, string>
  )[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function pathInside(root: string, target: string): boolean {
  const candidate = relative(root, target);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function decodePathname(requestUrl: string | undefined): string {
  return new URL(requestUrl || "/", "http://127.0.0.1").pathname.split("/").map((part) => decodeURIComponent(part)).join("/");
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function createLingdongWorkPreviewServer(options: {
  platformBaseUrl: string;
  getPlatformToken: () => string | null;
  now?: () => number;
  ttlMs?: number;
  maxRecords?: number;
}): LingdongWorkPreviewServer {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
  const maxRecords = options.maxRecords ?? PREVIEW_MAX_RECORDS;
  const records = new Map<string, PreviewRecord>();
  let server: Server | null = null;
  let port: number | null = null;
  let starting: Promise<void> | null = null;

  const prune = () => {
    const current = now();
    for (const [token, record] of records) {
      if (record.createdAt + ttlMs <= current) records.delete(token);
    }
    while (records.size > maxRecords) records.delete(records.keys().next().value as string);
  };

  const ensureListening = async (): Promise<void> => {
    if (port !== null) return;
    if (starting) return await starting;
    starting = new Promise<void>((resolveReady, rejectReady) => {
      const nextServer = createServer((request, response) => {
        void handleRequest(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(404, { "cache-control": "no-store" });
          response.end("Not found");
        });
      });
      nextServer.once("error", rejectReady);
      nextServer.listen(0, "127.0.0.1", () => {
        const address = nextServer.address();
        if (!address || typeof address === "string") {
          rejectReady(new Error("作品预览服务没有拿到监听端口"));
          return;
        }
        server = nextServer;
        port = address.port;
        resolveReady();
      });
    }).finally(() => {
      starting = null;
    });
    await starting;
  };

  const previewUrl = async (record: Omit<PreviewRecord, "createdAt">): Promise<string> => {
    await ensureListening();
    prune();
    const token = randomUUID();
    records.set(token, { ...record, createdAt: now() } as PreviewRecord);
    return `http://127.0.0.1:${port}/preview/${token}/`;
  };

  const servePreview = async (token: string, requestedPath: string, response: ServerResponse) => {
    prune();
    const record = records.get(token);
    if (!record) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end("Preview expired");
      return;
    }
    if (!requestedPath) {
      const html = buildPreviewDocument(record.files, record.entryName, {
        worksLlm: worksLlmForPreview(record.worksLlm),
      }).replace(
        /<head[^>]*>/iu,
        (match) => `${match}<script>window.__ZCODE_WORK_PREVIEW_NATIVE_ASSETS__=true;</script>`,
      );
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(html);
      return;
    }
    if (record.kind === "uploaded") {
      const entryDir = dirname(record.entryName).replaceAll("\\", "/");
      const resolvedName =
        record.files[requestedPath] !== undefined
          ? requestedPath
          : entryDir === "."
            ? requestedPath
            : `${entryDir}/${requestedPath}`;
      const content = record.files[resolvedName];
      if (content === undefined) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end("Asset not found");
        return;
      }
      response.writeHead(200, {
        "content-type": contentTypeForPath(resolvedName),
        "cache-control": "no-store",
      });
      response.end(content);
      return;
    }
    const target = resolve(record.entryDir, requestedPath);
    if (!pathInside(record.root, target) || !pathInside(record.entryDir, target)) {
      response.writeHead(403, { "cache-control": "no-store" });
      response.end("Forbidden");
      return;
    }
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end("Asset not found");
      return;
    }
    response.writeHead(200, {
      "content-type": contentTypeForPath(target),
      "cache-control": "no-store",
    });
    createReadStream(target).pipe(response);
  };

  const proxyPlatform = async (request: IncomingMessage, response: ServerResponse, pathname: string) => {
    const platformPath = pathname.startsWith("/platform/")
      ? pathname.slice("/platform".length)
      : pathname;
    if (!platformPath.startsWith("/api/")) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end("Unsupported proxy path");
      return;
    }
    const headers = new Headers();
    const token = options.getPlatformToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const contentType = request.headers["content-type"];
    if (typeof contentType === "string") headers.set("content-type", contentType);
    const body = await readRequestBody(request);
    const upstream = await fetch(`${options.platformBaseUrl.replace(/\/+$/u, "")}${platformPath}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    if (upstream.body) {
      Readable.fromWeb(upstream.body as never).pipe(response);
    } else {
      response.end();
    }
  };

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = decodePathname(request.url);
    if (pathname.startsWith("/api/") || pathname.startsWith("/platform/api/")) {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      await proxyPlatform(request, response, pathname);
      return;
    }
    const match = /^\/preview\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
    if (!match) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    await servePreview(match[1]!, match[2] ?? "", response);
  };

  return {
    prepareLocal(input) {
      return previewUrl({
        kind: "local",
        root: resolve(input.root),
        entryDir: resolve(input.entryDir),
        entryName: input.entryName,
        files: input.files,
        worksLlm: input.worksLlm,
      });
    },
    prepareUploaded(input) {
      return previewUrl({
        kind: "uploaded",
        entryName: input.entryName,
        files: input.files,
        worksLlm: input.worksLlm,
      });
    },
    async close() {
      const current = server;
      server = null;
      port = null;
      records.clear();
      if (!current) return;
      current.closeAllConnections?.();
      current.closeIdleConnections?.();
      await new Promise<void>((resolveClosed) => current.close(() => resolveClosed()));
    },
  };
}