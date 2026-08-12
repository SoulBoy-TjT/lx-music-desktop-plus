---
id: BUG-20260809-01
type: BUG
title: 网易专辑详情验证拦截缺少 v1 回退并产生级联提示
status: verified
severity: high
created_at: 2026-08-09
updated_at: 2026-08-09
owner: KhalilFong
req_ids:
  - REQ-20260809-01
discovered_in_req_id: REQ-20260809-01
introduced_by_req_id: REQ-20260809-01
---

# 网易专辑详情验证拦截缺少 v1 回退并产生级联提示

## 关联文档

- 来源需求：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 修订方案：[DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](../designs/DEV-20260809-01-four-source-artist-discography-playlists.md)
- 当日进度：[PROG-20260809](../progress/PROG-20260809.md)
- 后续曲序兼容：[BUG-20260810-02 网易专辑曲序 no=0 被严格映射误拒导致漏曲](BUG-20260810-02-wy-zero-track-number.md)

## 发现方式

四平台真实端点复核中发现：网易主专辑详情 `/api/album/{albumId}` 可能以 HTTP 200 返回 Provider 验证拦截 envelope，实测特征包含 `code=-462`、绑定手机提示和 `data.verifyType=50`。该正文不含可映射的专辑详情，修复前 adapter 没有切换备用详情端点。

缺陷位于 `REQ-20260809-01` 新增的网易独立目录 adapter，因此 `introduced_by_req_id` 关联本需求；外部 Provider 触发验证本身不归因于本项目。

## 修复前实际行为

1. `getAlbumTracks` 只请求主 `/api/album/{albumId}`，验证拦截后直接交给专辑 mapper。
2. mapper 将非成功 Provider code 归类为 `invalid_provider_response`，未区分“成功 envelope 结构非法”和“Provider 明确要求验证而暂不可用”。
3. 单来源 plan 随后为同一 `albumId` 派生 `album_incomplete` 和 `empty_catalog`；来源摘要把根因与派生结果逐条展示，用户会看到同一失败的三条重复提示。
4. 若该来源仍有其他合法歌曲，来源会降为 `partial`；若没有合法歌曲，则按现有合同进入 `failed` 并阻断批量创建。

## 期望行为

### 网易详情回退

1. 先请求主 `/api/album/{albumId}`；主响应为合法详情时直接严格映射，不额外请求备用端点。
2. 仅当主请求以 HTTP 200 返回精确的 `code=-462` 且 `data.verifyType=50` 验证拦截 envelope 时，请求 `/api/v1/album/{albumId}` 作为同一专辑的备用详情；不得把两路曲目拼接，也不得跨专辑或跨来源补齐。
3. v1 备用详情按现代结构严格映射：Provider code 必须成功，`album` 与顶层 `songs` 必须存在，canonical `album.id` 必须等于请求的 `albumId`，专辑计数和每首歌曲的稳定 ID、名称、歌手、专辑归属、时长、曲序及音质字段必须满足现有 `MusicInfoOnline` 合同。
4. 备用详情成功时返回该完整结果，不得仅因主端点曾触发验证而把来源降为 `partial`。
5. 主端点返回其他非 200 Provider code，或已触发 fallback 后备用端点返回任意非 200 Provider code，均返回单一、可重试的 `provider_unavailable`；Provider code 为 200 但必需结构或字段非法时仍使用 `invalid_provider_response`，不得伪造字段。
6. 回退复用现有 `AbortSignal`、有限重试和脱敏错误边界；取消后不得继续发起备用请求或重试，不记录响应正文、Cookie 或请求凭据。

### 来源摘要去噪

1. `DiscographyPlan.issues` 保留 adapter 根因及 plan 派生的全部原始 issue，状态判定、重试语义和诊断证据不得因 UI 合并而丢失。
2. 来源摘要只在 issue 能定位到同一个 owner album、`issue.albumId` 等于该 owner 的 albumId，且 owner `actualCount=0` 时识别共同根因。当 `provider_unavailable` 或 `invalid_provider_response` 已解释该空专辑失败时，同 owner、同 albumId 的 `album_incomplete`、`empty_catalog` 不再各显示一条等价提示。
3. 不同专辑、没有稳定 `albumId` 的问题以及没有共同根因的问题不得误合并；合并只影响展示，不改变 `complete/partial/failed`、原始 issue 数组或 apply 阻断规则。

## 影响

- 主详情端点触发验证时会静默漏掉该专辑全部歌曲，来源完整性下降。
- 验证拦截被描述为“响应格式非法”，错误语义不准确，不利于用户判断是否重试。
- 同一专辑的根因与两个派生结果重复展示，放大告警噪声并掩盖真正需要处理的 Provider 可用性问题。

## 修复约束

1. 回退只能位于网易 `ArtistCatalogPort` adapter 内，core 和 UI 不直接认识 Provider URL 或 `-462`。
2. 备用响应必须经过纯 mapper 严格校验；不能因为主端点失败而降低字段、专辑归属或歌曲合法性要求。
3. 只有明确验证拦截才触发备用请求；主端点合法成功时不得双请求。
4. 来源摘要合并必须是可测试的纯展示变换，底层 issues 保持完整。
5. 使用脱敏固定样例覆盖真实 envelope 差异，默认测试不得依赖实时网易接口。

## 验证标准

- [x] 主 `/api/album` 返回合法详情时只请求主端点并保持既有映射结果。
- [x] 主 `/api/album` 返回 HTTP 200/body 精确 `code=-462`、`data.verifyType=50` 时调用 v1 备用详情，严格映射顶层 `songs` 现代结构。
- [x] v1 成功后来源不因已恢复的主端点验证拦截而降为 `partial`。
- [x] 主端点其他非 200 Provider code、fallback 任意非 200 Provider code 均返回单一、可重试的 `provider_unavailable`；code 200 结构非法仍返回 `invalid_provider_response`。
- [x] 备用详情的 albumId 归属、必需歌曲字段、曲序、音质和重复歌曲处理均通过脱敏 fixture 合同测试。
- [x] 取消、有限重试和“不在主成功时调用备用端点”均有回归测试。
- [x] 仅同一 owner albumId 且 `actualCount=0` 时折叠 `album_incomplete`、`empty_catalog` 派生展示；底层 issue 集合、状态和 apply 阻断结果保持不变。
- [x] 网易 adapter、来源摘要专题测试、Renderer 类型检查、定向 ESLint 和 Renderer 构建通过。

## 修复与验证记录

- 网易 adapter 只对精确 `code=-462`、`data.verifyType=50` 启用 `/api/v1/album/{albumId}` fallback；主端点其他非 200 code 和 fallback 任意非 200 code 归一为单一 `provider_unavailable`，code 200 malformed 继续交由严格 mapper 返回 `invalid_provider_response`。
- v1 mapper 强制使用现代根级 `songs`，并严格校验 albumId、专辑元数据、歌曲稳定 ID、名称、歌手、归属、时长、曲序和音质字段；主成功单调用、legacy body 拒绝、必需字段缺失、取消和重试边界均有负向回归。
- `preview.ts` 只在根因和派生 issue 属于同一 owner albumId 且该 owner `actualCount=0` 时隐藏派生行；`DiscographyPlan.issues`、来源状态和 apply 规则不变。
- 定向 Vitest：5 个测试文件、59 项测试全部通过；`npm run test:artist-discography`：37 个测试文件、226 项测试全部通过。
- Renderer TypeScript、定向 ESLint、`npm run build:renderer` 和任务范围 diff check 均通过。
- 真实接口只读复核：《渡》（albumId `36855053`）连续 10 次均为声明 10 首、实际 10 首，其中主端点 7 次返回 `-462` 并成功 fallback，3 次主端点直接返回 code 200。
- 截图所列 9 张专辑全部满足声明数=实际数：顽疾 1/1、湖泊 1/1、金斧子银斧子 1/1、无数 10/10、为了遇见你 1/1、渡 10/10、来日方长 1/1、绅士 3/3、方圆几里 2/2；其中 5 张主端点返回 `-462` 并成功走 v1 fallback。

## 验证边界

本 BUG 的 adapter、mapper、来源摘要和真实 Provider 恢复路径已有自动化与只读实时证据，状态更新为 `verified`。尚未执行真实 Electron 点击、安装态验证、Main 全量 TypeScript 或全量 lint；这些属于 `REQ-20260809-01` 的整体交付边界，不阻止本 BUG 的定向验证收口。
