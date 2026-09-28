import { posix } from "node:path";
import type { CustomPublishOptions, PackageFileInfo } from "builder-util-runtime";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  normalizeZCodeEndpointOrigin,
  type ElectronReleaseChannel,
} from "@zcode/shared";
import {
  Provider,
  AppImageUpdater,
  DebUpdater,
  RpmUpdater,
  PacmanUpdater,
  type AppUpdater,
  type ResolvedUpdateFileInfo,
  type UpdateFileInfo,
  type UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import { parse as parseYaml } from "yaml";

const ELECTRON_MANIFEST_API_PATH = "/api/v1/releases/electron/manifest";

const MANIFEST_ACCEPT_HEADER = "application/json,application/x-yaml,text/yaml,text/plain,*/*";
const LINGDONG_DOWNLOAD_MANIFEST_URL = "https://aicyld.com/downloads/manifest.json";

interface ManifestUpdateProviderOptions extends CustomPublishOptions {
  endpointOrigin?: string;
  manifestUrl?: string;
  deviceMid?: string;
  releasePlatform?: string;
  releaseChannel?: ElectronReleaseChannel;
  resolveEndpointOrigin?: () => string | Promise<string>;
  resolveReleaseChannel?: () => ElectronReleaseChannel | Promise<ElectronReleaseChannel>;
}

function normalizeReleaseChannel(channel: string | null | undefined): ElectronReleaseChannel {
  return channel === "preview" ? "preview" : "stable";
}

function mapReleaseChannelToApiValue(channel: ElectronReleaseChannel): string {
  return channel === "preview" ? "3" : "1";
}

function mapElectronReleaseArch(arch: string): string {
  switch (arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    case "ia32":
      return "x86";
    default:
      return arch;
  }
}

function mapElectronReleasePlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return platform;
  }
}

export function getElectronReleasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch = process.env["TEST_UPDATER_ARCH"] || process.arch,
): string {
  return `${mapElectronReleasePlatform(platform)}-${mapElectronReleaseArch(arch)}`;
}

type LingdongDownloadManifestFile = Readonly<{
  version?: unknown;
  name?: unknown;
  size?: unknown;
  sha256?: unknown;
}>;

type LingdongDownloadManifest = Readonly<{
  version?: unknown;
  publishedAt?: unknown;
  note?: unknown;
  files?: Record<string, LingdongDownloadManifestFile>;
}>;

function isLingdongDownloadManifestUrl(value: string | undefined): boolean {
  return Boolean(value?.trim() && new URL(value).pathname.endsWith("/downloads/manifest.json"));
}

function parseLingdongDownloadManifest(raw: string, manifestUrl: URL, releasePlatform: string): UpdateInfo | null {
  let parsed: LingdongDownloadManifest;
  try {
    parsed = JSON.parse(raw) as LingdongDownloadManifest;
  } catch {
    return null;
  }
  const version = typeof parsed.version === "string" ? parsed.version : "";
  const target = releasePlatform === "windows-x86_64" ? "win-x64" : releasePlatform === "darwin-aarch64" ? "mac-arm64" : null;
  const file = target ? parsed.files?.[target] : undefined;
  const name = typeof file?.name === "string" ? file.name : "";
  const sha256 = typeof file?.sha256 === "string" ? file.sha256 : "";
  if (!version || !name || !sha256) return null;
  const baseUrl = new URL("./", manifestUrl);
  return {
    version,
    files: [{ url: name, sha2: sha256 } as UpdateFileInfo],
    releaseDate: typeof parsed.publishedAt === "string" ? parsed.publishedAt : undefined,
    releaseNotes: typeof parsed.note === "string" ? parsed.note : undefined,
    path: name,
    lingdongManifestBaseUrl: baseUrl.toString(),
  } as UpdateInfo;
}

function buildElectronManifestUrl(options: {
  endpointOrigin: string;
  manifestUrl?: string;
  platform: string;
  deviceMid?: string;
  channel: ElectronReleaseChannel;
}): URL {
  const url = options.manifestUrl?.trim()
    ? new URL(options.manifestUrl.trim())
    : new URL(ELECTRON_MANIFEST_API_PATH, normalizeZCodeEndpointOrigin(options.endpointOrigin));
  if (!isLingdongDownloadManifestUrl(options.manifestUrl)) {
    url.searchParams.set("platform", options.platform);
    if (options.deviceMid?.trim()) {
      url.searchParams.set("device_mid", options.deviceMid.trim());
    }
    url.searchParams.set("channel", mapReleaseChannelToApiValue(options.channel));
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readManifestFileList(updateInfo: UpdateInfo): UpdateFileInfo[] {
  if (Array.isArray(updateInfo.files) && updateInfo.files.length > 0) {
    return updateInfo.files;
  }

  const legacyInfo = updateInfo as UpdateInfo & {
    path?: unknown;
    sha2?: unknown;
    sha512?: unknown;
  };
  if (typeof legacyInfo.path === "string") {
    return [
      {
        url: legacyInfo.path,
        ...(typeof legacyInfo.sha2 === "string" ? { sha2: legacyInfo.sha2 } : {}),
        ...(typeof legacyInfo.sha512 === "string" ? { sha512: legacyInfo.sha512 } : {}),
      } as UpdateFileInfo,
    ];
  }

  throw new Error("Manifest update info does not contain files or path");
}

function resolveManifestUrl(pathname: string, baseUrl: URL): URL {
  return new URL(pathname, baseUrl);
}

function getLinuxUpdateExtensions(updater: AppUpdater): readonly string[] | null {
  // Linux 的实际更新器由安装包类型决定，不能把 deb/rpm/pacman 统一当作
  // 不支持更新的产物删除；复用已有 updater 实例，避免再次读取安装类型产生分歧。
  if (updater instanceof AppImageUpdater) return [".appimage"];
  if (updater instanceof DebUpdater) return [".deb"];
  if (updater instanceof RpmUpdater) return [".rpm"];
  if (updater instanceof PacmanUpdater) return [".pkg.tar.zst", ".pacman"];
  return null;
}

function resolveManifestFiles(
  updateInfo: UpdateInfo,
  baseUrl: URL,
  linuxExtensions: readonly string[] | null,
): ResolvedUpdateFileInfo[] {
  const updateFiles = readManifestFileList(updateInfo).filter((file) => {
    const pathname = resolveManifestUrl(file.url, baseUrl).pathname.toLowerCase();
    return !linuxExtensions || linuxExtensions.some((extension) => pathname.endsWith(extension));
  });
  // 缺少当前格式时，上游 findFile 会回退其他包或返回 undefined，
  // 随后报非法缓存路径/TypeError；在解析边界失败，禁止跨安装格式更新。
  if (updateFiles.length === 0) {
    throw new Error(`Manifest contains no update file for ${linuxExtensions?.join(" / ")}`);
  }
  const resolved: ResolvedUpdateFileInfo[] = updateFiles.map((fileInfo) => {
    if (!fileInfo.sha512 && !("sha2" in fileInfo && fileInfo.sha2)) {
      throw new Error(`Manifest file is missing checksum: ${fileInfo.url}`);
    }

    const url = resolveManifestUrl(fileInfo.url, baseUrl);
    // 灵动ai manifest 使用 sha256；electron-updater 的 sha2 字段就是 SHA-256 校验槽。
    // 这里保留原始 URL 解析，避免把绝对下载地址拼到 manifest 目录。
    // PacmanUpdater 仍用 .pacman 后缀识别缓存名，.pkg.tar.zst 会退回
    // info.url；只给缓存提供文件名，避免完整 URL 被拼进 pending/temp-https:/...。
    const info = linuxExtensions?.includes(".pkg.tar.zst")
      ? { ...fileInfo, url: posix.basename(decodeURIComponent(url.pathname)) }
      : fileInfo;
    return {
      url,
      info,
    } satisfies ResolvedUpdateFileInfo;
  });

  const packages = isRecord((updateInfo as { packages?: unknown }).packages)
    ? ((updateInfo as { packages?: Record<string, PackageFileInfo> }).packages ?? null)
    : null;
  const packageInfo = packages?.[process.arch] ?? packages?.ia32;
  if (packageInfo && resolved[0]) {
    resolved[0].packageInfo = {
      ...packageInfo,
      path: resolveManifestUrl(packageInfo.path, baseUrl).href,
    };
  }

  return resolved;
}

export class ManifestUpdateProvider extends Provider<UpdateInfo> {
  private readonly options: ManifestUpdateProviderOptions;
  private readonly releasePlatform: string;
  private readonly linuxExtensions: readonly string[] | null;
  private resolveBaseUrl = new URL(DEFAULT_ZCODE_ENDPOINT_ORIGIN);

  constructor(
    options: ManifestUpdateProviderOptions,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    this.options = options;
    this.linuxExtensions = getLinuxUpdateExtensions(updater);
    this.releasePlatform = options.releasePlatform?.trim() || getElectronReleasePlatform();
    this.resolveBaseUrl = new URL(
      normalizeZCodeEndpointOrigin(options.endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN),
    );
  }

  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const endpointOrigin = await this.resolveEndpointOrigin();
    const releaseChannel = await this.resolveReleaseChannel();
    const manifestUrl = buildElectronManifestUrl({
      endpointOrigin,
      manifestUrl: this.options.manifestUrl,
      platform: this.releasePlatform,
      deviceMid: this.options.deviceMid,
      channel: releaseChannel,
    });
    this.resolveBaseUrl = new URL("/", manifestUrl);
    const releaseChannelApiValue = mapReleaseChannelToApiValue(releaseChannel);

    const raw = await this.httpRequest(manifestUrl, {
      accept: MANIFEST_ACCEPT_HEADER,
      "X-Platform": this.releasePlatform,
      "X-Release-Channel": releaseChannelApiValue,
      ...(this.options.deviceMid?.trim() ? { "X-Device-Mid": this.options.deviceMid.trim() } : {}),
    });
    if (!raw) {
      throw new Error(`Empty electron update manifest: ${manifestUrl.toString()}`);
    }

    const lingdong = isLingdongDownloadManifestUrl(this.options.manifestUrl)
      ? parseLingdongDownloadManifest(raw, manifestUrl, this.releasePlatform)
      : null;
    const parsed = lingdong ?? parseYaml(raw);
    if (!isRecord(parsed) || typeof parsed.version !== "string") {
      throw new Error(`Invalid electron update manifest: ${manifestUrl.toString()}`);
    }
    if (lingdong && typeof (lingdong as { lingdongManifestBaseUrl?: unknown }).lingdongManifestBaseUrl === "string") {
      this.resolveBaseUrl = new URL((lingdong as { lingdongManifestBaseUrl: string }).lingdongManifestBaseUrl);
    }

    return {
      ...(parsed as UpdateInfo),
      // preview/stable 切换时旧 manifest 请求可能晚于新请求返回。
      // electron-updater 的 update-available 事件默认不带请求通道，main 进程无法识别过期结果；
      // 这里把本次请求通道随 UpdateInfo 带回去，避免旧通道覆盖更新弹窗内容。
      zcodeReleaseChannel: releaseChannel,
    } as UpdateInfo;
  }

  override resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return resolveManifestFiles(updateInfo, this.resolveBaseUrl, this.linuxExtensions);
  }

  private async resolveEndpointOrigin(): Promise<string> {
    const resolved =
      (await this.options.resolveEndpointOrigin?.()) ??
      this.options.endpointOrigin ??
      DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    return normalizeZCodeEndpointOrigin(resolved);
  }

  private async resolveReleaseChannel(): Promise<ElectronReleaseChannel> {
    const resolved =
      (await this.options.resolveReleaseChannel?.()) ?? this.options.releaseChannel ?? "stable";
    return normalizeReleaseChannel(resolved);
  }
}
