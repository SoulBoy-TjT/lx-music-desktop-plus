---
id: BUG-20260810-07
type: BUG
title: 重命名无进度且操作失败无法再次核查
status: verified
severity: high
created_at: 2026-08-10
updated_at: 2026-08-10
owner: KhalilFong
req_ids:
  - REQ-20260806-02
discovered_in_req_id: REQ-20260806-02
introduced_by_req_id: REQ-20260806-02
---

# 重命名无进度且操作失败无法再次核查

## 关联文档

- 来源需求：[REQ-20260806-02 歌曲文件夹整理与音频可播放性检查](../requirements/REQ-20260806-02-song-folder-organizer.md)
- 业务决策：[BIZ-20260810-04 歌曲整理操作进度与失败核查留存](../decisions/BIZ-20260810-04-song-organizer-operation-progress-and-failure-retention.md)
- 技术方案：[DEV-20260806-02 歌曲文件夹整理技术方案](../designs/DEV-20260806-02-song-folder-organizer.md)
- 当日进度：[PROG-20260810](../progress/PROG-20260810.md)

## 现象与根因证据

1. Renderer 内部会在重命名期间设置状态，但 composable 未向页面公开可渲染的操作进度，模板也没有进度区域；Main 重命名 IPC 目前只返回终态。
2. 清理或重命名失败可被结果摘要正确识别，但失败只存在于瞬时结果弹窗。自动重扫替换快照后，普通“查看详情”只读取当前行阻塞与扫描异常，因此显示“未发现异常或操作阻塞”。

## 期望行为

1. 用户点击重命名后立即看到真实操作阶段和 `已完成/总步骤`；逐步执行与回滚均更新进度，终态后结束进行中展示。
2. 自动重扫不清除该歌手最近一次操作失败；普通详情追加失败类型、相对路径、步骤阶段和原始原因。
3. 同一歌手下一次操作替换旧失败；切换根目录或应用重启清空会话记录。
4. 成功步骤和正常扫描明细不进入普通详情，避免重新制造长列表噪音。

## 验证标准

- [x] 重命名开始、逐步执行、回滚和终态均有确定性进度状态测试。
- [x] 清理失败后自动重扫，普通详情仍包含失败路径与原因。
- [x] 下一次同歌手操作、根目录切换和应用重启按规则清理旧失败。
- [x] 定向测试、Renderer/Main TypeScript、ESLint 与生产构建通过。

Main、IPC 与 Renderer 已贯通 `song_organizer_operation_progress`，进度按 `operationId/sourceTaskId/artistPath` 隔离并展示真实阶段、计数和当前相对目标。Renderer 会话按歌手保留最近一次失败、回滚失败和带原因的跳过项，自动重扫不清除；新操作、根目录变化和应用重启按规则淘汰。纯状态、事件隔离、详情组装、双端 TypeScript、ESLint 与生产构建均通过；2026-08-10 18:44:14.170 的阶段 15 Windows x64 NSIS 安装包已通过 ASAR Main 与 Renderer source map 标志确认包含进度事件/监听、同根操作态保留、三重事件过滤、操作异常覆盖层及进度 UI。真实 Electron 点击、自动重扫后详情核查和实际重命名仍属于 REQ 的人工验收边界，BUG 状态保持 `verified`。
