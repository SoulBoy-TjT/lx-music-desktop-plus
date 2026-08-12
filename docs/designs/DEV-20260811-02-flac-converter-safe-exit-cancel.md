---
id: DEV-20260811-02
type: DEV
title: FLAC 转换关闭安全取消技术方案
status: implemented
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260808-01
biz_ids:
  - BIZ-20260811-02
bug_ids:
  - BUG-20260811-03
---

# FLAC 转换关闭安全取消技术方案

> 歌曲整理退出语义已由 [BIZ-20260811-05](../decisions/BIZ-20260811-05-song-organizer-non-cancellable-operations.md) 修订：快速扫描和检查不再参与关闭取消集合，只要歌曲整理存在只读或磁盘任务，关闭协调器均提示等待并拒绝本次关闭。本文的 FLAC 转换安全取消方案保持不变。

## 关联文档

- [REQ-20260808-01](../requirements/REQ-20260808-01-flac-to-mp3.md)
- [BIZ-20260811-02](../decisions/BIZ-20260811-02-flac-converter-safe-exit-cancel.md)
- [BUG-20260811-03](../bugs/BUG-20260811-03-paused-flac-converter-blocks-exit.md)
- 原方案：[DEV-20260808-01 FLAC 批量转换为 MP3 技术方案](DEV-20260808-01-flac-to-mp3.md)

## 设计

1. 为转换 Service 增加幂等 `cancelAndWait(reason)`：设置取消信号、释放暂停门闩、禁止领取下一项目，并终止当前 FFmpeg。
2. 跟踪当前子进程和临时文件；取消必须等待进程 `close/error` 终态并在 `finally` 清理临时路径，最终统一释放 operation/busy 状态。
3. 正常关闭编排只对 FLAC 转换和下载音频校验执行安全取消；歌曲整理的快速扫描、检查、整理和恢复任一繁忙时均直接返回等待提示，不进入取消流程。
4. 多次关闭、暂停与关闭竞态、自然完成与取消竞态均收敛到同一 Promise；不得重复 kill、重复发布或提前报告 idle。
5. 若子进程在有界终止流程中失败，记录可诊断日志并采用现有进程强制终止兜底；不得无限等待。

## 验证计划

- 服务测试覆盖运行中关闭、暂停中关闭、项目边界关闭、重复关闭、自然完成竞态、FFmpeg 不响应、临时文件清理和 busy 归零。
- 应用退出编排覆盖：转换可取消后退出；快速扫描/检查/整理/恢复均阻止退出且不触发歌曲整理取消。
- Windows x64 人工验证暂停后关闭客户端，不遗留 FFmpeg 和临时文件，已发布成品与源文件不变。

## 实施与验证结果

- `FlacConverterService.cancelAndWait()` 已实现取消、暂停门闩释放、当前子进程终止等待、临时文件清理及 `busy` 终态释放；共享 FFmpeg 终止器从调用入口持续观察 `close`，并处理 Windows 进程树终止、已关闭流和终止不确定性。
- 应用退出协调器只安全取消下载校验器和 FLAC 转换；歌曲整理快速扫描、检查、整理或恢复任一繁忙时直接提示等待并阻止退出，不调用歌曲整理内部取消方法。终止或清理无法确认时保留失败并继续阻止退出。
- FLAC 安全退出与歌曲整理相关定向测试此前共 22 个文件、140 项全部通过；不可取消合同定向回归 15 个文件、95 项全部通过。最终全专题为 55 个文件通过、1 个文件跳过，461 项通过、1 项跳过；Main/Renderer `tsc --noEmit`、全量 lint（157.5 秒）及最终变更文件定向 lint 均通过。
- Windows x64 NSIS 已重新构建并完成静态核验；Main 包内保留 `beginShutdown`、`terminateAudioFfmpegProcess` 和 FLAC `cancelAndWait`，歌曲整理 `cancelReadOperationsAndWait` 不再接入退出协调器。最终 Setup 为 142,759,840 bytes，SHA-256 `E2293782C58385795CFF9467032CA7513ED51F3AE26561FCF80DB3B2B586743B`，Authenticode 为 `NotSigned`。

当前状态为 `implemented`。真实 Electron 中暂停转换后关闭客户端、系统 FFmpeg 进程终态和临时文件清理仍待人工验证，关联 BUG 保持 `fixed` 而非 `verified`。
