import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckSquare, FileUp, RefreshCw } from "lucide-react";
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

type Candidate = Readonly<{
  path: string;
  relativePath: string;
  size: number;
  updatedAt: number;
}>;

type ScanResult = Readonly<{
  ok?: boolean;
  message?: string;
  files?: readonly Candidate[];
  workspacePath?: string;
  workspaceIdentity?: string;
}>;

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
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = (await (window as Window & { lingdong?: { scanWorkspaceFiles(): Promise<unknown> } }).lingdong?.scanWorkspaceFiles()) as ScanResult | undefined;
      if (!result?.ok) throw new Error(result?.message || "无法扫描课堂工作区。");
      setScan(result);
      const files = result.files ?? [];
      setSelected(new Set(files.slice(0, 1).map((file) => file.path)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const files = scan?.files ?? [];
  const allSelected = files.length > 0 && selected.size === files.length;
  const selectedFiles = useMemo(
    () => files.filter((file) => selected.has(file.path)),
    [files, selected],
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
      const result = (await (window as Window & { lingdong?: { submitWork(payload: unknown): Promise<unknown> } }).lingdong?.submitWork({
        copyrightConfirmed: true,
        classroomId: undefined,
        workspacePath: scan.workspacePath,
        workspaceIdentity: scan.workspaceIdentity,
        items: selectedFiles,
      })) as { message?: string; ok?: boolean } | undefined;
      if (result?.ok === false) throw new Error(result.message || "提交失败。");
      setMessage("作品已提交，平台正在处理。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
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
                <CheckSquare className={cn("size-4", allSelected ? "text-brand" : "text-foreground-subtle")} />
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
                  <CheckSquare className={cn("size-4", selected.has(file.path) ? "text-brand" : "text-foreground-subtle")} />
                  <span className="min-w-0 flex-1 truncate text-ui-sm">{file.relativePath}</span>
                  <span className="shrink-0 text-ui-xs text-foreground-subtle">{formatBytes(file.size)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {message ? <div className="rounded-lg bg-accent px-3 py-2 text-ui-sm text-foreground">{message}</div> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || selectedFiles.length === 0}>
            {busy ? "处理中…" : `提交 ${selectedFiles.length} 个文件`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
