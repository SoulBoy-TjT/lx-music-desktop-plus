---
id: BUG-20260805-03
type: BUG
title: QQ 音乐歌手 adapter 响应判断、分页和歌曲映射错误
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

# QQ 音乐歌手 adapter 响应判断、分页和歌曲映射错误

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 技术方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)
- 后续来源需求：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 后续技术方案：[DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](../designs/DEV-20260809-01-four-source-artist-discography-playlists.md)

## 发现方式

在 `REQ-20260805-01` 的来源扩展审查中发现。缺陷存在于既有预留代码，不是本需求引入。

## 位置与现象

### 响应判断和统计来源错误

- `src/renderer/utils/musicSdk/tx/singer.js:141-157`

`getInfo` 将 `req_2`、`req_3` 响应对象直接与数字 `0` 比较，而不是检查各自的 `.code`，会使正常响应也进入失败分支。专辑统计又错误读取 `req_3.data`，与歌曲统计使用同一对象。

### 分页跳页

- `src/renderer/utils/musicSdk/tx/singer.js:168-213`

第一页把 `page` 改成 `0`，第二页仍使用 `2 * limit` 作为 begin，跳过应为 `limit` 的一页。

### 歌曲映射没有返回值

- `src/renderer/utils/musicSdk/tx/singer.js:243-247`

`filterSongList` 执行 `raw.map(...)` 后没有 `return`，因此 `getSongList` 正常响应也会得到 `list: undefined`。

### 请求头拼写

- `src/renderer/utils/musicSdk/tx/singer.js:68-94`

请求头使用 `User-Angent`，且辅助函数的 `options` 参数未被使用，需要在 adapter 合同审查中确认实际影响。

## 期望行为

- 三个子请求分别检查 `.code`，歌手、专辑和歌曲统计来自正确响应。
- 分页 begin 依次为 `0`、`limit`、`2 * limit`。
- 歌曲映射返回完整数组，并转换成合法 `MusicInfoOnline`。
- HTTP 请求头和可选参数按预期生效。

## 影响

- 歌手身份验证可能恒定失败。
- 专辑和歌曲总数不可相信，分页会漏页。
- 歌曲列表为 `undefined`，无法创建本地歌单或执行完整性检查。
- QQ 音乐在修复并具备可靠专辑详情 adapter 前，不得进入支持列表。

## 修复约束

1. 将 Provider 响应判断、分页和字段归一化封装在 QQ adapter 内。
2. 为正常响应、单个子请求失败、分页和空歌曲列表建立固定样例。
3. 旧歌曲结构必须通过统一转换得到具有稳定 `id/meta` 的 `MusicInfoOnline`。
4. 本 BUG 修复后仍需专辑详情能力，不能仅凭歌手歌曲列表宣称支持完整专辑。

## 验证标准

- [ ] 正常三个子请求不会被错误拒绝。
- [ ] 歌手、专辑和歌曲统计分别来自正确响应。
- [ ] 第 1、2、3 页连续且无遗漏。
- [ ] `filterSongList` 始终返回数组，歌曲字段符合 `MusicInfoOnline`。
- [ ] QQ adapter 合同测试、lint 和 renderer build 通过。

## 当前验证边界

本次仅完成静态确认，未调用真实 QQ 音乐接口，也未修改代码。

2026-08-09 本 BUG 被纳入 `REQ-20260809-01` 的 QQ 来源前置条件；当前仍为 `confirmed`，本次文档关联不代表缺陷已经修复或验证。
