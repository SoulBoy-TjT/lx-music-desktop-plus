---
id: BIZ-20260811-01
type: BIZ
title: 下载按真实音频格式发布并明确提示降级
status: accepted
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260811-01
amends:
  - BIZ-20260807-01
decision_date: 2026-08-11
decision_owner: KhalilFong
---

# 下载按真实音频格式发布并明确提示降级

## 关联文档

- 来源需求：[REQ-20260811-01 下载音频真实格式校验与降级发布](../requirements/REQ-20260811-01-download-actual-format-publication.md)
- 被修订决策：[BIZ-20260807-01 批量下载优先音质与逐曲自动降级策略](BIZ-20260807-01-batch-download-quality-fallback.md)
- 后续局部修订：[BIZ-20260811-04 完整 FLAC 仅对末帧后有界尾随数据执行无损规范化](BIZ-20260811-04-flac-trailing-data-normalization.md)
- 关联缺陷：[BUG-20260811-02 请求 FLAC 但实际 MP3 被错误发布为 FLAC](../bugs/BUG-20260811-02-requested-flac-published-mp3-as-flac.md)
- 技术方案：[DEV-20260811-01 下载真实格式校验与元数据发布技术方案](../designs/DEV-20260811-01-download-actual-format-publication.md)

## 决策

1. 用户选择和 Provider 声明只表示计划音质，不能直接决定最终扩展名；最终发布前必须校验下载内容的真实容器与 codec。
2. 计划 FLAC、实际 MP3 时，按真实 MP3 发布并使用 MP3 元数据写入链路；最终文件、持久化路径、歌词基名和下载页展示统一使用 `.mp3`。
3. 该情况属于可用资源降级，必须明确提示“无损资源不可用，已降级为 320k MP3”或等价结构化信息，不能只显示普通成功。
4. 禁止把 MP3 冒充 FLAC，也禁止把 MP3 转码为体积更大的伪无损 FLAC。
5. 未识别、损坏或容器/codec 无法安全确定的内容不发布为成品，继续使用既有失败、重试和临时文件清理语义。
6. 本修订只影响后续下载；不扫描、修改、重命名或补写既有伪 FLAC。

## 对既有决策的修订

`BIZ-20260807-01` 的逐曲自动降级继续有效，但实际内容校验成为最终发布边界；Provider 宣称或任务计划的音质不能覆盖真实格式证据。其他来源兼容、禁用条件和原生下载复用规则保持不变。

本决策“决策”第 5 条随后由 `BIZ-20260811-04` 局部修订：当全部 STREAMINFO 声明样本、最终音频帧及 CRC 均已证明完整，且异常仅位于最终帧后的有界尾随范围时，允许先做无损规范化并在严格复验通过后发布；其余损坏内容继续拒绝。本决策其余条款和 `accepted` 状态不变。

## 确认记录

以上真实格式保存、元数据/封面写入、明确降级提示、禁止伪无损和不处理既有文件的边界已由用户于 2026-08-11 明确确认，状态为 `accepted`。
