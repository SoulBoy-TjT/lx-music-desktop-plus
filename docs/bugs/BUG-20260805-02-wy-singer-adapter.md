---
id: BUG-20260805-02
type: BUG
title: 网易云歌手 adapter 分页跳页且音质映射贯穿
status: confirmed
severity: high
created_at: 2026-08-05
updated_at: 2026-08-09
owner: KhalilFong
req_ids:
  - REQ-20260805-01
  - REQ-20260809-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: null
---

# 网易云歌手 adapter 分页跳页且音质映射贯穿

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 技术方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)
- 后续来源需求：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 后续技术方案：[DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](../designs/DEV-20260809-01-four-source-artist-discography-playlists.md)

## 发现方式

在 `REQ-20260805-01` 的来源扩展审查中发现。缺陷存在于既有预留代码，不是本需求引入。

## 位置与现象

### 分页跳页

- `src/renderer/utils/musicSdk/wy/singer.js:35-48`
- `src/renderer/utils/musicSdk/wy/singer.js:60-74`

第一页把 `page` 从 `1` 改成 `0`，但第二页直接计算 `offset = 2 * limit`，跳过应为 `limit` 的一整页。返回的 `page` 也混合了零基与一基语义。

### 音质映射贯穿

- `src/renderer/utils/musicSdk/wy/singer.js:100-130`

音质 `switch` 的各个 `case` 没有 `break`。一个较低码率条目会贯穿后续分支，错误声明更高音质并可能生成重复质量项。

### 歌手信息空值

- `src/renderer/utils/musicSdk/wy/singer.js:19-20`

实现直接访问 `body.user.avatarUrl` 和 `body.user.gender`，没有处理部分歌手缺少用户对象的响应。

## 期望行为

- 对外统一使用一基页码，offset 依次为 `0`、`limit`、`2 * limit`。
- 返回页码与请求语义一致，不跳页、不重复。
- 每个音质只由匹配的 Provider 条目产生，不发生 switch 贯穿。
- 缺少用户对象时仍能返回歌手核心身份，头像和性别允许为空。

## 影响

- 网易云专辑和歌曲分页可能漏掉整页，无法证明目录完整。
- 歌曲可能错误显示并不存在的 FLAC/Hi-Res 音质，影响可下载状态判断。
- 该来源在修复并具备可靠专辑详情 adapter 前，不得加入第一阶段支持列表。

## 修复约束

1. 分页在 adapter 内统一，不让目录 module 了解来源 offset。
2. 使用脱敏固定响应测试第 1、2、3 页和末页。
3. 为每种音质建立独立样例，验证无贯穿、无重复。
4. 本 BUG 的修复不等于已经具备完整专辑详情能力；来源启用仍需独立验收。

## 验证标准

- [ ] 页码序列对应 offset `0/limit/2*limit`。
- [ ] total 跨多页时无遗漏、无重复。
- [ ] 音质集合与固定响应严格一致。
- [ ] 缺少 `body.user` 不产生无上下文 `TypeError`。
- [ ] 网易云 adapter 合同测试、lint 和 renderer build 通过。

## 当前验证边界

本次仅完成静态确认，未调用真实网易云接口，也未修改代码。

2026-08-09 本 BUG 被纳入 `REQ-20260809-01` 的网易来源前置条件；当前仍为 `confirmed`，本次文档关联不代表缺陷已经修复或验证。
