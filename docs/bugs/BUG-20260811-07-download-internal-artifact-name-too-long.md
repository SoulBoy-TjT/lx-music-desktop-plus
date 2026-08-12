---
id: BUG-20260811-07
type: BUG
title: 下载内部文件名超出 Windows 单段上限导致长名称歌曲发布失败
status: fixed
severity: high
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260806-01
  - REQ-20260811-01
discovered_in_req_id: REQ-20260811-01
introduced_by_req_id: REQ-20260811-01
---

# 下载内部文件名超出 Windows 单段上限导致长名称歌曲发布失败

## 关联文档

- 原下载命名需求：[REQ-20260806-01 下载文件曲序命名与专辑目录组织](../requirements/REQ-20260806-01-album-structured-download.md)
- 发现缺陷时的需求：[REQ-20260811-01 下载音频真实格式校验与降级发布](../requirements/REQ-20260811-01-download-actual-format-publication.md)
- 业务决策：[BIZ-20260811-06 超长歌手与歌曲字段分别省略并预留下载内部文件名空间](../decisions/BIZ-20260811-06-download-long-name-semantic-truncation.md)
- 下载目标方案：[DEV-20260806-01 下载目标解析与任务固化技术方案](../designs/DEV-20260806-01-album-structured-download.md)
- 下载发布方案：[DEV-20260811-01 下载真实格式校验与元数据发布技术方案](../designs/DEV-20260811-01-download-actual-format-publication.md)
- 当日进度：[PROG-20260811](../progress/PROG-20260811.md)

## 现象与诊断证据

- 《从现在 到未来》原唱和伴奏两首长歌手列表合唱曲均已接收来源声明的全部字节，但任务停在 `99.99%`，发布校验创建内部文件时返回 `ENOENT`。
- 两首歌的最终用户文件名虽然满足原有目标限制，发布链继续追加 `.lx-publishing.download`、UUID、FLAC 尾随规范化和 owner 后缀后，单个文件名组件超过 Windows 上限；该 `ENOENT` 是内部文件名不可创建，不是歌手目录真实缺失，也不是来源响应提前结束。
- 现有下载目标从整个基名末尾统一截断，超长歌手列表会占用主要预算并使歌曲名部分或全部消失，不符合用户要求的可辨识结果。

## 根因

`downloadTarget` 只按最终用户文件名和完整目标路径限制长度，没有把下载发布、格式校验和 FLAC 规范化阶段继续追加的内部后缀纳入同一个 Windows 单段预算。后续模块直接从已经接近上限的目标名派生内部文件名，因此目标解析阶段接受了发布阶段无法创建的名称。

该缺陷由 `REQ-20260811-01` 新增的发布、校验及规范化内部文件链暴露和引入；`REQ-20260806-01` 的原路径安全规则未覆盖后续内部后缀，是需要同步补齐的上游约束。

## 与《怜心（伴奏）》的边界

《怜心（伴奏）》的文件名较短，不会触发 Windows 单段长度问题。该曲可以正常播放但被严格校验拒绝，已独立记录为 [BUG-20260811-08 完整 FLAC 因相邻末帧 CRC 候选被歧义保护误拒](BUG-20260811-08-flac-terminal-frame-boundary-ambiguity.md)；本缺陷只修复两首长合唱曲的命名与内部路径预算，不放宽解码校验。

## 期望修复

1. 下载目标按歌手和歌曲名语义字段分别分配预算，在字符边界截断并使用 `...` 标识，同时保留曲序、字段分隔符和扩展名。
2. 截断结果保留稳定消歧信息，不能使不同长名称静默映射到同一目标或覆盖已有文件。
3. 最终用户文件名必须预留最长内部后缀空间；transfer、publishing、normalizing 和 owner 等所有派生文件组件都必须处于 Windows 单段上限内。
4. 旧持久化任务不自动重算路径；修复后的验证使用新建任务，既有成品和失败临时文件不自动移动、重命名或覆盖。

## 验证计划

- 为歌手超长、歌曲名超长、二者同时超长以及相同前缀但原始文本不同的样例补充下载目标回归。
- 由最终目标构造实际 transfer、publishing、FLAC 规范化及 owner 文件名，逐项验证单段长度和路径关联关系。
- 回归真实格式重解析、歌词同基名、任务固化、同批去重及已有目标不覆盖语义。
- 执行相关 Vitest、Renderer/Main/Common TypeScript、定向 ESLint 和 Main/Renderer 生产构建。
- 自动化通过并完成差异检查后可收口为 `fixed`；只有在真实 Electron 中重新创建两首长合唱曲任务并成功越过 `99.99%`、发布成品后才可标记为 `verified`。

## 修复实现与验证证据

- 新增共享模块 `src/common/downloadArtifactPaths.ts`，集中定义 `WINDOWS_MAX_PATH_COMPONENT_LENGTH=255`、transfer/publication/FLAC repair/owner 后缀、repair ID 长度与路径构造函数；按最长 owner 组合反推 `MAX_DOWNLOAD_FILE_STEM_LENGTH=158`。
- `downloadTarget` 不再从整个基名末尾统一截断。歌手名和歌曲名使用独立预算，超限字段输出可辨识前缀与 `...~<hash>`，在保留曲序、` - ` 和真实扩展名的同时保持相同输入稳定、同前缀不同原文可区分，并避免切开 UTF-16 代理对。
- Main validator 与 Renderer publication 复用同一组内部后缀和 repair/owner 路径函数，目标解析、真实格式重解析和校验内部文件不再各自维护不一致的长度假设。
- 长名称定向回归 4 个文件、89 项全部通过；全专题 55 个文件通过、1 个文件跳过，466 项通过、1 项跳过，并覆盖深层路径极限缩短后的省略标志与稳定消歧。
- Common、Main、Renderer `tsc --noEmit` 均退出 0，变更文件定向 ESLint 退出 0；`build:main` 与 `build:renderer` 生产构建均退出 0。
- 真实 Windows 最大组件 public validator 测试成功创建长度恰为 255 的 owner 文件，并完成有界尾随 FLAC 规范化，证明 158 字符基名预算能够覆盖当前最长内部后缀组合。
- 包含本修复的最终 Windows x64 NSIS 已通过完整生产构建和静态验包；Setup、blockmap、`latest.yml`、ASAR、FFmpeg 与 native 模块核验正常，Setup 与 unpacked exe 均为 `NotSigned`。

缺陷状态收口为 `fixed`，不是 `verified`。代码、自动化、生产构建和静态验包已完成；安装器尚未运行，也未在真实 Electron 中删除并重新创建两首长合唱曲任务、确认任务越过 `99.99%` 和最终成品发布。《怜心（伴奏）》的末帧候选修复仍不属于本缺陷。
