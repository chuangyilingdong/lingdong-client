import type { ReactNode } from "react";
import lingdongAppIconUrl from "@/assets/lingdong-app-icon.png";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <LingdongStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用灵动ai品牌图标，保持底色、圆角和标志比例一致。 */
export function LingdongStartupLogoBadge({ animated = true }: { animated?: boolean }) {
  return (
    <div className="relative flex size-24 items-center justify-center overflow-hidden rounded-3xl shadow-xl/20">
      <img
        src={lingdongAppIconUrl}
        alt="灵动ai"
        className={cn("size-full select-none object-cover", animated && "animate-pulse")}
        draggable={false}
      />
    </div>
  );
}
