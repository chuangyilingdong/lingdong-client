/* eslint-disable max-lines -- 平台反馈适配器集中维护协议映射、上传与日志归档，拆文件会分散同一条状态链 */
import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ApiClient,
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackTicketDetail,
  FeedbackTicketSummary,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { getFeedbackAttachmentDir } from "../paths.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { FeedbackUploadCanceledError } from "./feedbackHttpClient.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";

export interface CreatePlatformFeedbackServiceOptions {
  apiBaseUrl: string;
  authToken: string;
  getDeviceMid: () => string | undefined;
  apiClient: ApiClient;
  createFullLogArchive?: (
    sourceDir: string,
    options?: { onProgress?: (event: { processedBytes: number; totalBytes: number }) => void },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
}

interface PlatformAttachmentResponse {
  id: string;
  kind: FeedbackAttachmentKind;
  filename: string;
  size?: number | null;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at?: string | null;
}

interface PlatformCommentResponse {
  id?: number | string | null;
  message_id?: string | null;
  author_user_id?: string | null;
  author_display_name?: string | null;
  body: string;
  is_staff?: boolean;
  created_at?: string | null;
}

interface PlatformTicketResponse {
  id: string;
  title: string;
  type: FeedbackTicketSummary["type"];
  severity?: FeedbackTicketSummary["severity"];
  module?: FeedbackTicketSummary["module"];
  status: FeedbackTicketSummary["status"];
  raw_status?: string;
  reporter_display?: string | null;
  created_at: string;
  updated_at: string;
  description?: string;
  reporter?: FeedbackTicketDetail["reporter"];
  device?: FeedbackTicketDetail["device"];
  attachments?: PlatformAttachmentResponse[];
  comments?: PlatformCommentResponse[];
  events?: FeedbackTicketDetail["events"];
}

interface ApiEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
  success?: boolean;
  error?: { message?: string; code?: string };
}

const logger = createServiceLogger("platform-feedback");

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function stableNumericId(value: string): number {
  const id = createHash("sha256").update(value).digest().readUInt32BE(0);
  return id === 0 ? 1 : id;
}

function mapAttachment(value: PlatformAttachmentResponse): FeedbackAttachment {
  return {
    id: stableNumericId(value.id),
    kind: value.kind,
    filename: value.filename,
    size: Number(value.size || 0),
    redacted: false,
    content_type: value.content_type || null,
    download_url: value.download_url || null,
    preview_url: value.preview_url || null,
    created_at: value.created_at || new Date().toISOString(),
  };
}

function mapComment(value: PlatformCommentResponse): FeedbackComment {
  return {
    id: Number(value.id || stableNumericId(value.message_id || value.body)),
    message_id: value.message_id || undefined,
    author_user_id: value.author_user_id || null,
    author_display_name: value.author_display_name || null,
    body: value.body,
    is_staff: Boolean(value.is_staff),
    created_at: value.created_at || new Date().toISOString(),
  };
}

function mapSummary(value: PlatformTicketResponse): FeedbackTicketSummary {
  return {
    id: value.id,
    title: value.title,
    type: value.type,
    severity: value.severity,
    module: value.module,
    status: value.status,
    reporter_display: value.reporter_display || null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function mapDetail(value: PlatformTicketResponse): FeedbackTicketDetail {
  return {
    ...mapSummary(value),
    description: value.description || "",
    reporter: value.reporter || null,
    device: value.device || null,
    attachments: (value.attachments || []).map(mapAttachment),
    comments: (value.comments || []).map(mapComment),
    events: value.events || [],
    lark_record_id: null,
  };
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function payloadError(payload: unknown, fallback: string): Error {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (
      error &&
      typeof error === "object" &&
      typeof (error as Record<string, unknown>).message === "string"
    ) {
      return new Error(String((error as Record<string, unknown>).message));
    }
    if (typeof record.message === "string" && record.message.trim())
      return new Error(record.message);
    if (typeof record.msg === "string" && record.msg.trim()) return new Error(record.msg);
  }
  return new Error(fallback);
}

export function createPlatformFeedbackService(
  options: CreatePlatformFeedbackServiceOptions,
): IFeedbackService {
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();
  const activeCreateControllers = new Map<string, AbortController>();
  const activeUploadControllers = new Map<string, AbortController>();

  function getDeviceMid(): string {
    const value = options.getDeviceMid()?.trim();
    if (!value) throw new Error("Missing feedback device_mid");
    return value;
  }

  function authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${options.authToken}`,
      "X-Device-Mid": getDeviceMid(),
    };
  }

  async function requestJson<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await options.apiClient.request(joinUrl(options.apiBaseUrl, path), {
      ...init,
      signal,
      headers: {
        Accept: "application/json",
        ...authHeaders(),
        ...(init.body !== undefined && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
      },
    });
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw payloadError(payload, `平台反馈请求失败（HTTP ${response.status}）`);
    }
    const envelope = payload as ApiEnvelope<T> | null;
    if (envelope && typeof envelope === "object" && "code" in envelope && envelope.code !== 0) {
      throw payloadError(payload, `平台反馈请求失败（code ${String(envelope.code)}）`);
    }
    if (envelope && typeof envelope === "object" && "data" in envelope) {
      return envelope.data as T;
    }
    return payload as T;
  }

  async function uploadFile(
    ticketId: string,
    kind: FeedbackAttachmentKind,
    filePath: string,
    filename: string,
    contentType: string,
    uploadOptions?: {
      signal?: AbortSignal;
      onUploadProgress?: (event: { uploadedBytes: number; totalBytes: number }) => void;
    },
  ): Promise<FeedbackAttachment> {
    if (uploadOptions?.signal?.aborted) throw new FeedbackUploadCanceledError();
    const fileStat = await stat(filePath);
    const form = new FormData();
    form.set("category", "MEDIA_ASSET");
    form.set("visibility", "PRIVATE");
    form.set("file", await openAsBlob(filePath, { type: contentType }), filename);
    uploadOptions?.onUploadProgress?.({ uploadedBytes: 0, totalBytes: fileStat.size });
    try {
      const uploaded = await requestJson<PlatformAttachmentResponse>(
        `/api/client-feedback/${encodeURIComponent(ticketId)}/attachments?kind=${encodeURIComponent(kind)}`,
        { method: "POST", body: form },
        uploadOptions?.signal,
      );
      uploadOptions?.onUploadProgress?.({
        uploadedBytes: fileStat.size,
        totalBytes: fileStat.size,
      });
      return mapAttachment(uploaded);
    } catch (error) {
      if (uploadOptions?.signal?.aborted) throw new FeedbackUploadCanceledError();
      throw error;
    }
  }

  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  return {
    create: async (input: CreateFeedbackTicketInput, createOptions) => {
      const operationId = createOptions?.operationId?.trim() || randomUUID();
      const controller = new AbortController();
      activeCreateControllers.get(operationId)?.abort();
      activeCreateControllers.set(operationId, controller);
      try {
        const response = await requestJson<PlatformTicketResponse>(
          "/api/client-feedback",
          {
            method: "POST",
            body: JSON.stringify({
              idempotencyKey: operationId,
              title: input.title,
              description: input.description,
              type: input.type,
              severity: input.severity,
              module: input.module,
              contact: input.contact,
              environment: {
                ...input.device,
                source: input.source || "desktop-app",
                locale: input.locale,
              },
            }),
          },
          controller.signal,
        );
        logger.info("客户端反馈已提交到学习平台", {
          ticketId: response.id,
          type: response.type,
          status: response.status,
        });
        return mapDetail(response);
      } finally {
        if (activeCreateControllers.get(operationId) === controller) {
          activeCreateControllers.delete(operationId);
        }
      }
    },
    cancelCreate: async (operationId) => {
      activeCreateControllers.get(operationId.trim())?.abort();
    },
    list: async (query: FeedbackListQuery = {}): Promise<FeedbackListResult> => {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.offset !== undefined) params.set("offset", String(query.offset));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const result = await requestJson<{ items?: PlatformTicketResponse[]; total?: number }>(
        `/api/client-feedback${suffix}`,
      );
      const items = (result.items || []).map(mapSummary);
      return { items, total: Number(result.total ?? items.length) };
    },
    get: async (id) =>
      mapDetail(
        await requestJson<PlatformTicketResponse>(`/api/client-feedback/${encodeURIComponent(id)}`),
      ),
    comment: async (id, body) =>
      mapComment(
        await requestJson<PlatformCommentResponse>(
          `/api/client-feedback/${encodeURIComponent(id)}/messages`,
          { method: "POST", body: JSON.stringify({ body }) },
        ),
      ),
    uploadAttachment: async (id, kind, file) =>
      uploadFile(
        id,
        kind,
        file.path,
        file.filename || basename(file.path),
        file.contentType || (kind === "image" ? "image/png" : "application/zip"),
      ),
    uploadAttachmentWithProgress: async (id, kind, file, progressId) => {
      const filename = file.filename || basename(file.path);
      const contentType = file.contentType || (kind === "image" ? "image/png" : "application/zip");
      const emitter = getUploadProgressEmitter(progressId);
      emitter.fire({ id: progressId, phase: "preparing", uploadedBytes: 0, totalBytes: 0 });
      const controller = new AbortController();
      activeUploadControllers.set(progressId, controller);
      return uploadFile(id, kind, file.path, filename, contentType, {
        signal: controller.signal,
        onUploadProgress: (event) => {
          emitter.fire({
            id: progressId,
            phase:
              event.uploadedBytes >= event.totalBytes && event.totalBytes > 0
                ? "complete"
                : "uploading",
            uploadedBytes: event.uploadedBytes,
            totalBytes: event.totalBytes,
          });
        },
      })
        .catch((error) => {
          if (error instanceof FeedbackUploadCanceledError) {
            emitter.fire({ id: progressId, phase: "canceled", uploadedBytes: 0, totalBytes: 0 });
          }
          throw error;
        })
        .finally(() => {
          activeUploadControllers.delete(progressId);
        });
    },
    cancelUpload: async (progressId) => {
      activeUploadControllers.get(progressId)?.abort();
    },
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
    uploadAttachmentData: async (id, kind, file) => {
      const attachmentRootDir = getFeedbackAttachmentDir();
      await mkdir(attachmentRootDir, { recursive: true });
      const tempDir = await mkdtemp(join(attachmentRootDir, "platform-attachment-"));
      const filename = basename(file.filename.replaceAll("\\", "/")) || "attachment";
      const tempPath = join(tempDir, filename);
      try {
        await writeFile(tempPath, Buffer.from(file.dataBase64, "base64"));
        return await uploadFile(id, kind, tempPath, filename, file.contentType);
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    attachLogsFromExport: async (id, attachOptions) => {
      const archive = await prepareCompactLogArchive({
        full: attachOptions?.full,
        createFullArchive: options.createFullLogArchive,
      });
      try {
        return await uploadFile(id, "log", archive.path, basename(archive.path), "application/zip");
      } finally {
        await cleanupLogArchive(archive.path);
      }
    },
    getDeviceSnapshot: async () => {
      const { buildFeedbackDeviceSnapshot } = await import("./feedbackService.js");
      return buildFeedbackDeviceSnapshot();
    },
    prepareCompactLogArchive: async (archiveOptions) => {
      const progressId = archiveOptions?.progressId;
      const emitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: emitter
          ? (event) =>
              emitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              })
          : undefined,
      });
    },
    cleanupPreparedLogArchive: cleanupLogArchive,
    revealLogArchive: async (path) => {
      if (options.revealPath) await options.revealPath(path);
    },
  };
}
