---
id: BUG-20260811-08
type: BUG
title: 完整 FLAC 因相邻末帧 CRC 候选被歧义保护误拒
status: fixed
severity: high
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260811-01
discovered_in_req_id: REQ-20260811-01
introduced_by_req_id: REQ-20260811-01
---

# 完整 FLAC 因相邻末帧 CRC 候选被歧义保护误拒

## 关联文档

- 需求：[REQ-20260811-01 下载音频真实格式校验与降级发布](../requirements/REQ-20260811-01-download-actual-format-publication.md)
- 业务决策：[BIZ-20260811-04 完整 FLAC 仅对末帧后有界尾随数据执行无损规范化](../decisions/BIZ-20260811-04-flac-trailing-data-normalization.md)
- 技术方案：[DEV-20260811-01 下载真实格式校验与元数据发布技术方案](../designs/DEV-20260811-01-download-actual-format-publication.md)
- 前序缺陷：[BUG-20260811-06 完整 FLAC 因末帧后尾随数据被严格校验拒绝](BUG-20260811-06-valid-flac-rejected-for-trailing-data.md)
- 当日进度：[PROG-20260811](../progress/PROG-20260811.md)

## 现象与诊断证据

- 《怜心（伴奏）》可以在 LX Music 中正常播放，但下载到 `99.99%` 后仍被严格校验拒绝；文件名较短，不属于 Windows 文件名单段超限。
- 来源文件大小为 `49,788,606` bytes。原件严格解码失败，但失败前已输出 `49,528,832` bytes canonical s16le PCM，与 STREAMINFO 声明样本数一致。
- 末帧扫描得到相邻 CRC-valid 边界。按候选边界删除 31 字节后的副本仍严格解码失败，删除 30 字节后的 `49,788,576` bytes 副本严格解码退出码为 0；成功副本与原始失败解码输出的 canonical s16le PCM SHA-256 均为 `bd4865b157626989061b6f7e933b3a2a7301f2662785c87ca319dce91c105185`。
- Main public validator seam 已证明原始来源文件在规范化前后内容与 SHA-256 均不变，修复只生成独立规范化副本。

## 根因

原实现要求末帧扫描只能产生一个 CRC-valid 结束边界。FLAC 帧 CRC 的滚动特性可能使真实帧结束位置附近再出现相邻 CRC-valid 候选，因此《怜心（伴奏）》虽然音频主体完整，仍因候选数不等于 1 被保守拒绝。仅凭候选数量、播放成功或选择最短/最长候选都不能证明正确边界。

## 修复边界

1. 原件必须仍满足 FLAC 容器、STREAMINFO、声明样本数、末帧头和 CRC、有界尾随数据等既有条件；原始严格解码失败时记录已经输出的 canonical s16le PCM 字节数与 SHA-256。
2. 最多保留 4 个去重后的合法末帧边界，按结束偏移升序逐个生成不重编码的前缀副本；超过 4 个候选继续拒绝。
3. 每个候选都重新执行严格 FFmpeg 解码。只有退出码为 0、解码字节数等于 STREAMINFO 声明样本数对应字节数，且 canonical s16le PCM SHA-256 与原始失败解码输出一致时才可发布；取首个匹配候选。
4. 某候选严格解码失败、样本数不一致或 PCM SHA-256 不一致时清理该副本并继续下一个；所有候选均失败时保持原错误，不留下成品。
5. 不原地修改来源文件，不按时长猜测截断点，不放宽中段损坏、样本数异常、帧/CRC 错误、尾随超限或未知格式。

## 修复与验证证据

- `flacTrailingData` 已改为返回不超过 4 个、按结束偏移升序排列的有界候选；候选为空或超限时继续失败关闭。
- Main validator 对候选逐一生成前缀副本并严格解码，同时核对声明样本数对应字节数及 canonical s16le PCM SHA-256；首个匹配候选被保留，其余失败副本和 owner 标记按既有边界清理。
- 固定回归覆盖首候选严格解码失败、首候选 PCM SHA-256 不一致后接受下一候选，以及普通尾随数据、损坏内容和清理语义。
- 定向 4 个测试文件、92 项全部通过；全专题 55 个文件通过、1 个文件跳过，469 项通过、1 项跳过。Common、Main、Renderer TypeScript 均退出 0，3 个变更 TypeScript 文件定向 ESLint 退出 0。
- 真实《怜心（伴奏）》通过 Main public validator seam：`49,788,606` bytes 原件保持不变，31 字节候选失败后选中删除 30 字节的 `49,788,576` bytes 副本；副本严格解码成功、声明样本数一致，两次 canonical s16le PCM SHA-256 均为 `bd4865b157626989061b6f7e933b3a2a7301f2662785c87ca319dce91c105185`。
- 使用 `LX_SKIP_WIN_EXECUTABLE_EDIT=true` 完整执行 `npm run pack`，退出码 0、耗时 87.1 秒；Windows x64 NSIS、blockmap、`latest.yml`、`app.asar`、随包 FFmpeg 和 native 模块静态核验通过，ASAR 已确认包含末帧候选消歧实现。Setup 与 unpacked exe 均为 `NotSigned`。

缺陷状态收口为 `fixed`，不是 `verified`。代码、自动化、真实 public seam、生产构建和静态验包已完成；安装器尚未运行，也未在真实 Electron 中重新下载《怜心（伴奏）》并核对最终成品、元数据、封面和时长。
