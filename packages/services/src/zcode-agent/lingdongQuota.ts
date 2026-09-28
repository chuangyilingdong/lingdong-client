import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("lingdong-quota");
let used = Math.max(0, Number(process.env.ZCODE_LINGDONG_SEND_USED ?? 0) || 0);
const limitRaw = Number(process.env.ZCODE_LINGDONG_SEND_LIMIT ?? "");
const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.floor(limitRaw) : null;

export function consumeLingdongSend(): void {
  if (limit !== null && used >= limit) {
    const error = Object.assign(new Error("本节课发送次数已用完"), {
      code: "SEND_QUOTA_EXCEEDED",
    });
    throw error;
  }
  used += 1;
  logger.info("课堂发送次数已消费", { classroomId: process.env.ZCODE_LINGDONG_CLASSROOM_ID ?? null, used, limit });
}

export function readLingdongSendQuota(): { readonly used: number; readonly limit: number | null } {
  return { used, limit };
}
