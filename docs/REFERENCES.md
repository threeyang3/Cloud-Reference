# 实现参考与来源

本插件独立实现，不复制 Sync Vault 的专有 Pro 代码，也不绕过其授权。项目尚未指定公开分发许可证；不得因 GitHub 可见就假定所有参考代码可复制。

- Sync Vault 云链接交互参考：https://sync-vault.com/zh/data-and-media/cloud-hyperlinks/
- 漫笺百度协议/凭据设计：https://github.com/threeyang3/ComicNotes/tree/main/packages/comicnotes_source_baidu
- 漫笺 OAuth 导航验证参考（协议思路，非 Swift 代码移植）：https://github.com/threeyang3/ComicNotes/blob/main/apps/comicnotes/apple/OpenListWebFlow.swift
- 百度官方 Go SDK 普通搜索：https://github.com/baidu-netdisk/baidu-drive-sdk-go/blob/main/docs/api/search.md
- OpenList APIPages 回调协议：https://github.com/OpenListTeam/OpenList-APIPages/blob/main/README.md
- APIPages 百度驱动：src/driver/baiduyun_oa.ts，核对时 blob 303d1bbe901fc7c6e0aeaea398eddfd87fa2e1d7。callback 读取 server_use/driver_txt Cookie，结果是 Base64 JSON 的 302 信封。
- APIPages 回调编码：src/shares/secrets.ts，blob 4aa8444564c4fef44b38ef03659b1c75d6591ab5。
- OpenList 驱动说明：https://doc.oplist.org/guide/drivers/baidu
- Obsidian 生命周期：https://docs.obsidian.md/plugins/guides/lifecycle-management
- Electron 安全：https://www.electronjs.org/docs/latest/tutorial/security
- Electron 请求拦截：https://www.electronjs.org/docs/latest/api/web-request
- MediaCore 交接协议：https://github.com/threeyang3/obsidian-media-lab/blob/main/obsidian-media-lab/plugin/src/resource-handoff.js

参考资料可能随上游变化。已实现协议不代表当前 Token 权限、平台政策或原生宿主行为已通过实测。
