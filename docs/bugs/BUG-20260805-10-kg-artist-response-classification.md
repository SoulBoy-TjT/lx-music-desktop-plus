---
id: BUG-20260805-10
type: BUG
title: 酷狗歌手畸形响应被误判为歌手不存在
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

# 酷狗歌手畸形响应被误判为歌手不存在

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)

## 发现方式

阶段 5 最终规格复核中发现。分类逻辑由本 REQ 的新酷狗目录 adapter 引入，因此 `introduced_by_req_id` 关联本需求。

## 实际行为

歌手 mapper 只返回歌手或 `null`。明确的“不存在”响应与 HTTP 200 下的缺字段、错误 envelope、成功状态空 data 等畸形响应都会进入同一分支，被报告为 `artist_not_found` 或 `invalid_artist_ref`，从而丢失 `invalid_provider_response` 和可重试语义。

## 期望行为

- 仅将当前只读实测的明确形态 `status=0`、`errcode` 为空或 `0`、无歌手数据且 `error="参数不合法"` 归类为不存在或输入无效。
- 成功状态但缺少必要字段、状态字段非法或失败状态却携带矛盾数据时归类为可重试的 `invalid_provider_response`。
- 分类过程不得暴露响应正文、Cookie 或请求凭据。

## 修复与验证记录

- 新增 `mapKgArtistResponse` 判别联合类型，分别表达 `ok`、`not_found` 和 `invalid`；生产 adapter 将 `invalid` 映射为可重试的 `invalid_provider_response`。
- 新增固定样例覆盖明确不存在、成功状态空 data、非法 status、系统繁忙、非零 `errcode` 与缺少歌手名称；未知失败保守归类为 `invalid`。
- 目标 ESLint、Renderer TypeScript、38 项目标测试、仓库 lint、Renderer 构建与完整构建均通过；最终独立复核未发现新 P1/P2，状态更新为 `verified`。
