---
id: BUG-20260811-02
type: BUG
title: 请求 FLAC 但实际 MP3 被错误发布为 FLAC
status: fixed
severity: high
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260811-01
discovered_in_req_id: REQ-20260811-01
introduced_by_req_id: null
---

# 请求 FLAC 但实际 MP3 被错误发布为 FLAC

## 关联文档

- 来源需求：[REQ-20260811-01 下载音频真实格式校验与降级发布](../requirements/REQ-20260811-01-download-actual-format-publication.md)
- 业务决策：[BIZ-20260811-01 下载按真实音频格式发布并明确提示降级](../decisions/BIZ-20260811-01-download-actual-format-publication.md)
- 技术方案：[DEV-20260811-01 下载真实格式校验与元数据发布技术方案](../designs/DEV-20260811-01-download-actual-format-publication.md)
- 当日进度：[PROG-20260811](../progress/PROG-20260811.md)

## 发现与根因

用户检查阿杜《小城故事 电视剧原声音乐》时发现部分 `.flac` 在 Windows 中缺少时长、专辑和封面。只读诊断确认其中 10 个文件实际为 MP3 内容；下载链按计划 FLAC 固化扩展名，未在最终发布前校验真实容器，FLAC 标签写入器遇到非 FLAC 内容后没有补齐 MP3 元数据。

该行为来自既有下载发布链，当前无法归因于本次新需求，因此 `introduced_by_req_id` 为 `null`。

## 期望行为与验证边界

- 最终发布前识别真实容器/codec；实际 MP3 只能发布为 `.mp3`。
- 使用真实格式对应的元数据写入器，并明确报告 FLAC 到 320k MP3 的降级。
- 未识别或损坏内容不发布成品，不产生伪 FLAC。
- 不修复当前 10 个既有文件；用户将在新代码中重新下载验证。

## 修复与验证证据

- 下载发布链已经在临时文件完成后校验真实容器与 codec，按 `actualFormat` 重算扩展名、元数据写入器、最终路径、歌词基名和展示数据；计划 FLAC 但实际 MP3 时发布真实 `.mp3`，并分别保留 `requestedQuality`、实际格式和降级信息。
- 发布使用 `.lx-publishing.*` 暂存与不覆盖提交；未知、损坏、容器冲突、目标冲突和恢复失败不会伪装为成功成品，任务持久化和同会话恢复均覆盖最终路径及格式状态。
- 下载相关 10 个测试文件通过、1 个文件按环境跳过，共 85 项通过、1 项跳过；better-sqlite3 持久化用例另在 Electron ABI 下 1/1 通过。全专题最终为 52 个文件通过、1 个文件跳过，419 项通过、1 项跳过。
- 安装包静态核验确认 Main/Renderer/Download Worker 包含真实格式探测、元数据计划、重试协调、恢复、`.lx-publishing` 和 `requestedQuality` 实现标志；既有 10 个异常文件没有被修改、重命名或删除。

缺陷状态收口为 `fixed`。用户尚未使用新安装包重新下载目标专辑，也未在真实 Electron/Windows 文件属性中核对扩展名、完整解码、标题、歌手、专辑、封面、时长和降级提示，因此不标记为 `verified`。
