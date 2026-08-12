---
id: BUG-20260805-07
type: BUG
title: 酷狗目录分页按请求页大小提前终止
status: verified
severity: high
created_at: 2026-08-05
updated_at: 2026-08-05
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: REQ-20260805-01
---

# 酷狗目录分页按请求页大小提前终止

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)

## 发现方式

在阶段 2 实现完成后的独立代码审查中发现。该判断由本 REQ 的新酷狗目录 adapter 引入，因此 `introduced_by_req_id` 明确关联本需求。

## 实际行为

分页器使用 `page * requestedLimit >= reportedTotal` 和“返回条数小于请求 limit”作为终止条件。如果 Provider 静默把请求的 100 条封顶为更小页长，第一页后就可能停止，虽会标记 `partial`，但没有继续尝试取得剩余页。

## 期望行为

- total 已知时按累计取得数量达到 total 终止。
- 非空短页但累计数量仍小于 total 时继续请求下一页。
- 提前空页、重复页、total 变化、请求失败和最大页数仍必须停止并报告部分结果。
- 取消后不得发起新页请求。

## 验证标准

- [x] 固定样例模拟请求 limit 100、实际每页 2 条、total 5，必须请求 3 页并返回 complete。
- [x] total 变化、提前空页、重复页和请求失败返回不完整结果。
- [x] AbortSignal 触发后不再请求下一页。
- [x] 目标测试、lint、TypeScript 与 renderer build 通过。

## 修复与验证记录

- 分页状态机已抽为纯 `collectKgPaginated`，total 已知时按累计原始条目数达到 total 终止，非空短页不会提前停止。
- 保留提前空页、重复页、total 变化、请求失败、安全页上限和取消保护；有限重试也抽为纯执行器并接入生产请求。
- 新增 6 项分页测试和 3 项重试测试；38 项目标测试、Renderer TypeScript、仓库 lint、Renderer 构建与完整构建均通过，状态更新为 `verified`。
