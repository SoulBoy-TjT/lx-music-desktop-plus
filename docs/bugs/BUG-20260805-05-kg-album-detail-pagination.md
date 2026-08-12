---
id: BUG-20260805-05
type: BUG
title: 酷狗专辑详情分页重复请求元数据并耦合失败
status: wont_fix
severity: high
created_at: 2026-08-05
updated_at: 2026-08-05
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: null
---

# 酷狗专辑详情分页重复请求元数据并耦合失败

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)

## 发现方式

在本需求的酷狗专辑详情调用链审查中发现。缺陷存在于既有预留代码，不是本需求引入。

## 实际行为

既有 `album.getSongList` 每取得一页曲目都会再次请求同一专辑元数据；元数据请求失败会使已经取得的曲目页整体失败，且方法本身只返回单页，无法表达部分分页结果。

## 期望行为

- 目录 adapter 独立穷尽曲目分页，以专辑详情曲目为权威结果。
- 专辑元数据不随每个曲目页重复请求，也不应丢弃已取得的分页证据。
- 中间页失败返回可定位的 `partial` 或 `failed`，不得伪装为空专辑。

## 修复约束与验证

- 不修改网易云、企鹅音乐或无关酷狗搜索逻辑。
- 固定样例覆盖多页、末页、重复页、中间页失败和取消。
- adapter 合同测试、核心 plan 测试、lint 和 renderer build 通过后才能标记为 `verified`。

## 处置结论

本需求没有继续调用既有 `album.getSongList`，而是在隔离的 `ArtistCatalogPort` 酷狗 adapter 中独立实现专辑详情分页、hash 扩展、部分结果和取消。修改未接入的 legacy 方法只会扩大范围，因此该旧入口本阶段不修；新目录链路不再受其重复元数据请求影响。
