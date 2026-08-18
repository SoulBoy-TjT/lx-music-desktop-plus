---
id: REQ-20260811-01
type: REQ
title: 下载音频真实格式校验与降级发布
status: in_progress
created_at: 2026-08-11
updated_at: 2026-08-18
owner: KhalilFong
---

# 下载音频真实格式校验与降级发布

## 关联文档

- 上游下载需求：[REQ-20260806-01 下载文件曲序命名与专辑目录组织](REQ-20260806-01-album-structured-download.md)
- 业务决策：[BIZ-20260811-01 下载按真实音频格式发布并明确提示降级](../decisions/BIZ-20260811-01-download-actual-format-publication.md)
- 业务决策：[BIZ-20260811-04 完整 FLAC 仅对末帧后有界尾随数据执行无损规范化](../decisions/BIZ-20260811-04-flac-trailing-data-normalization.md)
- 长名称补充决策：[BIZ-20260811-06 超长歌手与歌曲字段分别省略并预留下载内部文件名空间](../decisions/BIZ-20260811-06-download-long-name-semantic-truncation.md)
- 技术方案：[DEV-20260811-01 下载真实格式校验与元数据发布技术方案](../designs/DEV-20260811-01-download-actual-format-publication.md)
- 关联缺陷：[BUG-20260811-02 请求 FLAC 但实际 MP3 被错误发布为 FLAC](../bugs/BUG-20260811-02-requested-flac-published-mp3-as-flac.md)
- 关联缺陷：[BUG-20260811-05 下载生命周期回调对象无法被 Worker 结构化克隆](../bugs/BUG-20260811-05-download-worker-preparation-lifecycle-not-cloneable.md)
- 关联缺陷：[BUG-20260811-06 完整 FLAC 因末帧后尾随数据被严格校验拒绝](../bugs/BUG-20260811-06-valid-flac-rejected-for-trailing-data.md)
- 关联缺陷：[BUG-20260811-07 下载内部文件名超出 Windows 单段上限导致长名称歌曲发布失败](../bugs/BUG-20260811-07-download-internal-artifact-name-too-long.md)
- 关联缺陷：[BUG-20260811-08 完整 FLAC 因相邻末帧 CRC 候选被歧义保护误拒](../bugs/BUG-20260811-08-flac-terminal-frame-boundary-ambiguity.md)
- 关联缺陷：[BUG-20260818-01 下载响应中途断开后任务停留在运行状态](../bugs/BUG-20260818-01-interrupted-download-stuck-running.md)

## 背景

Provider 或自定义源可能在请求 FLAC 时返回 MP3。当前链路按计划音质选择扩展名，未在最终发布前核对真实容器，导致 MP3 内容以 `.flac` 落盘；随后 FLAC 元数据写入器无法处理该内容，Windows 也不能按扩展名正确读取时长、专辑和封面。

## 目标与范围

- 在下载临时文件发布为最终音频前识别真实音频容器与 codec。
- 计划为 FLAC、实际为 MP3 时按 `.mp3` 发布，写入适用于 MP3 的标题、歌手、专辑和封面。
- 在下载任务结果中明确记录并展示“无损资源不可用，已降级为 320k MP3”或等价结构化提示。
- 禁止把 MP3 使用 `.flac` 扩展名发布，也禁止为满足扩展名而把 MP3 转码成 FLAC。
- 保持原生下载任务、重试、持久化、进度、路径安全和不覆盖语义。
- 对已经证明全部声明样本、最终音频帧和 CRC 完整，且异常仅位于最终帧后有界范围的 FLAC，允许删除尾随数据并在严格复验通过后按真实 FLAC 发布。
- 发布、格式校验和 FLAC 规范化使用的内部文件名必须服从与最终下载目标统一的 Windows 单段预算，不因追加内部后缀使完整下载在发布阶段失败。

## 非目标

- 不修改、重命名或补写已经落盘的伪 FLAC；用户会在代码修复后重新下载验证。
- 不保证 Provider 一定提供真实无损资源。
- 不把有损 MP3 转换为 FLAC，不新增音质增强或修复算法。
- 除 `BIZ-20260811-04` 明确定义的完整 FLAC 末帧后有界尾随数据外，不放宽损坏文件、未知格式或容器与 codec 冲突的发布条件。

## 验收标准

- [x] AC-01：计划 FLAC、实际 MP3 的固定样例最终只生成 `.mp3`，文件魔数、容器、codec 和扩展名一致。
- [x] AC-02：降级 MP3 可完整解码，并包含可用的标题、歌手、专辑和内嵌封面；元数据缺失时返回可定位异常，不伪造值。
- [x] AC-03：任务持久化的最终路径、文件名、歌词基名和页面展示均采用真实 `.mp3` 路径，不残留同名 `.flac` 成品或临时文件。
- [ ] AC-04：用户能够看到该曲目从 FLAC 降级为 320k MP3 的明确提示；成功状态不得掩盖降级事实。
- [x] AC-05：真实 FLAC、正常 MP3、未知/损坏内容、重试、已有目标和设置变更均有自动化回归，且不静默覆盖文件。
- [ ] AC-06：不对当前已有的 10 个伪 FLAC 执行任何迁移、修复或删除；由用户重新下载完成人工验收。
- [x] AC-07：下载生命周期跨 Worker 传输时不触发 `DataCloneError`；任务能够离开 `0%` 并进入真实下载流程。
- [x] AC-08：只对全部声明样本、最终音频帧及 CRC 完整且异常仅在末帧后有界范围的 FLAC 删除尾随数据；规范化后严格完整解码、格式与样本数复验通过才发布，中段损坏、样本/CRC 异常及尾随超限继续拒绝。
- [x] AC-09：长歌手名或歌曲名经字段级省略后，transfer、publishing、格式重解析、FLAC 规范化和 owner 等全部内部文件组件均不超过 Windows 单段上限；新建任务不会在内容下载完整后因内部文件名过长返回 `ENOENT`。
- [x] AC-10：末帧附近存在多个有界 CRC-valid 边界时，候选按结束偏移升序逐一严格解码；只有解码字节数等于 STREAMINFO 声明样本数对应字节数，且 canonical s16le PCM SHA-256 与原始失败解码已经输出的完整音频一致时，才采用首个匹配边界。候选超过 4 个或全部失败继续拒绝。

## 放行状态

用户已确认真实格式发布、正确元数据写入、明确降级提示、禁止伪 FLAC/伪无损、末帧后有界尾随数据规范化以及不处理既有文件的边界。最终全专题为 55 个文件通过、1 个文件跳过，461 项通过、1 项跳过；尾随数据最终定向回归 3 个文件、75 项全部通过。Main 与 Renderer `tsc --noEmit`、全量 lint（157.5 秒）及最终变更文件定向 lint 均通过。

2026-08-11 后续真实下载暴露 `BUG-20260811-07`：两首长歌手列表合唱曲已接收全部来源字节，但内部文件名单段超限使发布阶段返回 `ENOENT`。共享内部路径常量现已按最长 owner 组合把最终基名限制为 158，歌手名与歌曲名使用字段级 `...~<hash>` 省略；真实 Windows public validator 测试成功创建长度恰为 255 的 owner 文件并完成 FLAC 规范化，AC-09 的自动化边界已完成。长名称定向回归 4 个文件、89 项全部通过；全专题 55 个文件通过、1 个文件跳过，466 项通过、1 项跳过。Common、Main、Renderer TypeScript、变更文件定向 ESLint 及 Main/Renderer 生产构建均退出 0。

包含长名称修复的 Windows x64 NSIS 已完成生产构建和静态验包，但安装器尚未运行，也未在真实 Electron 中重新创建并下载两首长合唱曲；`BUG-20260811-07` 因而保持 `fixed` 而非 `verified`。《怜心（伴奏）》的最终帧候选问题已独立记录为 `BUG-20260811-08`，不属于长名称验收项，也没有通过长名称修复放宽严格校验。

`BUG-20260811-08` 已完成代码、自动化和真实 Main public validator seam 验证。真实《怜心（伴奏）》原件为 `49,788,606` bytes，严格失败前已输出与声明样本数一致的 `49,528,832` bytes canonical s16le PCM；31 字节候选严格失败后，30 字节候选生成 `49,788,576` bytes 副本并严格解码成功，副本与原始失败解码输出的 canonical s16le PCM SHA-256 均为 `bd4865b157626989061b6f7e933b3a2a7301f2662785c87ca319dce91c105185`，来源文件前后内容与 SHA-256 不变。定向 4 个测试文件、92 项全部通过；全专题 55 个文件通过、1 个文件跳过，469 项通过、1 项跳过；Common、Main、Renderer TypeScript 与 3 个变更 TypeScript 文件定向 ESLint 均退出 0，AC-10 的自动化边界据此完成。新安装包已完成生产构建和静态验包，真实 Electron 重下仍待完成，BUG 状态为 `fixed` 而非 `verified`。

`BUG-20260818-01` 已恢复 `aborted`、`socket hang up` 与不完整响应结束的错误上报；错误等待写流关闭后唯一上报，并以 attempt token 隔离旧网络、超时和磁盘初始化回调。Worker 沿用“初次失败后最多自动重试 2 次”语义从 transfer 文件执行 Range 续传。本地 HTTP 公开 Worker seam 已证明中途断流可自动续传并逐字节还原音频，连续 3 次响应头前断连会在两次重试后进入错误终态；扩展下载回归 5 个文件、59 项通过，Common/Renderer TypeScript、定向与全量 ESLint、Renderer 生产构建均退出 0。真实 Electron 安装态的受控断流与休眠/唤醒仍待人工验证，缺陷状态为 `fixed` 而非 `verified`。

真实《STRANGE》文件已通过 Main public service 隔离验证：来源文件保持不变，规范化副本精确删除末帧后的 30 字节，严格完整解码、格式与样本数复验通过；固定回归继续拒绝中段损坏、样本/CRC 异常及尾随超限，AC-08 据此勾选。用户此前已在真实 Electron 下载页确认任务能够离开 `0%` 并到达 `99.99%`，不再出现 `DataCloneError`，AC-07 保持完成。

最终在 `LX_SKIP_WIN_EXECUTABLE_EDIT=true` 下执行 `npm run pack`，退出码 0、总耗时 87.1 秒。Setup 为 142,763,630 bytes，SHA-256 `509B1A24BE394A977EC4E2AC439A5ADA000096B083CC6891B5468DC53B409DF8`；blockmap 为 150,410 bytes，SHA-256 `EB039FF0047A24A347125D224ED111BBA5C83CB0BFA83C93D9338EA8E094002E`；`app.asar` 为 34,187,373 bytes，SHA-256 `A64CF5BE1065E8840B40A66E41596707B77DCFACFFD6EC99106D4DB6A5A03850`。`latest.yml` 的 path、size 和两处 SHA-512 `t5YSrh8VXpz/F/nfWk9KHqSucQSlg+lO3r9sN8TgmsS9qyOzMzzLFnWmLQZ8dlSyIEZPsNn/lK1VoKXuBotmkA==` 一致；`7za t` 返回 `Everything is Ok`，仅有标准 NSIS tail warning。ASAR metadata、4 个实现标志、随包 FFmpeg/许可证及 Electron ABI 下的 better-sqlite3、qrc_decode 均核验通过；Setup 与 unpacked exe 为 `NotSigned`。安装器尚未运行，用户也尚未使用本轮安装包重新下载并核对降级提示、最终文件属性、长名称发布和尾随规范化结果；当前 10 个伪 FLAC 保持原样。AC-04、AC-06 继续等待人工验收，本需求状态保持 `in_progress`。
