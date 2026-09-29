import { useCallback, useEffect, useState } from "react";
import { BookOpen, Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";

type Preset = Readonly<{ title?: unknown; text?: unknown }>;
function asPresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Preset => typeof item === "object" && item !== null);
}

export function LingdongPresetsDialog({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selected, setSelected] = useState<Preset | null>(null);
  const [message, setMessage] = useState("");

  // 课堂能力由宿主平台合同提供；Web/手机缺省时按"没有预设"处理。
  const classroom = usePlatform().classroom;
  const refresh = useCallback(async () => {
    setPresets(asPresets(classroom ? await classroom.getPresets() : undefined));
  }, [classroom]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const insert = (preset: Preset) => {
    const text = typeof preset.text === "string" ? preset.text.trim() : "";
    if (!text || !workspacePath) return;
    useZCodeSessionStore
      .getState()
      .requestComposerTextInsert(
        workspacePath,
        text,
        workspaceIdentity,
        undefined,
        "prepend-if-missing",
      );
    setSelected(preset);
    setMessage("已插入当前任务输入框。");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-ui-lg">
            <BookOpen className="size-5" />
            课堂提示词预设
          </DialogTitle>
          <DialogDescription>
            平台下发的课堂预设会插入当前小灵任务草稿，不会自动发送。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[360px] space-y-2 overflow-auto">
          {presets.length === 0 ? (
            <div className="p-8 text-center text-ui-sm text-foreground-subtle">
              当前课堂没有提示词预设。
            </div>
          ) : null}
          {presets.map((preset, index) => {
            const title =
              typeof preset.title === "string" && preset.title.trim()
                ? preset.title
                : `预设 ${index + 1}`;
            const text = typeof preset.text === "string" ? preset.text : "";
            const active = selected === preset;
            return (
              <button
                key={`${title}-${index}`}
                type="button"
                onClick={() => insert(preset)}
                className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left hover:bg-surface-hover"
              >
                <Sparkles className="mt-0.5 size-4 shrink-0 text-brand" />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui-sm font-medium">{title}</span>
                  <span className="mt-1 block whitespace-pre-wrap text-ui-xs text-foreground-subtle line-clamp-3">
                    {text}
                  </span>
                </span>
                {active ? <Check className="size-4 text-success" /> : null}
              </button>
            );
          })}
        </div>
        {message ? (
          <div className="rounded-lg bg-accent px-3 py-2 text-ui-sm">{message}</div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
