---
id: BIZ-20260808-03
type: BIZ
title: FLAC 转 MP3 使用独立模块与导航
status: accepted
created_at: 2026-08-08
updated_at: 2026-08-08
owner: KhalilFong
req_ids:
  - REQ-20260808-01
---

# FLAC 转 MP3 使用独立模块与导航

## 关联文档

- [REQ-20260808-01 FLAC 批量转换为 MP3](../requirements/REQ-20260808-01-flac-to-mp3.md)
- [DEV-20260808-01 FLAC 批量转换为 MP3 技术方案](../designs/DEV-20260808-01-flac-to-mp3.md)

## 决策

用户于 2026-08-08 明确要求“FLAC 转 MP3 功能单独一个模块”，因此接受以下安排：

1. 增加独立“FLAC 转 MP3”侧边栏入口、`/flac-converter` route 和页面，不再放在歌曲整理标题区。
2. Main 使用独立 `flacConverter` module、运行态、类型和 IPC；`SongOrganizerService` 不提供转换 interface。
3. 两个 module 只共享内置 FFmpeg 的基础设施路径与可用性 adapter，不共享业务状态、页面状态或操作结果类型。
4. 转换模块自行负责批量选择、输出目录、预览确认、实时进度和最终结果；歌曲整理页面恢复为只处理扫描、清理与重命名。
5. 平台范围仍为 Windows x64，原文件保留、固定 320 kbps、禁止覆盖等既有安全规则不变。

## 理由

歌曲整理面向受控根目录和扫描快照，FLAC 转换面向用户任意选择的文件与输出目录，两者的输入、运行态和失败模式不同。独立 module 能让转换 interface 保持小而完整，也避免歌曲整理承担与扫描无关的选择和转码状态。
