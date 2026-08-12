---
id: BUG-20260811-01
type: BUG
title: 酷我整专辑零基曲序被严格映射误拒并导致曲序错位
status: verified
severity: high
created_at: 2026-08-11
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260809-01
discovered_in_req_id: REQ-20260809-01
introduced_by_req_id: REQ-20260809-01
---

# 酷我整专辑零基曲序被严格映射误拒并导致曲序错位

## 关联文档

- 来源需求：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 技术方案：[DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](../designs/DEV-20260809-01-four-source-artist-discography-playlists.md)
- 当日进度：[PROG-20260811](../progress/PROG-20260811.md)
- 既有曲序决策：[BIZ-20260806-01 下载曲序命名与专辑目录策略](../decisions/BIZ-20260806-01-album-download-path-and-file-name.md)
- 相似缺陷：[BUG-20260810-02 网易专辑曲序 no=0 被严格映射误拒导致漏曲](BUG-20260810-02-wy-zero-track-number.md)

## 发现方式

用户抓取酷我歌手“阿杜”（artistId `922`）时，《醇情歌》（albumId `65066`）声明 19 首，但预览仅保留 18 首并显示曲目响应异常及多条 `19 → 18` 完整性提示。

只读实时复现确认：酷我详情稳定返回 19 个唯一歌曲 ID，原始歌曲数组及 `track` 字段均为完整的零基序列 `0..18`。第一首《爱就是你》（trackId `40358244`）的 `track=0`；当前 mapper 要求曲序大于 0，因而在 core 能使用详情稳定顺序前将该合法歌曲丢弃。

## 实际行为

1. 酷我 mapper 把合法的整专辑零基曲序中的首项 `track=0` 归类为 `invalid_provider_response`。
2. 《爱就是你》未进入来源快照，其余 `track=1..18` 被当作一基曲序保留，既漏曲又使下载曲序整体错位。
3. 专辑声明数 19 与 mapper 后有效数 18 的差异在 adapter、core 和来源摘要链路中产生多条同根因提示。
4. 页面显示的来源内去重歌曲数只统计已经通过 mapper 的 18 首，不能证明被提前拒绝的歌曲不存在。

## 期望行为

1. 酷我完整专辑详情中的全部可解析曲序若严格按响应位置形成连续零基序列 `0..N-1`，应将整张专辑统一规范化为一基曲序 `1..N`，不能只补首项。
2. 一基正整数曲序原样保留；若 Provider 的一基曲序本身存在中间缺口，例如 `1、2、3、5`，必须继续保留该缺口，不能压缩为 `1、2、3、4`。
3. 只有完整、连续且与详情响应位置一致的零基序列才能触发整专辑平移；负数、非整数、非数字或混合畸形序列仍按非法响应处理。
4. 歌曲 ID、名称、歌手、canonical albumId、专辑名、时长及其他既有严格校验保持不变。
5. 《醇情歌》应保留全部 19 首，《爱就是你》的曲序为 1，末曲曲序为 19，不再产生该专辑 `19 → 18` 及其级联提示。

## 验证标准

- [x] 脱敏酷我 fixture 覆盖《醇情歌》19 首、`track=0..18`，mapper 输出 19 首和曲序 `1..19`，无 `invalid_provider_response` 或数量不一致 issue。
- [x] 一基连续曲序及一基中间缺口原样保留，明确证明缺少第 4 首时第 5 首仍为曲序 5。
- [x] 非连续零基、负数、非整数、非数字及其他必需字段错误继续严格拒绝，不扩大兼容范围。
- [x] 酷我 mapper/adapter 定向测试、专题回归、Renderer TypeScript、定向 ESLint 和生产构建通过。
- [x] 真实只读复现《醇情歌》得到 19/19、曲序 `1..19` 且无同根因 issue；Windows 安装包重新构建并静态确认包含修复，真实安装态和 Electron 页面验收边界单独记录。

## 当前状态

已完成生产修复、红绿回归、真实只读复现和安装包静态核对。mapper/adapter 24 项、定向链路 47 项、全专题 41 个文件 307 项全部通过，Renderer TypeScript、定向 ESLint 和四套 production webpack 均通过；独立审查未发现 P0/P1/P2 问题。真实《醇情歌》为声明 19 首、实际 19 首、`complete=true`、曲序 `1..19`，首曲 `kw_40358244 / 爱就是你 / 曲序 1`，`issues=[]`。Windows x64 NSIS 安装包已包含 `trackNumbering/rawOffset` 等新逻辑，但未运行安装器或执行真实 Electron 页面和实际下载人工验收；状态更新为 `verified`。
