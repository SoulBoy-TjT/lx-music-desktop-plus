---
id: BIZ-20260811-02
type: BIZ
title: 应用关闭时安全取消 FLAC 转换并保留歌曲整理退出保护
status: accepted
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260808-01
amends:
  - BIZ-20260808-03
  - BIZ-20260809-01
decision_date: 2026-08-11
decision_owner: KhalilFong
---

# 应用关闭时安全取消 FLAC 转换并保留歌曲整理退出保护

> 歌曲整理只读任务的关闭语义已由 [BIZ-20260811-05](BIZ-20260811-05-song-organizer-non-cancellable-operations.md) 修订：快速扫描和检查运行期间同样阻止退出，不再由关闭流程取消。FLAC 转换的安全取消规则保持不变。

## 关联文档

- 来源需求：[REQ-20260808-01 FLAC 批量转换为 MP3](../requirements/REQ-20260808-01-flac-to-mp3.md)
- 关联缺陷：[BUG-20260811-03 暂停的 FLAC 转换无限保持繁忙并阻止退出](../bugs/BUG-20260811-03-paused-flac-converter-blocks-exit.md)
- 技术方案：[DEV-20260811-02 FLAC 转换关闭安全取消技术方案](../designs/DEV-20260811-02-flac-converter-safe-exit-cancel.md)
- 原模块决策：[BIZ-20260808-03 FLAC 转 MP3 使用独立模块与导航](BIZ-20260808-03-flac-converter-independent-module.md)
- 原工作区决策：[BIZ-20260809-01 FLAC 转 MP3 使用歌手列表、行内进度与异常结果](BIZ-20260809-01-flac-converter-artist-workspace.md)

## 决策

1. 用户正常关闭应用时，运行中或暂停中的 FLAC 转换不再无限阻止退出；关闭请求转换为一次安全取消请求。
2. 安全取消必须停止启动新项目，终止并等待当前 FFmpeg 子进程退出，清理本次临时文件，令转换 `busy` 归零后再继续退出。
3. 暂停状态不是不可退出的终态；关闭期间不得等待用户先点击“继续”。
4. 已经原子发布的成品保留，源文件永不修改；未发布的临时文件不得作为成品保留。
5. 清理和重命名属于多步骤磁盘修改，执行期间继续阻止正常退出；本决策不取消或弱化它们的操作日志、回滚和退出保护。
6. 歌曲整理的快速统计或深度检查属于可取消读操作，关闭应用时应取消并等待其 FFmpeg 子进程退出，而不是阻止退出。

## 代价与边界

- Electron/系统强制终止、进程崩溃或断电不能保证完成异步清理；现有启动恢复和临时文件识别仍需保留。
- 安全取消不是“强制立即杀死应用”；关闭流程必须等待有界的子进程终止与清理结果。

## 确认记录

以上关闭安全取消、已发布成品保留、临时文件清理、歌曲整理清理/重命名保护不变及扫描可取消边界已由用户于 2026-08-11 明确确认，状态为 `accepted`。
