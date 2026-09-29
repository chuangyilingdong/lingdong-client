import { homedir } from "node:os";
import { join } from "node:path";

export const LINGDONG_PRODUCTION_APP_NAME = "灵动ai创作客户端";
export const LINGDONG_PREVIEW_APP_NAME = "灵动ai创作客户端 Preview";
export const ZCODE_DEVELOPMENT_APP_NAME = "ZCode Dev";

export function resolveDesktopApplicationName(options: {
  readonly env: Record<string, string | undefined>;
  readonly isPackaged: boolean;
  readonly flavor: "production" | "preview";
}) {
  const override = options.env.ZCODE_DESKTOP_APPLICATION_NAME?.trim();
  if (override) return override;
  if (!options.isPackaged) return ZCODE_DEVELOPMENT_APP_NAME;
  return options.flavor === "preview" ? LINGDONG_PREVIEW_APP_NAME : LINGDONG_PRODUCTION_APP_NAME;
}

export function resolveProductUserDataDir(options: {
  readonly env: Record<string, string | undefined>;
  readonly platform: string;
  readonly home: string;
}) {
  const override = options.env.ZCODE_DESKTOP_USER_DATA_DIR?.trim();
  if (override) return override;
  if (options.platform === "win32" && options.env.APPDATA?.trim()) {
    return join(options.env.APPDATA.trim(), LINGDONG_PRODUCTION_APP_NAME);
  }
  if (options.platform === "darwin") {
    return join(options.home, "Library", "Application Support", LINGDONG_PRODUCTION_APP_NAME);
  }
  return join(
    options.env.XDG_CONFIG_HOME?.trim() || join(options.home, ".config"),
    LINGDONG_PRODUCTION_APP_NAME,
  );
}

export function defaultProductUserDataDir() {
  return resolveProductUserDataDir({
    env: process.env,
    platform: process.platform,
    home: homedir(),
  });
}
