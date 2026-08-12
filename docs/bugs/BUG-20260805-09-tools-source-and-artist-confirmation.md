---
id: BUG-20260805-09
type: BUG
title: 工具页缺少来源输入与完整歌手确认信息
status: verified
severity: medium
created_at: 2026-08-05
updated_at: 2026-08-05
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: REQ-20260805-01
---

# 工具页缺少来源输入与完整歌手确认信息

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)

## 发现方式

阶段 5 最终规格复核中发现。问题位于本 REQ 新增的工具页，因此 `introduced_by_req_id` 关联本需求。

## 实际行为

- 页面仅显示酷狗徽标并在调用处硬编码 `source: 'kg'`，没有形成“平台 + 歌手 ID/链接”的输入形态。
- 抓取前的 Dialog 只显示歌手名称和 ID，没有按 DEV 展示头像与 Provider 声明专辑数。

## 期望行为

- 即使首期只有酷狗，也提供来源选择控件，并把选中来源传入 `plan`。
- 在获取专辑目录前使用洛雪现有弹窗展示来源、头像、名称、ID 和声明专辑数，用户明确确认后才继续。
- 取消或关闭确认弹窗必须释放等待中的 Promise，且不再发起专辑请求。

## 修复与验证记录

- 工具页新增单选项来源选择，当前唯一选项为酷狗；`plan` 使用选择结果，不再硬编码调用参数。
- 歌手确认改用现有 `MaterialModal`，展示头像或稳定占位、名称、来源、ID 与声明专辑数；确认 Promise 在确认、取消、主动取消和组件卸载时统一收口。
- 目标 ESLint、Renderer TypeScript、38 项目标测试、仓库 lint、Renderer 构建与完整构建均通过，状态更新为 `verified`。
