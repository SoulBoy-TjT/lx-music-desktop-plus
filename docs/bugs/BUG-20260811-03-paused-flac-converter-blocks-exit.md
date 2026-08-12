---
id: BUG-20260811-03
type: BUG
title: 暂停的 FLAC 转换无限保持繁忙并阻止退出
status: fixed
severity: high
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260808-01
discovered_in_req_id: REQ-20260808-01
introduced_by_req_id: REQ-20260808-01
---

# 暂停的 FLAC 转换无限保持繁忙并阻止退出

> 歌曲整理退出语义已由 [BIZ-20260811-05](../decisions/BIZ-20260811-05-song-organizer-non-cancellable-operations.md) 修订；以下 FLAC 转换修复结论不变，但快速扫描和检查现改为提示等待而不是随关闭请求取消。

## 关联文档

- 来源需求：[REQ-20260808-01 FLAC 批量转换为 MP3](../requirements/REQ-20260808-01-flac-to-mp3.md)
- 业务决策：[BIZ-20260811-02 应用关闭时安全取消 FLAC 转换并保留歌曲整理退出保护](../decisions/BIZ-20260811-02-flac-converter-safe-exit-cancel.md)
- 技术方案：[DEV-20260811-02 FLAC 转换关闭安全取消技术方案](../designs/DEV-20260811-02-flac-converter-safe-exit-cancel.md)
- 当日进度：[PROG-20260811](../progress/PROG-20260811.md)

## 实际行为

暂停请求在文件边界生效后，转换 runner 等待“继续”，服务持续报告繁忙；应用退出编排只要看到繁忙就拒绝退出，因此用户不继续转换便无法正常关闭客户端。

## 期望行为

- 关闭请求向运行中或暂停中的转换发送安全取消，不等待用户继续。
- 停止新项目、终止并等待 FFmpeg、清理临时文件、令 busy 归零后继续退出。
- 已发布成品和源文件保持不变。
- 歌曲整理的清理/重命名退出保护不受本缺陷修复影响。

## 修复与验证证据

- `FlacConverterService.cancelAndWait()` 会释放暂停门闩、发出取消、终止并等待当前 FFmpeg `close`，清理临时文件并在终态释放 `busy`；重复关闭和自然完成竞态收敛到同一等待结果。
- 应用退出编排会安全取消 FLAC 转换；歌曲整理快速扫描、检查、整理或恢复任一繁忙时均阻止退出并提示等待，不调用歌曲整理内部取消方法。无法确认子进程终止或临时文件清理失败时继续阻止退出并保留可诊断错误。
- 原 FLAC 安全退出回归已通过；后续不可取消合同的歌曲整理与退出协调定向回归为 15 个文件、95 项通过，Main/Renderer 类型检查及定向 ESLint 通过。安装包仍待本轮统一重新构建和静态核验。

缺陷状态收口为 `fixed`。尚未在真实 Electron 中暂停转换后点击关闭，也未人工确认系统进程和磁盘临时文件终态，因此不标记为 `verified`。
