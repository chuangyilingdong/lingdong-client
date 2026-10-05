# 客户端安装包发布通道

## 背景

`deploy/publish-client.sh` 由客户端团队在发新版安装包时执行。生产 ECS 的 IP 可能更换，但对外域名始终是 `aicyld.com`。发布脚本不能再默认绑定旧 IP。

## 契约

1. 默认 SSH 目标是 `root@aicyld.com`，由 DNS 解析到当前生产 ECS。
2. `PUBLISH_CLIENT_HOST` 可覆盖默认主机，用于临时维护或演练。
3. SSH 主机指纹使用 `StrictHostKeyChecking=accept-new`：首次连接新主机名时写入 `known_hosts`；后续主机 key 变化仍按严格校验失败。
4. 学生客户端只依赖 `https://aicyld.com`，不依赖发布脚本或 SSH 目标；服务器换 IP 对学生透明。
5. 发布脚本仍从仓库根目录执行，发布前要求工作区干净。

## 失败语义

- DNS 未解析、SSH 端口不可达或认证失败：脚本在连接阶段失败，不上传文件、不修改远端 manifest。
- `known_hosts` 已记录过 `aicyld.com` 但后续主机 key 变化：SSH 拒绝连接，必须人工确认新 key 后才能继续。
- 显式设置 `PUBLISH_CLIENT_HOST` 时以该值为准。

## 验收

1. `deploy/publish-client.sh` 默认 host 为 `root@aicyld.com`。
2. `aicyld.com` 解析到当前生产 ECS，SSH 端口可连接。
3. 使用临时 `known_hosts` 首次连接 `root@aicyld.com` 可成功并固定主机 key。
4. `bash -n deploy/publish-client.sh` 通过。
5. 仓库内不再把旧 IP 当作发布默认目标。
