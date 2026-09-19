/**
 * 灵动ai 客户端：禁用上游的「内测声明」欢迎弹层。
 *
 * 上游 `WelcomeNotice` 会在设置同步完成后弹一张产品级公告卡。这个客户端是给学生用的，
 * 不放研发内测口径；保留原注入接口的形状，组件恒为 null，后面上游升级只需重放补丁。
 */
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WelcomeNoticeState, WelcomeNoticeStore } from './welcome-store.ts'
import type { en } from './locales.ts'

/** 保留上游 registration 的注入面，避免改 index 的插件装配。 */
export interface WelcomeNoticeInjected {
  hooks: {
    readonly welcome: SnapshotStore<WelcomeNoticeState>
  }
  readonly controller: WelcomeNoticeStore
  readonly t: (key: keyof typeof en) => string
}

export type WelcomeNoticeProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<WelcomeNoticeInjected>

/** 学生端不显示内测声明。 */
export function WelcomeNotice(_props: WelcomeNoticeProps): ReactNode {
  return null
}