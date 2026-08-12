---
id: BUG-20260810-02
type: BUG
title: 网易专辑曲序 no=0 被严格映射误拒导致漏曲
status: verified
severity: high
created_at: 2026-08-10
updated_at: 2026-08-10
owner: KhalilFong
req_ids:
  - REQ-20260809-01
discovered_in_req_id: REQ-20260809-01
introduced_by_req_id: REQ-20260809-01
---

# 网易专辑曲序 no=0 被严格映射误拒导致漏曲

## 关联文档

- 来源需求：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 技术方案：[DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](../designs/DEV-20260809-01-four-source-artist-discography-playlists.md)
- 当日进度：[PROG-20260810](../progress/PROG-20260810.md)
- 相关缺陷：[BUG-20260809-01 网易专辑详情验证拦截缺少 v1 回退并产生级联提示](BUG-20260809-01-wy-album-verification-fallback.md)
- 既有曲序决策：[BIZ-20260806-01 专辑下载目录与文件名规则](../decisions/BIZ-20260806-01-album-download-path-and-file-name.md)

## 发现方式

用户抓取网易歌手“刘雨昕XIN LIU”时，《梦之光年》（albumId `158473631`）显示两条曲目响应异常，并派生声明数 `2`、实际有效数 `0` 的数量不一致提示，来源状态降为 `partial`。

只读实时复现确认：网易主详情会在合法 legacy 成功响应与精确 `code=-462`、`data.verifyType=50` 后切换 v1 两种路径之间变化；两种详情都可能返回 album size `2` 和两首完整歌曲，但两首的曲序字段 `no` 均为整数 `0`。歌曲 ID、名称、歌手、专辑归属、时长及音质结构均合法。

## 实际行为

1. 网易 mapper 将 `no=0` 解析为非负整数后，又要求曲序必须大于等于 `1`。
2. 两首合法歌曲分别被归类为 `invalid_provider_response` 并丢弃。
3. 有效歌曲由 `2` 变为 `0` 后，core 再派生数量不一致提示；该提示不是第二个分页故障。
4. 当前 core 已能按详情响应顺序为非正曲序补一基曲序，但歌曲在进入 core 前已被 mapper 拒绝，因此回退不可达。

## 期望行为

1. 网易 legacy 或 v1 曲目其他必需字段全部合法，但 Provider 返回 `no=0` 或没有独立曲序字段时，将其视为“没有可用的一基曲序”，按当前专辑详情响应中的稳定位置补为 `index + 1`。
2. 正整数曲序原样保留；负数、非整数或非数字曲序仍按非法响应处理，不扩大兼容范围。
3. 稳定歌曲 ID、名称、歌手、专辑归属和时长等既有严格校验保持不变。
4. 《梦之光年》两首歌曲应全部进入来源快照，不再产生两条曲目异常及其 `2 → 0` 级联提示。

## 验证标准

- [x] 脱敏 legacy 与 v1 fixture 均覆盖同一专辑两首歌曲返回 `no=0`，mapper 按响应顺序输出曲序 `1、2`，结果为 `complete` 且无 issue。
- [x] 缺少独立曲序时使用详情稳定顺序；负数、非整数或非数字仍被拒绝，正整数、跨专辑归属及其他必需字段合同不变。
- [x] 主详情成功与验证拦截后 v1 fallback 两条路径均返回两首完整歌曲，不产生 `invalid_provider_response` 或数量不一致。
- [x] 网易定向测试、Renderer TypeScript、定向 ESLint、专题回归和 Renderer 生产构建通过。
- [x] 真实只读复现不再出现该专辑 `2 → 0`；真实 Electron 页面仍单独验收。

## 当前状态

已完成真实响应诊断、红绿回归与原始场景复验：mapper 仅在 `no=0` 或没有独立曲序字段时使用原始详情位置，其他必需字段和畸形曲序继续严格拒绝。网易 mapper/adapter 41 项、全专题 263 项、Renderer TypeScript、定向 ESLint 和 Renderer 生产构建均通过；真实《梦之光年》主详情成功路径返回 2/2、曲序 `1、2`、无 issue，临时实时测试已删除。状态更新为 `verified`；真实 Electron 页面及安装包仍未验证。
