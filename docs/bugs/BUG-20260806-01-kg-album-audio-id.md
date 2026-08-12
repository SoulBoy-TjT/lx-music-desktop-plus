---
id: BUG-20260806-01
type: BUG
title: 酷狗专辑曲目扩展遗漏 album_audio_id 导致多发行版缺曲
status: verified
severity: high
created_at: 2026-08-06
updated_at: 2026-08-06
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: REQ-20260805-01
---

# 酷狗专辑曲目扩展遗漏 album_audio_id 导致多发行版缺曲

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)
- 当日进度：[PROG-20260806](../progress/PROG-20260806.md)

## 发现方式

在 `REQ-20260805-01` 的 Electron 实时验收中，使用酷狗歌手 ID `192980` 获取蔡徐坤目录时发现：`KUN` 声明 11 首但仅取得 8 首，“蒙着眼”声明 1 首但没有有效曲目。该缺陷位于本 REQ 新增的酷狗目录 adapter，因此 `introduced_by_req_id` 为 `REQ-20260805-01`。

## 位置与根因

- `src/renderer/utils/musicSdk/kg/artistDiscography.ts`
- `src/renderer/utils/musicSdk/kg/artistDiscographyMapper.ts`

酷狗专辑详情同时返回音频资源 `hash` 和用于定位具体专辑曲目版本的 `album_audio_id`。adapter 扩展歌曲信息时只向 Gateway 发送 `hash`，导致同一 `audio_id` 出现在多个发行版时被解析到默认单曲或旧专辑，并返回另一套专辑 ID 和 hash。后续严格归属校验正确拒绝了这些错误版本，最终形成专辑曲数不完整。

实时差分确认：携带详情中的 `album_audio_id` 后，`KUN` 从 `8/11` 恢复为 `11/11`，“蒙着眼”从 `0/1` 恢复为 `1/1`。

## 期望行为

- 扩展专辑详情歌曲时必须同时携带 `hash` 和有效的 `album_audio_id`。
- 缺失或非法 `album_audio_id` 的详情行必须报告 `invalid_provider_response`，不得退化为 hash-only 查询并静默选择其他发行版。
- 保留现有专辑 ID、稳定歌曲 ID、hash 和完整性校验，不通过放宽守卫规避异常。

## 影响

- 同一音频出现在单曲、EP 和后续专辑时，专辑分组会缺曲并被标记为 `incomplete`。
- 默认完整性阻断会禁止正常生成本应完整的目录歌单。
- 明确接受部分结果时，单选受影响专辑会实际缺歌。

## 修复约束

1. 修改仅限酷狗专辑目录 adapter、固定样例和直接相关测试。
2. 通过 `ArtistCatalogPort.getAlbumTracks` 公共 seam 验证同曲多发行版，不测试私有函数。
3. 外部 Provider 仍通过离线固定响应模拟，默认测试不得依赖实时酷狗接口。
4. 不修改网易云、QQ 音乐、歌单存储或下载体系。

## 验证标准

- [x] 回归测试在修复前稳定得到不完整结果。
- [x] 同曲多发行版样例在携带 `album_audio_id` 后返回目标专辑版本。
- [x] 缺失 `album_audio_id` 时报告 Provider 数据异常且不查询默认发行版。
- [x] 全部目录测试、Renderer 类型检查、lint、Renderer 构建和完整构建通过。
- [x] 蔡徐坤两张问题专辑的只读实时差分恢复为 `11/11` 和 `1/1`。

## 当前修复记录

- 已在 Gateway 扩展请求中透传经校验的 `album_audio_id`。
- 已新增公开 adapter seam 回归测试，并补齐原始详情 fixture 的专辑曲目关联 ID。
- `npm run test:artist-discography` 共 7 个测试文件、40 项测试通过；Renderer TypeScript、仓库 lint、Renderer 构建和完整构建均通过。
- 酷狗只读实时复核确认 `KUN` 为 `11/11`、“蒙着眼”为 `1/1`；BUG 状态更新为 `verified`。
