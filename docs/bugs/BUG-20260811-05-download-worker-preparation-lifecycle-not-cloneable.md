---
id: BUG-20260811-05
type: BUG
title: 下载生命周期回调对象无法被 Worker 结构化克隆
status: verified
severity: high
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260811-01
discovered_in_req_id: REQ-20260811-01
introduced_by_req_id: REQ-20260811-01
---

# 下载生命周期回调对象无法被 Worker 结构化克隆

## 关联文档

- 需求：[REQ-20260811-01 下载音频真实格式校验与降级发布](../requirements/REQ-20260811-01-download-actual-format-publication.md)
- 技术方案：[DEV-20260811-01 下载真实格式校验与元数据发布技术方案](../designs/DEV-20260811-01-download-actual-format-publication.md)
- 当日进度：[PROG-20260811](../progress/PROG-20260811.md)

## 现象与根因

用户安装新版后，下载列表中的任务全部停留在 `0%`，状态显示 `Failed to execute 'postMessage' on 'Worker' ... could not be cloned`。

下载链为 Worker 新增第 7 个参数 `preparationLifecycle` 时，把 `beginTask`、`isTaskCancelled`、`finishTask` 三个分别经过 `Comlink.proxy` 的函数放进普通对象，再把该对象作为原始参数发送。Comlink 只对每个顶层参数应用 transfer handler；第 7 个参数因而进入浏览器原生 structured clone，普通对象内部的代理函数无法被克隆并触发 `DataCloneError`，任务在实际传输前失败。

## 修复

- Renderer 先组装完整 lifecycle 对象，再对整个对象调用一次 `Comlink.proxy`，使第 7 个参数自身经过 Comlink transfer handler，不再裸走 structured clone。
- Download Worker 按任务登记 lifecycle、action callback 与 validator 三类远程代理，在正常完成、终态错误、暂停、删除、初始化早退及替换重试路径上进行带实例校验的 exactly-once release。
- 以 generation guard 隔离旧任务回调，并用 `taskTeardowns` 串行暂停、删除、重试和 transfer 清理；暂停或删除在入队前同步取消当前 generation。断点 mismatch 由 Downloader 关闭后上报，删除与从零重试统一归 Worker 管理，删除失败则上报写入错误并停止重试。

## 验证结果

- 最终专题回归为 55 个文件通过、1 个文件跳过，428 项测试通过、1 项跳过；Main 与 Renderer `tsc --noEmit` 均通过。此前全量 lint 通过、耗时 154.4 秒，最终相关文件 targeted ESLint 通过。
- 完整 `npm run pack` 退出码 0、总耗时 134.6 秒，webpack production build 耗时 1:01.256。Setup 为 142,754,387 bytes，SHA-256 `7ED816E04FC647E4014910C0B7DD5BA92DFE4C966EDD7D4BA8795DC8F99A674F`；blockmap 为 150,561 bytes，SHA-256 `21EBF4397DC12381F5C5D6D65ACF97B0F7E2C1C630BC18A66E574A0B027CBA82`；`app.asar` 为 34,144,489 bytes，SHA-256 `91BA81CEA9FD4BE5E8B01D8536F172F854613D5E1B36D402619F17F01D1896F5`。
- `latest.yml` 路径、大小和两处 SHA-512 与 Setup 一致，`7za t` 返回 `Everything is Ok`。ASAR 实际运行代码和 source map 均命中 whole-object lifecycle proxy、代理释放、generation、teardown 与 Worker-owned mismatch 清理；随包 FFmpeg 和原生模块哈希及 Electron ABI 加载验证通过。
- Setup 与 unpacked exe 的 Authenticode 均为 `NotSigned`。这是使用 `LX_SKIP_WIN_EXECUTABLE_EDIT` 生成本地测试包的已知边界；既有 10 个伪 FLAC 未修改。
- 用户安装后在真实 Electron 下载页完成回归：任务不再停留在 `0%`，能够进入实际下载并到达 `99.99%`，页面不再出现 `Failed to execute 'postMessage' on 'Worker' ... could not be cloned`。随后显示的 FLAC 严格校验失败属于独立的 [BUG-20260811-06](BUG-20260811-06-valid-flac-rejected-for-trailing-data.md)，不否定 Worker 结构化克隆修复，因此本缺陷状态更新为 `verified`。

## 期望行为与验证边界

- 跨 Worker 的生命周期对象必须整体作为一个 Comlink 代理参数传输，不能在普通可克隆对象中嵌套函数。
- 下载任务、代理配置和持久化元数据继续只包含可结构化克隆的数据，不把函数写入任务或数据库。
- 回归测试必须走 Comlink 参数序列化和 `structuredClone` 边界，精确捕获当前错误，而不是只断言 helper 返回对象。
- 下载链测试、Renderer 类型检查、定向 ESLint、生产构建、Windows x64 安装包静态核验及真实 Electron 下载回归均已完成；任务可离开 `0%` 的验收边界已经满足。
