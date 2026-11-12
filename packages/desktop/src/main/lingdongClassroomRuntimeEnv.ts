export const LINGDONG_CLASSROOM_MODEL_STREAM_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
export const MODEL_STREAM_IDLE_TIMEOUT_ENV = "ZCODE_MODEL_STREAM_IDLE_TIMEOUT_MS";

interface LingdongClassroomRuntimeContext {
  readonly classroom: unknown | null;
  readonly prep?: unknown;
}

/**
 * 课堂请求可能只收到网关 SSE 心跳超过 10 分钟，Host 必须使用 20 分钟 idle timeout。
 * 备课和未开课没有课堂上下文，不能扩大普通客户端默认值。
 */
export function resolveLingdongClassroomRuntimeEnv(
  context: LingdongClassroomRuntimeContext,
): Record<string, string> {
  if (context.classroom === null || context.classroom === undefined || context.prep === true) {
    return {};
  }

  return {
    [MODEL_STREAM_IDLE_TIMEOUT_ENV]: String(LINGDONG_CLASSROOM_MODEL_STREAM_IDLE_TIMEOUT_MS),
  };
}
