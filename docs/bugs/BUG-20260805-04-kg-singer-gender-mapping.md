---
id: BUG-20260805-04
type: BUG
title: 酷狗歌手 adapter 将等级字段误映射为性别
status: verified
severity: medium
created_at: 2026-08-05
updated_at: 2026-08-05
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: null
---

# 酷狗歌手 adapter 将等级字段误映射为性别

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)

## 发现方式

在本需求的酷狗 Provider 实时只读核验中发现。缺陷存在于既有预留代码，不是本需求引入，因此 `introduced_by_req_id` 为 `null`。

## 实际行为

`src/renderer/utils/musicSdk/kg/singer.js` 把 Provider 的 `grade` 字段按 `1/0` 映射为男/女。实测男歌手与女歌手均可能返回 `grade=1`，该字段不能表示性别。

## 期望行为

- 未取得 Provider 明确的性别字段时返回 `null`，不得猜测。
- 本需求的 `ArtistRef` 不依赖性别字段。

## 修复约束与验证

- 仅移除错误推断，不增加歌手名称搜索或其他来源映射。
- 固定样例验证不同歌手的 `grade` 不再产生伪造性别。
- 酷狗 adapter 合同测试、lint 和 renderer build 通过后才能标记为 `verified`。

## 修复记录

既有 singer mapper 已不再从 `grade` 推断性别，目录 `ArtistRef` 也不暴露伪造性别；固定样例、Renderer TypeScript、仓库 lint、Renderer 构建与完整构建均通过，状态更新为 `verified`。
