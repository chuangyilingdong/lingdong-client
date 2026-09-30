import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckSquare, FileUp, MinusSquare, RefreshCw, Square } from "lucide-react";
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
// 平台侧可调（RUNTIME_UPLOAD_MAX_BYTES），这里必须跟它保持一致——
// 否则超过客户端这条线的好素材会被静默丢掉，学生与平台两边都看不出原因。
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
      const files = result.files ?? [];
      setSelected(new Set(files.slice(0, 1).map((file) => file.path)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [classroom]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const files = scan?.files ?? [];
  const allSelected = files.length > 0 && selected.size === files.length;
  const someSelected = selected.size > 0 && !allSelected;
  const selectedFiles = useMemo(
    () => files.filter((file) => selected.has(file.path)),
    [files, selected],
  );

  const oversizedFiles = useMemo(
    () => selectedFiles.filter((file) => file.size > MAX_SUBMIT_TOTAL_BYTES),
    [selectedFiles],
  );
  const oversizedPaths = useMemo(
    () => new Set(oversizedFiles.map((file) => file.path)),
    [oversizedFiles],
  );

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submit = async () => {
    if (!scan || selectedFiles.length === 0) return;
    setBusy(true);
    setMessage("");
    try {
      if (!classroom) throw new Error("当前环境不支持课堂作品提交。");
      // copyrightConfirmed 只在用户点击提交按钮后置真；UI 不做默认确认。
      const result = await classroom.submitWork({
        copyrightConfirmed: true,
        items: selectedFiles.map((file) => ({ path: file.path, name: file.relativePath })),
      });
      if (result?.ok === false) throw new Error(result.message || "提交失败。");
      // 平台新版提交响应直接带 works；未发版时回落到作品列表接口，两条路都要能用。
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
      setMessage(nextCount === null ? "作品已提交，平台正在处理。" : `作品已提交，平台当前返回 ${nextCount} 条作品记录。`);
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
            从当前课堂工作区选择需要提交的文件。文件会通过灵动ai平台上传，不会把平台 token 暴露给页面。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
            {scan?.workspacePath || "正在读取课堂工作区…"}
          </span>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
          </Button>
        </div>
        <div className="max-h-[360px] overflow-auto rounded-lg border border-border">
          {files.length === 0 ? (
            <div className="p-8 text-center text-ui-sm text-foreground-subtle">当前工作区没有可提交文件。</div>
          ) : (
            <div className="divide-y divide-border">
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-ui-sm hover:bg-surface-hover"
                onClick={() => setSelected(allSelected ? new Set() : new Set(files.map((file) => file.path)))}
              >
                {/* 以前未选中也画一个勾、只是变暗，学生根本分不清「全选了没」。 */}
                {allSelected ? (
                  <CheckSquare className="size-4 text-brand" />
                ) : someSelected ? (
                  <MinusSquare className="size-4 text-foreground-subtle" />
                ) : (
                  <Square className="size-4 text-foreground-subtle" />
                )}
                <span className="font-medium">{allSelected ? "取消全选" : "全选可提交文件"}</span>
                <span className="ml-auto text-foreground-subtle">{files.length} 个</span>
              </button>
              {files.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover"
                  onClick={() => toggle(file.path)}
                >
                  {/* 未勾选必须是空框，不能是「暗勾」。 */}
                  {selected.has(file.path) ? (
                    <CheckSquare className="size-4 text-brand" />
                  ) : (
                    <Square className="size-4 text-foreground-subtle" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-ui-sm">{file.relativePath}</span>
                  <span
                    className={cn(
                      "shrink-0 text-ui-xs",
                      oversizedPaths.has(file.path) ? "text-warning" : "text-foreground-subtle",
                    )}
                  >
                    {formatBytes(file.size)}
                    {oversizedPaths.has(file.path) ? " · 超上限" : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {message ? <div className="rounded-lg bg-accent px-3 py-2 text-ui-sm text-foreground">{message}</div> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || selectedFiles.length === 0}>
            {/* 该按钮即“确认原创并提交”，copyrightConfirmed 只在用户点击后置真。 */}
            {busy ? "处理中…" : `确认并提交 ${selectedFiles.length} 个文件`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
