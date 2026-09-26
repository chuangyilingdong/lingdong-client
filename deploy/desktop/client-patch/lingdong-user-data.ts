/**
 * 灵动ai 数据目录改名 + 老机器一次性迁移（2026-09-25，.2.9）。
 *
 * 背景：Electron 的 `userData` 一直跟着**上游包名**走 —— `%APPDATA%\@deepseek-ai\dsh-desktop`；
 * 产品却叫「灵动ai创作客户端」。学生的登录态、会话记录、388MB 插件镜像全在那个"看不出是谁"
 * 的目录里，老师找数据、运维清理、卸载残留都对不上（2026-09-25 复核：`%APPDATA%\灵动ai创作客户端`
 * 里只有一份 0.1.6 代遗留的 `lingdong-session.json`，真正的数据在 `@deepseek-ai\dsh-desktop`）。
 *
 * 必须在**任何 `app.getPath('userData')` 之前**调用（main.ts 模块顶层）：把 userData 钉到
 * `%APPDATA%\灵动ai创作客户端`，并把老目录搬过来。
 *
 * ⚠️ 为什么是「一次 rename」而不是「逐项搬」：逐项搬若中途失败（Windows 上文件被占用很常见），
 * 会留下**半份数据**——比如登录 token 已经搬走、会话还在老目录，学生就会莫名掉登录态。
 * 同卷 rename 是**原子**的：要么整体过去，要么原地不动。所以：
 *   ① 老目录有数据（`dsh-home`）、新目录没有 → 目标位置上若只是一份遗骸（0.1.6 代那个
 *      `lingdong-session.json`），先把它挪到 `<target>.lingdong-stale-<时间戳>` 腾位置，
 *      再 `rename`；成功且遗骸里确实只有那一个文件才顺手删掉遗骸，否则留着（不删数据）。
 *   ② 迁移失败（占用/权限）→ 把遗骸挪回去 + **原地退回老目录**继续跑，绝不让学生丢登录态。
 *   ③ 新目录已经在用（已迁移过）→ 什么都不做，直接用新目录。
 */
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** 新目录名（与产品名一致，安装器卸载时清的就是这个）。 */
const LINGDONG_USER_DATA_DIR = '灵动ai创作客户端'
/** 历史 userData 目录名，按优先级排（同一份数据只会落在其中一个）。 */
const LINGDONG_LEGACY_USER_DATA_DIRS = ['@deepseek-ai/dsh-desktop', 'DSH Desktop', 'dsh-desktop'] as const
/** 「这个目录真的装过东西」的判据：DSH 家目录在场。只看目录名会被 0.1.6 代那份遗骸骗到。 */
function hasDshHome(directory: string): boolean {
  return existsSync(join(directory, 'dsh-home'))
}

/** 腾位置用的遗骸如果确实只剩一个旧 session 文件，就顺手清掉；多一个文件都不动。 */
function discardStale(stale: string): void {
  try {
    const entries = readdirSync(stale)
    if (entries.length === 0 || (entries.length === 1 && entries[0] === 'lingdong-session.json')) {
      rmSync(stale, { recursive: true, force: true })
    }
  } catch {
    // 清不掉就留着：只是 %APPDATA% 下多一个 .lingdong-stale-* 目录，不影响使用。
  }
}

/** 见文件头。任何异常都只告警：拿不到新目录就继续用默认目录，学生照旧能用。 */
export function adoptLingdongUserData(): void {
  try {
    const appData = app.getPath('appData')
    const current = app.getPath('userData')
    const target = join(appData, LINGDONG_USER_DATA_DIR)
    if (current === target) return
    const source = [current, ...LINGDONG_LEGACY_USER_DATA_DIRS.map(name => join(appData, name))]
      .find(directory => directory !== target && hasDshHome(directory))
    if (source !== undefined && !hasDshHome(target)) {
      const stale = existsSync(target) ? `${target}.lingdong-stale-${String(Date.now())}` : undefined
      try {
        if (stale !== undefined) renameSync(target, stale)
        renameSync(source, target)
        console.log(`[lingdong] 数据目录已迁移：${source} → ${target}`)
        if (stale !== undefined) discardStale(stale)
      } catch (error) {
        // 原子性保证了这里什么都没搬动（除了腾位置的遗骸），把它放回去再退回老目录。
        if (stale !== undefined && !existsSync(target)) {
          try {
            renameSync(stale, target)
          } catch {
            // 放不回去就两份都留着，绝不删。
          }
        }
        console.warn('[lingdong] 数据目录迁移失败，继续使用老目录：', error)
        return
      }
    }
    app.setPath('userData', target)
  } catch (error) {
    console.warn('[lingdong] 数据目录改名失败，继续使用默认目录：', error)
  }
}