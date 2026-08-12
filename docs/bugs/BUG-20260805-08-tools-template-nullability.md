---
id: BUG-20260805-08
type: BUG
title: 工具页预览模板未保持计划结果的非空类型
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

# 工具页预览模板未保持计划结果的非空类型

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)

## 发现方式

阶段 5 首次执行 `npm run build:renderer` 时发现。该模板由本 REQ 新增，因此 `introduced_by_req_id` 关联本需求。

## 实际行为

模板使用 `v-if="plan"` 包裹预览区域，但 Vue/ts-loader 生成的 TypeScript 会多次读取可变 ref，不能把一次条件判断视为后续所有读取都非空，最终产生 22 个 `TS2531: Object is possibly 'null'`，阻断生产构建。

## 期望行为

- 仅在计划存在时渲染预览。
- 模板内部通过稳定的非空视图模型读取计划，嵌套可空的歌手和应用结果继续显式处理。
- 修复不得改变部分结果阻断、专辑选择或歌单写入行为。

## 修复与验证记录

- 新增只在预览分支读取的 `visiblePlan` 非空 computed；歌手和失败应用结果的嵌套字段改为显式可空访问。
- 目标 ESLint、Renderer TypeScript、仓库 lint、`npm run build:renderer` 与 `npm run build` 均通过。
- 该问题已由生产构建回归覆盖，状态更新为 `verified`。
