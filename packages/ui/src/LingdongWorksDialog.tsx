import { useCallback, useEffect, useState } from "react";
import { FileText, FileUp, Paperclip, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import type { ClassroomWorkspaceScan } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";

// 平台单次提交的整单上限（base64 解码后合计，封面另算）：现在是 100MB。
// 平台侧可调（RUNTIME_UPLOAD_MAX_BYTES），这里必须跟它保持一致。
const MAX_SUBMIT_TOTAL_BYTES = 100 * 1024 * 1024;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function LingdongWorksDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const classroom = usePlatform().classroom;
  const [scan, setScan] = useState<ClassroomWorkspaceScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      if (!classroom) throw new Error("当前环境不支持课堂作品提交。");
      const result = await classroom.scanWorkspaceFiles();
      if (!result?.ok) throw new Error(result.message || "无法扫描课堂工作区。");
      setScan(result);
    } catch (error) {
      setScan(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [classroom]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const preview = scan?.preview;
  const autoIncludedFiles = preview?.files.filter((file) => file.autoIncluded) ?? [];
  const totalBytes = preview?.totalBytes ?? 0;
  const overLimit = totalBytes > MAX_SUBMIT_TOTAL_BYTES;
  const noNewOutput = Boolean(preview?.submitted && !preview.hasNewOutput);
  const hasSubmittedBefore = Boolean(preview?.lastSubmittedAt);
  const canSubmit = Boolean(preview && !overLimit && !noNewOutput);

  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setMessage("");
    try {
      if (!classroom) throw new Error("当前环境不支持课堂作品提交。");
      // 只提交主作品；引用素材由宿主用与预览相同的规则自动打包。
      const result = await classroom.submitWork({
        copyrightConfirmed: true,
        items: [{ path: preview.entry.path, name: preview.entry.relativePath }],
      });
      if (result?.ok === false) throw new Error(result.message || "提交失败。");
      const submitted = Array.isArray(result?.works) ? result.works : null;
      let nextCount: number | null = null;
      if (submitted) {
        nextCount = submitted.length;
      } else {
        const works = await classroom.listWorks();
        nextCount = Array.isArray(works?.items)
          ? works.items.length
          : Array.isArray(works?.works)
            ? works.works.length
            : null;
      }
      try {
        const nextScan = await classroom.scanWorkspaceFiles();
        if (nextScan?.ok) setScan(nextScan);
      } catch {
        // 提交已经成功；重扫失败只影响按钮状态，不能把成功改判成失败。
      }
      setMessage(
        nextCount === null
          ? "作品已提交，平台正在处理。"
          : `作品已提交，平台当前返回 ${nextCount} 条作品记录。`,
      );
    } catch (error) {
      // Electron 的 IPC 拒绝会把方法名拼进 message，学生不该看到那串内部前缀。
      const raw = error instanceof Error ? error.message : String(error);
      setMessage(raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/u, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-ui-lg">
            <FileUp className="size-5" /> 提交课堂作品
          </DialogTitle>
          <DialogDescription>
            只选择主作品文件，引用的素材会按相对路径自动一起提交。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
            {scan?.workspacePath || "正在读取课堂工作区…"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh()}
            disabled={busy}
          >
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
          </Button>
        </div>
        <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
          {preview ? (
            <div className="divide-y divide-border">
              <div className="flex items-center gap-3 px-3 py-3">
                <FileText className="size-5 shrink-0 text-brand" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui-sm font-medium">
                    {preview.entry.relativePath}
                  </div>
                  <div className="mt-0.5 text-ui-xs text-foreground-subtle">
                    主作品 · {formatBytes(preview.entry.size)}
                  </div>
                </div>
              </div>
              {autoIncludedFiles.length > 0 ? (
                <div className="space-y-2 px-3 py-3">
                  <div className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
                    <Paperclip className="size-3.5" />
                    自动包含 {autoIncludedFiles.length} 个引用文件
                  </div>
                  <div className="space-y-1.5">
                    {autoIncludedFiles.map((file) => (
                      <div key={file.path} className="flex items-center gap-3 text-ui-sm">
                        <span className="min-w-0 flex-1 truncate text-foreground-subtle">
                          {file.relativePath}
                        </span>
                        <span className="shrink-0 text-ui-xs text-foreground-subtle">
                          {formatBytes(file.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="px-3 py-2 text-ui-xs text-foreground-subtle">
                  未检测到需要自动包含的引用文件。
                </div>
              )}
            </div>
          ) : (
            <div className="p-8 text-center text-ui-sm text-foreground-subtle">
              {scan?.previewError || "当前工作区没有可提交的主作品文件。"}
            </div>
          )}
        </div>
        <div
          className={cn(
            "flex items-center justify-between rounded-lg border px-3 py-2 text-ui-sm",
            overLimit ? "border-warning/40 bg-warning/10 text-warning" : "border-border bg-surface",
          )}
        >
          <span>
            {noNewOutput
              ? "已提交，当前没有新产出"
              : hasSubmittedBefore
                ? `检测到新产出 · 将提交 ${preview?.files.length ?? 0} 个文件`
                : `最终将提交 ${preview?.files.length ?? 0} 个文件`}
          </span>
          <span>总大小 {preview ? formatBytes(totalBytes) : "—"}</span>
        </div>
        {overLimit ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-warning">
            平台单次提交上限 {formatBytes(MAX_SUBMIT_TOTAL_BYTES)}，当前总大小已超出。
          </div>
        ) : null}
        {message ? (
          <div className="rounded-lg bg-accent px-3 py-2 text-ui-sm text-foreground">{message}</div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || !canSubmit}>
            {busy
              ? "处理中…"
              : noNewOutput
                ? "已提交，无新产出"
                : hasSubmittedBefore
                  ? "确认并提交新版本"
                  : "确认并提交主作品"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
