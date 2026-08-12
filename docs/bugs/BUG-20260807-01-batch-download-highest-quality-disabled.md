---
id: BUG-20260807-01
type: BUG
title: 批量下载最高音质被精确交集规则禁用
status: fixed
severity: high
created_at: 2026-08-07
updated_at: 2026-08-07
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: REQ-20260805-01
---

# 批量下载最高音质被精确交集规则禁用

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 业务决策：[BIZ-20260807-01 批量下载优先音质与逐曲自动降级策略](../decisions/BIZ-20260807-01-batch-download-quality-fallback.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)
- 历史缺陷：[BUG-20260805-06 原生批量下载弹窗未禁用不可用音质](BUG-20260805-06-batch-download-quality-fallback.md)

## 发现方式

2026-08-07 人工验收中，用户全选歌曲并打开批量下载弹窗，发现只有前三档音质可选，最高音质处于禁用状态；其余人工验收项目均通过。

## 根因

批量弹窗要求当前用户源和每首选中歌曲都精确声明所选音质，才启用对应按钮。下载 worker 已经具备逐曲向低音质回退能力，但界面在任务创建前用更严格的条件拦截，导致最高音质无法作为整批歌曲的优先音质。

## 期望行为

- 最高音质可以作为整批歌曲的优先音质。
- 支持最高音质的歌曲保持最高音质；不支持的歌曲自动降级到歌曲与当前用户源共同支持的最高音质。
- 发生降级时显示明确提示。
- 某首歌曲不存在任何共同支持音质时仍禁用操作。

## 修复记录

- 抽取共享 `resolveDownloadQuality`，由批量弹窗可用性判断和下载 worker 共用同一逐曲解析规则。
- 批量弹窗改为检查每首歌曲能否解析到共同支持音质，不再要求全部歌曲精确支持同一档。
- 新增“部分歌曲将自动降级到可用的最高音质”提示。
- worker 使用同一解析函数固化每首任务的实际音质，避免 UI 与执行层规则漂移。

## 验证记录

- 先增加混合音质失败用例，修复前稳定得到 `track_unsupported`，证明 UI 精确交集规则会禁用最高音质。
- 修复后 UI 与 worker 共 7 项音质测试通过，覆盖保持最高音质、歌曲逐曲降级、用户源降级和无共同音质禁用。
- `npm run test:artist-discography`：10 个测试文件、61 项测试通过。
- Renderer TypeScript、三份语言 JSON、`npm run lint`、`npm run build:renderer` 与 `npm run build` 均通过。
- 尚未在 Electron 中人工复测修复后的最高音质按钮和实际逐曲任务音质，因此状态为 `fixed`，不提前标记 `verified`。
