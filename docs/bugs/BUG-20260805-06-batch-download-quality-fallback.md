---
id: BUG-20260805-06
type: BUG
title: 原生批量下载弹窗未禁用不可用音质
status: wont_fix
severity: high
created_at: 2026-08-05
updated_at: 2026-08-07
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: null
---

# 原生批量下载弹窗未禁用不可用音质

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)
- 后续决策：[BIZ-20260807-01 批量下载优先音质与逐曲自动降级策略](../decisions/BIZ-20260807-01-batch-download-quality-fallback.md)
- 后续缺陷：[BUG-20260807-01 批量下载最高音质被精确交集规则禁用](BUG-20260807-01-batch-download-highest-quality-disabled.md)

## 发现方式

在本需求的原生下载衔接审查中发现。缺陷存在于既有批量下载流程，不是本需求引入。

## 实际行为

`DownloadMultipleModal` 固定启用四档音质，不检查当前用户源和全部选中歌曲是否支持；下载 worker 随后会把不可用选择静默降级，界面展示的用户选择与实际任务音质可能不一致。

## 期望行为

- 只有当前用户源和全部选中在线歌曲都声明支持时才启用对应音质。
- 不可用音质保持可见、禁用并显示原因。
- 可用项仍调用现有 `createDownloadTasks`，不另建下载器或自动开始下载。

## 修复约束与验证

- 不改变单曲下载与下载任务持久化数据结构。
- 纯函数测试覆盖可用、音源不支持、歌曲不支持和无在线歌曲。
- lint、renderer build 及原生弹窗人工检查通过后才能标记为 `verified`。

## 修复与验证记录

- 新增纯音质能力判断，只有用户源支持目标来源/音质且全部选中在线歌曲都声明该音质时才启用。
- 不可用的四档音质仍显示，但禁用并给出音源不支持、歌曲不支持或无在线歌曲的原因。
- 可用项继续调用既有 `createDownloadTasks`，未自动开始下载，也未改变任务存储结构。
- 3 项纯函数测试、Renderer TypeScript、仓库 lint、Renderer 构建与完整构建通过；尚未启动 Electron 人工检查弹窗，因此状态为 `fixed`，不提前标记 `verified`。
- 2026-08-07 用户确认新的批量策略：所选档位是优先音质，部分歌曲不支持时应逐曲自动降级。原“全部歌曲精确支持才启用”的修复口径不再作为当前验收依据，后续实现和验证转由 `BIZ-20260807-01` 与 `BUG-20260807-01` 跟踪。

## 处置结论

本 BUG 所定义的“全部歌曲精确支持才启用”修复口径已被用户明确否定，不再继续人工验证，因此状态更新为 `wont_fix`。原始问题中“UI 与实际任务音质不一致、降级不可静默”的有效部分已由 `BUG-20260807-01` 按新的逐曲自动降级决策重新实现和跟踪。
