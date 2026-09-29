import { useCallback, useEffect, useRef, useState } from "react";
import type { ClassroomPlatformSnapshot } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

/**
 * 读取桌面课堂只读快照。
 *
 * 额度会随发送本地账本变化，调用方需要实时展示时传 pollMs；账号和模型映射只需一次读取。
 * Web/手机没有 classroom 能力，hook 返回 null，不影响现有页面。
 */
export function useClassroomPlatformSnapshot(options: { pollMs?: number } = {}) {
  const platform = usePlatform();
  const classroom = platform.classroom;
  const pollMs = Math.max(0, options.pollMs ?? 0);
  const [snapshot, setSnapshot] = useState<ClassroomPlatformSnapshot | null>(null);
  const snapshotRef = useRef<ClassroomPlatformSnapshot | null>(null);

  const applySnapshot = useCallback((next: ClassroomPlatformSnapshot | null) => {
    if (JSON.stringify(next) === JSON.stringify(snapshotRef.current)) return;
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const readSnapshot = useCallback(async () => {
    if (!classroom?.getSnapshot) return;
    try {
      applySnapshot(await classroom.getSnapshot());
    } catch (error) {
      logger.warn("[classroom] 读取平台快照失败", { error });
    }
  }, [applySnapshot, classroom]);

  useEffect(() => {
    let disposed = false;
    const read = async () => {
      if (!classroom?.getSnapshot) return;
      try {
        const next = await classroom.getSnapshot();
        if (!disposed) applySnapshot(next);
      } catch (error) {
        logger.warn("[classroom] 读取平台快照失败", { error });
      }
    };
    void read();
    if (pollMs <= 0) {
      return () => {
        disposed = true;
      };
    }
    const timer = window.setInterval(() => void read(), pollMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [applySnapshot, classroom, pollMs]);

  return { snapshot, refresh: readSnapshot };
}
