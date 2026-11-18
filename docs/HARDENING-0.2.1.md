# 0.2.1 加固记录

## 基线与范围

GitHub 基线 `dd78f81ea12f5e04c940f5b48c905a67bde3a5ef`：108 项测试，已有三个系统的 Node CI。此次继续在 `feat/baidu-stability-0.2` 开发，不回退到旧 0.1.0，不改动 MediaCore 或漫笺仓库，不使用用户凭据或修改网盘文件。

## 先复现、后修复

第一组新增回归 6 项，旧实现 5 项失败：并发 fresh 互相取消；cache close/invalidate/clear 未能结束不响应取消的加载器等待者；请求取消时恢复标记尚未写完就提前返回。

第二组凭据回归再复现 3 项失败：异步 beforeCommit 拒绝被忽略；准备 pending 或提交新 Token 的磁盘写入窗口内，同步到来的新凭据仍被覆盖。修复后使用临近 rename 的异步版本校验。它缩小竞争窗口，但检查与 rename 仍不是跨设备事务，不能承诺坚果云同步绝无冲突。

新增其他覆盖：Windows 临时 rename 占用三次上限、每次重试复核、旧文件保留；UTF-8 损坏与 Unicode 孤立代理项；5,000 条大整数 JSON；授权窗口重复取消清理；HTTP 错误状态的迟到 error 事件；取消后的迟到响应；相同正文的不同笔记、编辑器关闭、文件删除重建及重命名时的插入归属。

## 本地结果

`npm run check` 运行语法检查、全部测试、确定性打包和合成性能预算。当前 134 项通过、0 失败、0 跳过。重复运行结果与提交后 CI 以该提交对应日志/Artifacts 为准，不以文档数字代替重新执行。

新增 `.gitattributes` 固定文本 LF，减少 Windows checkout 换行导致的构建差异。CI 保留明确白名单的源码快照与插件构建；不会打包 `.git`、Vault、accounts 或凭据目录。

`dist/performance.json` 新增约 1 MiB/5,000 条 JSON 解析测量。它与现有 500 条相同引用只加载一次、256 项元数据上限、空闲零请求一起执行。耗时和堆差值属于当前 Node 进程的合成观察，不是 Obsidian RAM、CPU 或首开速度承诺。

## 稳定发布仍需真实证据

`docs/acceptance.json` 保留真实网盘、macOS/Windows Obsidian、坚果云并发、文件夹移动和实际性能为 `not-run`。`npm run release-check` 还会核对证据版本与插件版本，证据不齐应失败，不能为了显示绿色而绕过。

本次未测试真实 OAuth 登录、真实令牌轮换、搜索接口授权、目录 ID 的平台行为、隔离窗口的实际宿主兼容性或主库性能。已有手动授权入口保留。Node 的三个系统通过并不等于三个系统的 Obsidian GUI 通过。

未新增媒体预览、下载、网盘写入、115 或 MediaCore 端适配；这些需求继续保留，核心安全和性能优先。
