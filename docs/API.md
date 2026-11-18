# 公共 API v1

通过当前 Vault 的 `app.plugins.plugins['cloud-reference']?.api` 获取；消费者先检查 `version === 1`。`cloud-reference:ready` 和 `cloud-reference:unloaded` 是 workspace 事件，消费者须卸载监听和打开器。不将其他插件内部 `store` 视为公共接口。

完整类型：[types/api.d.ts](../types/api.d.ts)。

| 方法 | 行为 |
|---|---|
| `listAccounts()` | 仅返回账号身份和名称，不返回凭据 |
| `pickResource({folder?,signal?})` | 打开快速引用窗口，取消返回 null |
| `browse(folder,{offset?,signal?})` | 重新解析目录身份，返回一页列表 |
| `search(folder,query,{offset?,signal?})` | 服务端当前目录与子目录关键词搜索，不超过 30 个字符 |
| `resolve(ref,{fresh?,signal?})` | 解析当前元数据，默认有界内存缓存；fresh 使旧请求失效 |
| `open(ref,{opener?,signal?})` | 文件按默认打开器，文件夹打开轻量浏览窗口 |
| `toMarkdown(ref,label?)` | 普通 Markdown，保留原名称/路径快照 |
| `parseReference(uri)` | 严格解析版本、账号、文件/目录身份，无网络 |
| `registerOpener({id,label?,canOpen,open})` | 返回注销函数；web 为保留名称 |
| `toMediaCoreHandoff(target,refs)` | 构造待确认候选，不写入 MediaCore |
| `diagnostics()` | 无网络的计数快照，不包含身份、路径和凭据 |

`offset` 以条目数表示：0、50、100。一次只取一页；`nextOffset === null` 表示没有下一页。过滤结果不代表网盘完整召回。禁止自动翻完所有页面建立索引。

资源字段 `provider + accountId + fileId + kind` 是身份；`name/path` 是快照。数字 ID 必须使用原始十进制字符串，不能经过 JavaScript Number。版本 1 支持百度，根目录用本协议专用 `fileId='0'`，不能作为 MediaCore 文件候选。

打开器只能收到无凭据的引用及取消信号。它负责判断是否真正支持远程打开，不得未经确认下载整个文件；移除打开器后，在途解析不能继续调用旧打开器。不根据标题推断漫笺书库、Work 或版本。

## MediaCore 边界

参照其 `media-resource-handoff/v1`，Work/Series 关系、主要入口和用户确认仍由 MediaCore 维护。[适配器示例](../examples/mediacore-adapter.cjs) 同时返回稳定 ref、Markdown 和候选。

当前 MediaCore 白名单尚未登记 `obsidian://cloud-reference`。因此交接候选使用其已支持的百度网页入口，并保留账号与文件 ID；这是备用导航，不代表已经能通过 MediaCore 完成动态解析。消费者需要显式增加对本插件 API/协议的适配后，才能保存并处理稳定 URI。不要绕过 MediaCore 的链接校验，也不要声称示例已安装。

网盘插件不认识 Work，不直接编辑任何作品文件。MediaCore 卸载时普通 Markdown 引用仍可用；网盘插件卸载时消费者应显示暂不可用并保留已有身份。
