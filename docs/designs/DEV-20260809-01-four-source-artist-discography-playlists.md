---
id: DEV-20260809-01
type: DEV
title: 四平台歌手专辑抓取与批量写入技术方案
status: implemented
created_at: 2026-08-09
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260809-01
biz_ids:
  - BIZ-20260805-01
  - BIZ-20260809-02
  - BIZ-20260809-03
  - BIZ-20260809-04
  - BIZ-20260809-05
  - BIZ-20260810-01
  - BIZ-20260810-02
bug_ids:
  - BUG-20260805-02
  - BUG-20260805-03
  - BUG-20260809-01
  - BUG-20260810-01
  - BUG-20260810-02
  - BUG-20260810-03
  - BUG-20260811-01
supersedes: []
---

# 四平台歌手专辑抓取与批量写入技术方案

## 关联文档

- 需求：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 前置需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 业务决策：[BIZ-20260809-03 四平台抓取与来源歌单批量写入策略](../decisions/BIZ-20260809-03-four-source-discography-playlist-strategy.md)
- 业务决策修订：[BIZ-20260809-04 专辑抓取采用来源摘要与结构化去重审计](../decisions/BIZ-20260809-04-album-summary-and-dedup-audit.md)
- 业务决策修订：[BIZ-20260809-05 部分结果直接写入与去重核查字段精简](../decisions/BIZ-20260809-05-partial-direct-apply-and-dedup-summary.md)
- 业务决策修订：[BIZ-20260810-01 来源歌单名称包含最终歌曲数量](../decisions/BIZ-20260810-01-playlist-name-with-track-count.md)
- 业务决策修订：[BIZ-20260810-02 来源子集选择与歌手别名身份确认](../decisions/BIZ-20260810-02-source-subset-and-artist-alias-confirmation.md)
- 输入交互背景：[BIZ-20260809-02 工具页面采用歌手名称输入、可选来源目录与独立图标](../decisions/BIZ-20260809-02-tool-input-directory-and-icons.md)
- 既有技术方案：[DEV-20260805-01 歌手专辑目录组装技术方案](DEV-20260805-01-artist-discography-playlist.md)
- 关联缺陷（状态由各 BUG 文档独立维护）：
  - [BUG-20260805-02 网易云歌手 adapter 分页与音质错误](../bugs/BUG-20260805-02-wy-singer-adapter.md)
  - [BUG-20260805-03 QQ 音乐歌手 adapter 响应与分页错误](../bugs/BUG-20260805-03-tx-singer-adapter.md)
  - [BUG-20260809-01 网易专辑详情验证拦截缺少 v1 回退并产生级联提示](../bugs/BUG-20260809-01-wy-album-verification-fallback.md)
  - [BUG-20260810-01 网易歌手全局完全同名优先遮蔽正确别名结果](../bugs/BUG-20260810-01-wy-artist-alias-candidate.md)
  - [BUG-20260810-02 网易专辑曲序 no=0 被严格映射误拒导致漏曲](../bugs/BUG-20260810-02-wy-zero-track-number.md)
  - [BUG-20260811-01 酷我整专辑零基曲序被严格映射误拒并导致曲序错位](../bugs/BUG-20260811-01-kw-zero-based-track-number.md)

## 状态与前置条件

`BIZ-20260809-04`、`BIZ-20260809-05`、`BIZ-20260810-01` 对应范围及 `BUG-20260809-01` 修订均已实现并取得专题自动化证据。用户于 2026-08-10 接受 `BIZ-20260810-02` 后已完成网易严格双脚本名称段与 Provider 稳定顺序、来源身份 all-settled、抓取/生成两组来源选择和动态子集 apply。2026-08-11 确认并修复 `BUG-20260811-01`：酷我《醇情歌》返回完整零基曲序 `0..18` 时，mapper 现在按完整原始序列整体规范化为 `1..19`。固定回归、真实只读复现、生产构建和安装包静态核对均已完成，本 DEV 收口为 `implemented`；真实 Electron 与安装态仍单独验收。

当前实现基线：

1. `kg/tx/wy/kw` 均通过独立 `ArtistCatalogPort` adapter 提供名称完全匹配、完整专辑分页和逐专辑详情分页。
2. 四来源协调集中在 `src/renderer/core/artistDiscography/batch.ts`，公开 interface 为 `plan/apply`。
3. 页面通过同一批次完成四身份确认、四份来源摘要和批量创建；非空 `partial` 无需额外接受，不再展示逐专辑明细、专辑选择或 partial consent 控件。
4. 批量写入在任何来源失败时逆序补偿本批次已创建歌单，并报告无法删除的残留。
5. `BUG-20260805-02/03` 继续作为关联缺陷追踪；本 DEV 只记录对应 adapter 实现与合同测试证据，不代替 BUG 文档的独立状态流转。
6. `AlbumCollection` route 已启用 `keepAlive`；抓取完成后切换路由再返回复用同一页面实例，不重新抓取。
7. 网易专辑详情已完成精确验证拦截识别、v1 fallback、严格 mapper、单一不可用根因和来源摘要派生提示折叠。

`BIZ-20260810-02` 的新增目标状态：

1. `plan.sources` 接收默认由 UI 全选、但可为一至四项的抓取来源，只调用所选 adapter。
2. 所选来源身份解析并行且等待全部 settled：失败来源保留 `failed`，只把成功身份非空子集交给一次统一确认；网易按 Provider 原始顺序返回首个 `exact/alias_exact` 身份，零个成功身份不弹确认。
3. `DiscographyBatchPlan.sources/plans/canApply` 保存所选来源、每来源结果及“至少一个来源可生成”状态；UI 在抓取结束后默认全选逐来源合格项，可改为任意非空生成子集。
4. `apply.sources` 只创建并补偿生成子集，同时复核其属于当前批次、状态合格、歌曲非空；零来源和越界来源在写入前阻断。
5. `fetchSourceSelection`、`generateSourceSelection` 与既有批次状态一起由页面级 `KeepAlive` 保留；重新抓取替换批次并重置生成选择。

`BIZ-20260809-04` 的既有实现结果：

1. 来源卡只展示歌手身份、状态、计数和来源级完整性说明，不渲染逐专辑明细或选择控件。
2. batch apply 自动使用每个来源全部合法专辑，不接受用户选择的专辑子集。
3. `assembly.ts` 为最终歌单稳定 `track.id` 去重生成精确核查；Provider/专辑内早期重复由 `preview.ts` 根据 issue 标识符和保留快照生成 `exact: false` 的 identifier-only 回退，无去重不展示。
4. 精确核查包含双方歌曲、歌手、song ID、专辑、曲序与位置并可复制；早期回退明确原始副本不可恢复，不伪造缺失字段，也不进行跨来源比较。

`BIZ-20260809-05` 的实现结果：

1. 删除 UI 中逐来源 partial consent 控件、授权状态和跨路由缓存字段。
2. 删除 batch apply 的 `allowIncompleteBySource` 输入；非空 `complete/partial` 直接允许写入，`failed/cancelled/0 首` 继续阻断。
3. 去重核查只展示平台、类型、歌曲/歌手、单一稳定 ID 或 Provider ID，以及保留/移除专辑名、albumId、曲序。
4. UI 与复制文本移除快照位置、重复 Provider ID 和单独的首次出现原因；内部 assembly 可继续保留位置以维持确定性算法。
5. 早期 duplicate 继续明确 `exact: false` 和缺失边界，不为满足精简卡伪造字段。

本次缺陷修订实现结果：

1. 网易主详情仅在精确 `code=-462`、`data.verifyType=50` 时，于同一 adapter 内切换 `/api/v1/album/{albumId}`，严格映射现代 `album` + 根级 `songs` 结构。
2. 主端点正常成功时不调用备用端点；备用成功不产生仅由主端点拦截引起的 `partial`。
3. 主端点其他非 200 Provider code 或 fallback 任意非 200 Provider code 返回单一、可重试的 `provider_unavailable`；code 200 malformed 继续使用 `invalid_provider_response`。
4. `preview.ts` 只在同一 owner albumId 且 owner `actualCount=0` 时折叠根因后的 `album_incomplete/empty_catalog` 展示，单来源 plan 的完整 issues 和状态计算保持不变。

## 实现基线

`DEV-20260805-01` 的单来源 `plan/apply`、`ArtistCatalogPort` 和 `PlaylistPort` 继续作为原子能力；本次在其上完成四来源扩展：

- `DiscographyPlan.source` 已泛化为 `kg/tx/wy/kw`。
- 四个生产 adapter 均已接入，并各自保留脱敏 fixture、纯 mapper 和合同测试。
- 单来源 `plan/apply` 未被复制；`batch.ts` 负责四来源计划协调、批次校验、确定性写入和补偿。
- `Tools` 页面已表达统一确认、四份来源摘要、来源级问题、精简去重核查和整批写入结果；非空 `partial` 直接可写，不提供 partial consent、逐专辑明细或选择。
- `AlbumCollection` route 使用现有页面级 `KeepAlive` seam，在当前应用会话内保留页面实例和批次 module。
- 自动化验证证明了离线合同与核心状态转换；外部 Provider 实时变化仍属于运行期风险。

## 设计原则

1. 保持“单来源目录计划”为深模块原子能力，在其上增加四来源协调层，不把 Provider 分支堆入 UI。
2. 已选来源计划共享一次输入和批次生命周期，但不共享来源身份、专辑、歌曲或完整性判定；未选来源保持零调用。
3. adapter 隐藏 Provider 请求、字段、页码、限流和重试；协调层只处理来源级状态和批次规则。
4. 来源歌单子集写入集中在批量 apply 内管理批次边界和补偿，页面不直接串联多次 store action。
5. 默认测试完全离线；实时 Provider 只作为显式冒烟，不替代固定样例。
6. 最终 assembly 在去重当下保存精确保留/移除上下文；adapter 早期去重继续沿用 issue 合同，预览只用仍可得的标识符和保留快照生成明确非精确的回退，不反推已丢失原始副本。

## module 结构

在既有 `src/renderer/core/artistDiscography/` 内扩展通用来源类型和批次协调，不新建第二套目录组装逻辑：

```text
src/renderer/core/artistDiscography/
├─ index.ts
├─ types.ts
├─ plan.ts                 # 单来源计划，泛化 source
├─ apply.ts                # 单来源扁平化内部能力；batch 传入全部合法专辑
├─ batch.ts                # 四来源 plan/apply、写入和补偿
├─ module.ts               # 单来源 module 组装
└─ adapters/
   └─ playlist.ts          # 本地歌单 store 的 PlaylistPort adapter
```

Provider 实现继续位于各自 music SDK 目录，向核心 module 暴露相同合同，不互相导入：

```text
src/renderer/utils/musicSdk/kg/artistDiscography.ts
src/renderer/utils/musicSdk/tx/artistDiscography.ts
src/renderer/utils/musicSdk/wy/artistDiscography.ts
src/renderer/utils/musicSdk/kw/artistDiscography.ts
```

## 类型与外部 interface

### 来源与展示元数据

```ts
type ArtistDiscographySource = 'kg' | 'tx' | 'wy' | 'kw'

const ARTIST_DISCOGRAPHY_SOURCES = ['kg', 'tx', 'wy', 'kw'] as const

const ARTIST_DISCOGRAPHY_PLAYLIST_SUFFIXES: Readonly<Record<ArtistDiscographySource, string>> = {
  kg: '酷狗',
  tx: 'qq',
  wy: '网易',
  kw: '酷我',
}

type WyArtistNameMatchType = 'exact' | 'alias_exact'
```

来源顺序、用户文案和内部 ID 只能在一个元数据映射中维护，不在页面和 apply 中分别硬编码。

网易展示名匹配由 `artistDiscographyMapper.ts` 中可离线测试的纯函数完成：

1. 输入和 Provider 名称段先 `trim`、执行 Unicode `NFKC`、折叠连续空白，拉丁字母比较忽略大小写。
2. 完整展示名规范化后相等，标记为 `exact`。
3. 仅当输入和 Provider 名称中恰有一方完整匹配“连续汉字段 + 拉丁字母段”或相反顺序，另一方与完整汉字段或完整拉丁段相等时标记为 `alias_exact`；拉丁段至少两个字母，可含单词间空白。
4. 例如“刘雨昕XIN LIU”拆得“刘雨昕”和“XIN LIU”；“刘雨昕”命中，“刘雨”不命中。
5. 不使用任意 `includes`、未闭合前后缀、编辑距离、拼音、专辑数或头像相似度。mapper 按来源内 `artist.id` 去重时保留 Provider 首次出现顺序；adapter 以一次 `.find(artist => classify(...) != null)` 选择原始稳定顺序中的首个 `exact/alias_exact`，不得用 `find(exact) ?? find(alias_exact)` 全局优先完全同名类型。

### 去重核查合同

```ts
interface DiscographyTrackOccurrence {
  source: ArtistDiscographySource
  trackId: string
  providerSongId: string | number
  trackName: string
  singer: string
  albumId: string
  albumName: string
  albumArtist: string
  albumPosition: number
  trackPosition: number
  occurrencePosition: number
  trackNumber: number | null
}

interface DiscographyTrackDeduplication {
  kind: 'duplicate_track'
  scope: 'source_assembly'
  stableId: string
  kept: DiscographyTrackOccurrence
  removed: DiscographyTrackOccurrence
  reason: 'first_occurrence'
}
```

`src/renderer/core/artistDiscography/assembly.ts` 按合法专辑及曲目的稳定遍历顺序组装来源歌曲，以 `track.id` 为键保留首次出现项，并为每个被移除项生成 `DiscographyTrackDeduplication`。`DiscographyPlan.deduplications` 保存精确结果；plan 和 apply 都调用 `assembleDiscographyTracks`，确保预览与实际写入使用同一首次出现规则。记录只属于单一 `source`，协调层不得建立跨来源核查记录。

上述 occurrence 中的 `albumPosition/trackPosition/occurrencePosition` 继续作为内部确定性上下文，但 `BIZ-20260809-05` 禁止 UI 和复制文本展示这些位置。`preview.ts` 应映射为精简视图：平台、去重类型、歌曲/歌手、一个稳定 ID 或 Provider ID，以及保留/移除项各自的专辑名称、albumId、曲序；稳定 ID 可用时不再并列 Provider song ID，也不在双方重复同一 Provider ID。

Provider 专辑分页或专辑详情内的早期重复不扩展 `CatalogCollection`，也不要求 adapter 保存已经丢弃的原始副本。adapter 继续通过 `duplicate_album/duplicate_track` issue 提供稳定 ID、`albumId/relatedAlbumId/trackId` 等现有标识；`src/renderer/views/Tools/preview.ts` 将这些标识与计划中保留快照组合为 identifier-only 回退，统一标记 `exact: false`。回退只展示当前可得值，并明确原始被移除副本及其精确位置不可恢复。

### 来源子集计划入口

```ts
interface ArtistDiscographyBatchModule {
  plan(input: {
    artistName: string
    sources: readonly ArtistDiscographySource[]
    signal?: AbortSignal
    onProgress?: (progress: DiscographyBatchPlanProgress) => void
    confirmArtists?: (artists: ArtistRef[]) => boolean | Promise<boolean>
  }): Promise<DiscographyBatchPlan>

  apply(input: {
    plan: DiscographyBatchPlan
    sources: readonly ArtistDiscographySource[]
  }): Promise<DiscographyBatchApplyResult>
}
```

约束：

- `plan` 只读，不创建歌单或下载任务。
- `artistName` 去除首尾空白后写入批次计划；空名称在发起 Provider 请求前拒绝。
- `plan.sources` 表达业务上的 `requestedSources`；core 用 `ARTIST_DISCOGRAPHY_SOURCES` 过滤并按全局稳定顺序去重，归一后零项在发起 Provider 请求前拒绝，未选 adapter 不调用。
- 所选来源身份解析全部 settled 后，`confirmArtists` 只在成功身份非空时调用一次，参数按稳定来源顺序包含每个成功来源已解析的一个 `ArtistRef`；回调返回 `false`、抛错或取消时不得开始任何专辑分页，零个成功身份时不得调用。
- `apply.sources` 表达业务上的 `playlistSources`，只允许为这些来源创建新歌单，不提供写入已有歌单的目标类型；该数组必须是当前批次已抓取且合格来源的去重非空子集。
- batch `apply` 不接收用户专辑选择，也不向 `prepareArtistDiscographyApply` 传 `albumIds`；单来源内部能力因此按默认规则使用计划中的全部合法专辑。
- batch apply 不接收 `allowIncompleteBySource`、`acceptedPartialSources` 或等价授权输入；来源是否可写由计划状态、最终歌曲集合和显式 `apply.sources` 共同决定。
- UI 与 core 共用以 `{ artistName, source, trackCount }` 为输入的纯目标名称生成规则；同名检查和确认在 UI 调用 `apply` 前完成，核心以 apply 时重新组装的实际提交数组长度复核并生成同一名称。
- 核心只为 `apply.sources` 预生成新的歌单 ID，不提供覆盖已有歌单的路径；名称中的数量不得信任 UI 缓存或 Provider 声明数。
- 下载不进入该 interface。

### 批次计划结果

```ts
interface DiscographyBatchPlan {
  batchId: string
  artistName: string
  sources: ArtistDiscographySource[]
  status: 'ready' | 'blocked' | 'cancelled'
  plans: Partial<Record<ArtistDiscographySource, DiscographyPlan>>
  fetchedAt: number
  canApply: boolean
}
```

`sources` 保存稳定排序后的抓取来源选择。`plans` 的 key 必须与 `sources` 完全一致：身份解析成功并确认的来源保存真实目录计划，身份解析失败或无匹配的来源保存带根因的 `failed` 计划；未选来源禁止填充假的 `failed` 或空计划。`DiscographyPlan.source` 的专辑、曲目、计数、问题、`deduplications` 和 `complete/partial/failed/cancelled` 语义保持来源独立。协调层不创建跨来源 `tracks` 扁平集合，避免误用为合并歌单。

`canApply` 只表示当前批次至少存在一个可生成来源，不表示所有 `sources` 都合格。UI 逐来源使用同一客观条件生成默认选择：

1. 属于 `plan.sources`，且已完成身份确认和目录计划。
2. 状态为 `complete` 或 `partial`。
3. 计划有合法歌手、至少一张合法专辑，并在最终来源内去重后至少一首歌曲。

`failed`、`cancelled` 或 0 首来源不进入默认生成选择，但不使其他合格来源失去资格。`status` 继续描述完整抓取来源集合：所有请求来源均为 `complete/partial` 时为 `ready`，存在 `failed` 或缺项时为 `blocked`，共享取消为 `cancelled`。`canApply` 独立表示至少一个来源可生成，因此允许出现 `status='blocked'` 且 `canApply=true`；UI 和 core 此时仍可对合格非空 `apply.sources` 创建歌单。全部来源不合格时 `canApply=false`。

UI 的实际可创建状态由 `plan.canApply`、`apply.sources` 非空且每个来源满足上述条件共同推导。`apply` 使用计划内容再次验证每个选中来源全部合法专辑均产生非空歌曲；状态为 `partial` 不再要求授权。计划和 UI 均不存在 `acceptedPartialSources`、`allowIncompleteBySource` 或用户专辑选择。

## adapter registry

```ts
type ArtistCatalogRegistry = Record<ArtistDiscographySource, ArtistCatalogPort>
```

`ArtistCatalogPort` 继续隐藏来源差异，并返回单个待统一确认的来源身份：

```ts
interface ArtistCatalogPort {
  resolveArtist(ref: string, signal?: AbortSignal): Promise<ArtistRef>
  getArtistAlbums(artistId: string, signal?: AbortSignal): Promise<CatalogCollection<AlbumRef>>
  getArtistTracks?(artistId: string, signal?: AbortSignal): Promise<CatalogCollection<LX.Music.MusicInfoOnline>>
  getAlbumTracks(albumId: string, signal?: AbortSignal): Promise<CatalogCollection<LX.Music.MusicInfoOnline>>
}
```

每个 adapter 必须：

- 只返回来源内 canonical ID 对应的严格身份，不返回任意模糊匹配。
- 网易按 Provider 原始稳定顺序选择首个 `exact/alias_exact`，搜索响应内同一 Provider ID 只保留首次出现项；组合展示名的别名段由 mapper 纯函数识别，UI 不自行 `includes`，也不新增候选选择控件。
- 统一分页语义，按 Provider `total/limit` 或明确无下一页条件终止。
- 防止重复页、异常空页、total 漂移和无限循环。
- 逐专辑取得完整详情并映射为合法 `MusicInfoOnline`。
- 使用本来源专辑 ID 校验归属；缺少稳定字段时报告非法响应，不猜测或跨来源补齐。
- 酷我专辑封面仅在 URL 主机可信且路径精确匹配 `/star/albumcover/240/` 时升级尺寸段到 `500`；该规则位于纯 mapper，不在通用下载器中添加来源特判。
- 通过既有 `duplicate_album/duplicate_track` issue 报告早期重复及当前可保留的稳定标识符；无需扩展 `CatalogCollection` 或保存被丢弃原始副本。
- 处理超时、失败、空数据、非法响应、有限重试、限流和取消。

QQ 和网易 adapter 的实现必须在新的隔离目录 adapter 内修复 `BUG-20260805-03` 与 `BUG-20260805-02`，不能只修改未接入的 legacy 歌手方法后宣称完成。酷我必须提供与其他来源等价的逐专辑详情证据。

网易 `getAlbumTracks` 增加以下专用决策序列，Provider 分支不得泄漏到 core 或 UI：

1. 请求主 `/api/album/{albumId}`；合法 legacy 或现代详情直接交给纯 mapper，结束本次调用。
2. 仅当 HTTP 200 正文精确满足 `code=-462`、`data.verifyType=50` 时，请求 `/api/v1/album/{albumId}`。主端点其他非 200 Provider code 不触发 fallback，直接返回单一不可用根因。
3. v1 响应必须满足 code 200、`album` 对象、根级 `songs` 数组、canonical albumId 一致和必需歌曲字段完整；歌曲只取备用响应，不与主响应拼接。
4. legacy 与 v1 曲目的正整数 `no` 原样保留；`no=0` 或没有独立曲序字段时，使用各自详情歌曲数组的原始稳定位置补一基曲序。负数、非整数和非数字仍为非法响应，歌曲 ID、名称、艺人、canonical albumId、专辑名与时长校验不变。
5. v1 成功则返回正常 `CatalogCollection`，不保留会单独导致来源降级的主端点拦截 issue。
6. 主端点其他非 200 Provider code、fallback 任意非 200 Provider code 或请求异常均返回单一可重试 `provider_unavailable` 根因；任一路 code 200 但结构非法时返回 `invalid_provider_response`。
7. 两次请求共享 `AbortSignal`；主响应处理后若已取消，不得发起备用请求，备用重试同样受有限重试上限约束。

## plan 算法

1. 规范化并固定 `artistName`，用 `normalizeSources` 将 `plan.sources` 去重并按 `kg -> tx -> wy -> kw` 排序；归一后来源为空时在请求前返回校验失败。随后生成唯一 `batchId`，并使用调用方传入的共享 `AbortSignal`。
2. 只并行启动 `plan.sources` 对应单来源 `plan`；每个计划先调用既有 `resolveArtist`，批次协调通过 `arrived + waiters` 等待全部来源抵达身份确认 seam 或提前失败。未选 adapter 调用次数必须为零，且不传入或复用来源 ID、链接。
3. 每个无严格身份匹配、请求失败或返回非法身份的来源生成带根因的 `failed` 计划；成功 `ArtistRef` 暂存在 waiter。单个失败只标记该来源 arrived，不得提前结束其他身份请求，也不得阻断成功子集。
4. 全部来源 arrived 后，如果 waiter 为空，直接返回 `blocked`，不得调用 `confirmArtists` 或任何专辑接口；非空时按固定来源顺序把 `ArtistRef[]` 传给一次 `confirmArtists`。回调返回 `false`、抛错或共享信号取消时，所有等待中的成功来源都不开始专辑请求。
5. 用户确认后释放成功来源 waiter 并继续这些单来源计划；第 3 步的身份失败计划原样保留在 `plans` 中。
6. 单来源内部沿用既有流程：专辑分页顺序获取，逐专辑详情最大并发 3，详情曲目成稿，来源内校验和去重；早期 duplicate 继续记录 issue 标识符。
7. `assembly.ts` 按合法专辑的稳定遍历顺序汇总歌曲，以稳定 `track.id` 保留首次出现项，并为每个移除项生成精确 `source_assembly` 核查记录。
8. 将逐专辑异常聚合为来源级完整性说明，汇总已抓取来源状态，但不生成跨来源专辑或歌曲集合。
9. 根据每个请求来源的状态、合法歌手、全部合法专辑和最终歌曲是否非空计算逐来源 `plan.canApply`；batch `canApply` 为其中任一项为真。非空 `partial` 直接合格，身份解析失败、目录 `failed/cancelled/0 首` 只排除该来源。batch `status` 仍按全部请求来源汇总，因此单个 `failed` 可使 `status='blocked'`，但只要 `canApply=true`，生成子集仍可写入。

并发边界：

- `plan.sources` 中的来源计划允许同时进行，未选来源保持零调用。
- 每个来源的歌手专辑分页保持顺序请求。
- 每个来源的专辑详情并发默认最大为 3；adapter 可因 Provider 限流使用更低上限，但不得提高到无界。
- 有限重试在各 adapter 内独立计数；共享取消优先于等待中的重试。

## 取消与重试

- 页面只暴露整批取消。取消触发共享 signal，并由本批次已选 adapter 停止新分页、重试和专辑详情请求。
- 已完成的来源结果可留在界面用于说明，但整个批次状态为 `cancelled`，不能写入。
- 页面只暴露整批重试。重试读取当时的抓取来源选择，创建新的 `batchId`，丢弃旧计划、来源摘要、生成来源选择、去重核查、apply 结果和进度；不存在 partial consent 状态。
- 旧批次迟到的进度或结果不得覆盖新批次状态。

## 路由会话保留

`src/renderer/router.ts` 为 `AlbumCollection` 设置 `meta.keepAlive: true`，复用 `src/renderer/components/layout/View.vue` 现有的页面级 `KeepAlive` 容器。抓取完成后离开页面再返回时不重新执行 `Tools` 页面的 `setup`，因此同一组件实例内的以下状态继续有效：

- 输入名称、抓取前 `fetchSourceSelection`、`DiscographyBatchPlan.sources` 及其同一 `batchId`。
- 已抓取来源快照及其来源摘要、来源级完整性说明和精简去重核查。
- 抓取后 `generateSourceSelection`；切换该选择不请求 Provider，也不修改快照。
- apply 结果、创建成功的歌单 ID 或失败残留信息。
- `createArtistDiscographyBatchModule` 实例及其 `activeBatchId`，确保返回后仍可对原计划执行 apply。

重新激活页面不得主动调用 Provider。只有用户显式执行“获取并预览”时，`handlePlan` 才按当前 `selectedFetchSources` 创建新批次并清空旧来源摘要、去重核查和 apply 结果；新计划完成后，`createDiscographyGenerateSelection` 根据逐来源 `canGenerateDiscographyPlaylist` 把 `generateSourceSelection` 初始化为全部合格来源。该状态不进入 store 持久化、磁盘或数据库；刷新或重启会销毁页面实例，从空快照、抓取来源四项默认全选开始。

`Tools` 页面通过 `onDeactivated` 处理未完成任务：仅当 `isPlanning` 为 `true` 时调用 `handleCancel`，统一结束等待中的身份确认并中止共享 `AbortController`。因此切页期间不会在后台继续身份确认、专辑分页或详情请求；已经完成的 `batchPlan`、两组来源选择、来源摘要、精简去重核查和 apply 结果不受该取消钩子影响，继续由 `KeepAlive` 缓存。

## apply 与尽力补偿

### 写入前验证

1. 重新验证计划属于当前 `batchId`，先校验 `apply.sources` 无重复，再按稳定来源顺序归一；零项、未知来源、未抓取来源或重复输入立即返回 `validation_failed`。
2. 每个选中来源必须满足 `canGenerateDiscographyPlaylist` 的同等核心条件，状态为 `complete/partial` 且 `plan.canApply=true`；不读取任何不完整结果授权。未选来源即使 `failed/cancelled/0 首` 也不进入 apply 校验。
3. 验证每个选中来源的全部合法 albumId 属于本来源快照，并分别按稳定 `track.id` 生成非空歌曲集合；不接受专辑子集，选中来源 0 首即阻断。
4. 对每个选中来源取得最终去重后的实际提交歌曲数组长度 `N`，由 `artistName`、来源展示名和 `N` 生成无空格目标名称“`<artistName>-<platform>-<N>首`”。
5. UI 只查询选中目标的同名本地歌单并统一提示；取消时不调用 `apply`，确认时核心仍只创建新 ID。

### 确定性写入与补偿

为降低并发写入和补偿竞态，歌单按固定顺序 `kg -> tx -> wy -> kw` 过滤 `apply.sources` 后写入；抓取并行不要求持久化也并行。

1. 只为 `apply.sources` 预生成唯一歌单 ID，并记录 `{ source, id, name, created, tracksAdded }`；`name` 中的数量等于该来源随后提交的歌曲数组长度。
2. 依次创建选中来源新歌单并添加该来源全部合法专辑经稳定 `track.id` 去重后的歌曲；未选来源不调用创建或加歌 action。
3. 任一阶段失败，停止后续写入，并按创建顺序的逆序删除本批次所有 `created` 歌单。
4. 所有删除成功时返回 `failed_rolled_back`，且 `residualPlaylists` 为空。
5. 任一删除失败时继续尝试其余删除，最终返回 `failed_with_residuals` 及完整残留 `{ source, id, name }[]`。
6. 只有选中生成子集全部创建且加歌成功时返回 `applied`。

补偿只能使用本次预生成并成功创建的 ID，不按名称删除，也不触碰批次前既有歌单。

## UI 状态与交互

页面状态：

```text
idle
 -> resolving_selected
 -> confirming_selected
 -> planning_selected
 -> ready | blocked | cancelled
 -> applying_selected
 -> saved_selected | apply_failed_rolled_back | apply_failed_with_residuals
```

界面必须提供：

- 一个歌手名称输入、默认全选的酷狗/QQ/网易/酷我抓取来源复选组和一个“获取并预览”操作；抓取来源为零时禁用操作并显示原因。
- 身份解析等待全部所选来源 settled；成功身份子集非空时才显示一次确认界面，失败来源留在进度/摘要中但不进入确认。每个已解析身份展示 Provider 完整名称、头像、ID 和可用声明专辑数，用户只能统一确认或取消，不新增候选选择控件；成功身份为零时不显示空确认框。
- 已抓取平台并列或分区的来源摘要：进度、歌手身份、合法专辑数、最终歌曲数、完整性和来源级异常；不渲染逐专辑行、专辑详情或专辑选择控件，未选抓取来源不显示空卡。
- 不显示 partial consent 控件；非空 `partial` 直接允许进入批量创建，完整性说明仍保持可见。
- 仅在实际去重时展示精简核查卡：每条展示平台、去重类型、歌曲/歌手、一个稳定 ID 或 Provider ID、保留/移除专辑名、albumId、曲序。早期记录继续标明非精确边界；不展示快照位置、重复 Provider ID 或单独的首次出现原因。
- 整批取消、按当前抓取来源选择重新获取，以及一个生成来源复选组；生成来源由 `createDiscographyGenerateSelection` 初始默认全选逐来源合格项，失败/取消/0 首来源禁用并显示原因。
- 一次“新建选中歌单”操作；生成来源为零时禁用，切换生成来源不触发 Provider 请求。
- 写入前只展示选中来源的目标名称、合法专辑数、最终歌曲数和同名提示；目标名称中的数量与对应最终歌曲数一致。
- 批量失败时的失败阶段、补偿结果和残留歌单名称/ID。
- 抓取完成后切换其他路由再返回，恢复同一批次、两组来源选择和全部已展示状态且不自动发起 Provider 请求。

远端文本继续使用普通文本绑定，不使用 `v-html`。四个平台的进度和错误不合并成不可定位的单一提示。无任何去重记录的来源不渲染空核查卡；复制内容只包含精简可见字段，使用稳定标签和普通文本，不包含隐藏位置、重复 Provider ID、Cookie、请求体或用户源。

## 错误模型

批次层复用 `DiscographyIssueCode`，不再定义第二套批次错误码。与本流程直接相关的稳定错误码包括：

- `invalid_artist_ref`、`artist_not_found`、`provider_unavailable`、`invalid_provider_response`
- `invalid_source_selection`、`invalid_artist_selection`
- `pagination_inconsistent`、`album_incomplete`、`empty_catalog`、`cancelled`
- `duplicate_album`、`duplicate_track`、`invalid_album_selection`、`invalid_playlist_target`
- `playlist_create_failed`、`playlist_add_failed`、`playlist_rollback_failed`

批量 apply 的结果状态为 `applied`、`validation_failed`、`failed_rolled_back` 或 `failed_with_residuals`。

批次错误必须携带可公开的 `source`、阶段和脱敏 ID；不得暴露 Cookie、请求正文、用户源或其他凭据。

`duplicate_album` 和 `duplicate_track` 继续参与来源完整性统计。`assembly` 阶段的重复必须同时产生精确 `DiscographyTrackDeduplication`；更早阶段只保证 issue 标识符，`preview.ts` 生成 `exact: false` 回退并明确其信息边界。早期字段不可得不等于 adapter 失败，也不得用虚构值补齐。

网易精确 HTTP 200/body `code=-462`、`data.verifyType=50` 属于 Provider 当前要求验证，不是“成功详情字段格式非法”。fallback 恢复成功时不生成失败 issue；主端点其他非 200 code、fallback 任意非 200 code 或请求异常使用单一可重试 `provider_unavailable`。只有 Provider code 200 但 albumId、专辑元数据、根级歌曲数组或必需歌曲字段不符合合同时，才使用 `invalid_provider_response`。

网易曲目单独出现 `no=0` 或没有独立曲序字段不属于响应非法；完整详情数组位置提供确定性回退。畸形曲序和其他必需字段错误仍使用 `invalid_provider_response`。

来源摘要增加纯展示归并：先把 issue 定位到唯一 owner album，仅当根因 issue 的 `albumId` 等于 owner albumId 且 owner `actualCount=0` 时，隐藏同一 owner、同一 albumId 的 `album_incomplete`、`empty_catalog` 派生行。owner 不同、albumId 不同、albumId 缺失或仍有有效歌曲的 issue 保持独立；`DiscographyPlan.issues` 不修改，plan/apply 仍使用完整集合和既有状态规则。

## 测试方案

### 单来源 adapter 合同

四个平台分别使用脱敏固定响应验证：

- 中文名、拉丁名、完整展示名、汉字/拉丁双脚本完整名称段、严格匹配结果稳定顺序、模糊结果拒绝和空结果。
- 网易固定样例按 Provider 顺序同时包含“刘雨昕XIN LIU”在前、完全同名错误艺人在后，断言一次顺序扫描选择前者；反转顺序时选择新的首个严格合法结果。“刘雨”、任意包含、近似名和拼音推断必须拒绝。
- 歌手身份、专辑列表和逐专辑详情的第 1 页、中间页、末页。
- 详情完整曲目、合作歌曲、同名不同 albumId、重复歌曲 ID 和缺失稳定字段。
- Provider 专辑分页与专辑详情内的重复项保留 issue 标识符；预览回退只使用 issue 与最终保留快照，并对不可恢复字段保持缺失。
- 超时、失败、空数据、非法响应、重复页、total 漂移、有限重试、限流和取消。
- 合法 `MusicInfoOnline` 映射及来源特有播放元数据保留。
- 网易 legacy/v1 正整数曲序原样保留，`no=0` 与缺少独立曲序按详情原始位置回退；负数、非整数、非数字和其他必需字段继续拒绝。
- 酷我专辑级回退图和曲目级绝对图的 `240 → 500`，以及非酷我域名、相对 URL、查询参数、其他尺寸和畸形 URL的不变性。

QQ 专题必须覆盖 `BUG-20260805-03` 的子响应 `.code`、独立统计、连续 begin、歌曲数组返回和请求头；网易专题必须覆盖 `BUG-20260805-02` 的连续 offset、音质无贯穿及缺少 `body.user`。酷我必须覆盖独立逐专辑详情分页，不能只测歌手歌曲列表。

`BUG-20260809-01` 的网易专题已覆盖：主详情成功不请求备用、主详情精确 `code=-462`/`verifyType=50` 后请求 v1、v1 根级 `songs` 现代结构严格映射、canonical albumId 不一致、必需歌曲字段缺失、主端点其他 non-200、fallback 任意 non-200、code 200 malformed、有限重试及取消。来源摘要专题同时断言同 owner 空专辑的派生行折叠、非空或跨 owner/album 不误合并，以及完整 plan issues 不变。

### 批次协调

- 抓取来源初始默认四项全选；一至四项子集按稳定顺序固化，零来源和未知来源在请求前拒绝，未选 adapter 调用次数为零。
- 所选来源的身份解析并行并全部 arrived 后才进入确认；单个解析失败或无严格匹配生成该来源 `failed`，成功 `ArtistRef[]` 只调用一次统一确认并继续抓取，不被失败来源阻断。
- 所选来源全部解析失败或无严格匹配时不调用确认和专辑接口；确认回调返回 `false`、抛错或用户取消时，成功身份子集也不开始专辑抓取。
- 所选来源计划独立，跨来源相同 ID 或名称不去重。
- 所选平台并行进度可定位，整批取消停止所有所选来源新请求。
- 整批重试使用新 batchId，旧结果和迟到事件不能提交。
- 非空 `partial` 无需授权即可使该来源 `plan.canApply=true`；failed、cancelled 或全部合法专辑无合法歌曲只排除该来源，全部不合格才使 batch `canApply=false`。
- batch apply 自动为每个来源使用全部合法专辑，调用方不能提交专辑子集。
- 同一来源最终歌曲按稳定 `track.id` 保留首次出现项并输出精简核查字段；跨来源相同 ID 或名称不去重。
- 生成来源初始默认全选全部合格项；任意非空子集可 apply，零项、未抓取项、不合格项或重复项在写入前拒绝，切换该选择不增加 Provider 调用。
- `AlbumCollection` 进入、离开、返回后只执行一次页面 setup，两组来源选择、来源摘要和去重核查保持不变；移除 route `keepAlive` 时测试必须失败。
- 返回页面不产生新的 Provider 请求；显式重新获取才创建新 `batchId`，刷新或重启不恢复抓取快照。

### 批量写入与补偿

- 只为生成子集精确生成“`<输入歌手名>-<平台>-<N>首`”名称和唯一 ID；分别断言 `N` 等于实际提交数组长度。
- 无同名时写入选中来源对应歌曲；有同名时只提示选中目标，确认后仍新建，不修改旧歌单或未选来源。
- 选中子集第 1 至第 N 个歌单创建失败、加歌失败均触发对本次已创建歌单的逆序补偿。
- 补偿完全成功返回无残留失败；单个或多个删除失败继续补偿并返回完整残留。
- 批次失败不设置 `sourceListId`、不创建下载任务、不删除批次外歌单。
- 成功后应用重启，本次选中生成的全部歌单仍存在，并可分别进入原生下载弹窗。

### 来源摘要与去重核查

- 已抓取来源卡不出现逐专辑名称、ID、行项目或专辑选择控件，逐专辑异常只进入对应来源完整性说明；来源级生成复选项不属于专辑选择。
- 最终歌单去重卡只展示并复制平台、类型、歌曲/歌手、一个稳定 ID 或 Provider ID、保留与移除专辑名称、albumId 和曲序；不包含快照位置、重复 Provider ID 或单独的首次出现原因。
- Provider/专辑内早期去重标明早期类型和 `exact: false` 边界；fixture 缺少名称、ID、专辑或曲序时保持缺失，不生成伪造值。
- 没有早期或最终去重记录时，对应核查区不渲染。
- 切页返回继续显示同一批次的来源摘要、完整性说明和核查卡，且 Provider 调用计数不增加。

### 验证矩阵

```text
npm run test:artist-discography
npx tsc --noEmit -p src/renderer/tsconfig.json --pretty false
npm run build:renderer
```

以上三条命令及 core + Tools 定向 ESLint 已在阶段 9 实现后重新执行并通过；专题测试最终为 37 个文件、231 项测试。三语言总键计数均为 1013，本专题各 104 个键，集合与占位符一致且删除键无残留。两轮独立只读交叉审查均未发现 P0/P1/P2 问题。

这些均为阶段 11 之前的历史证据。阶段 11 完成后必须重新执行同一矩阵，并增加 Main 类型检查、全量 lint、开发态 Renderer 编译、严格别名顺序/来源子集专题、三语言一致性和真实 Electron 人工走查；当前不得声称新增范围通过。

实时 Provider 冒烟必须显式启用且保持只读，线上数量不写入固定断言，实时成功不能替代离线合同测试。此前临时 Vitest 验证“蔡徐坤”在 `kg/tx/wy/kw` 四个真实端点均完成身份解析、专辑列表和一张专辑详情归属校验；本次 UI 与去重合同由固定样例和离线专题测试验收。

## 实施阶段

### 阶段 0：文档确认

- [x] 新建并确认 `REQ-20260809-01`、`BIZ-20260809-03` 和本 DEV。
- [x] 将旧 REQ/BIZ/DEV 的酷狗首期边界与后续四平台扩展建立追溯关系。
- [x] 既有四来源功能及定向自动化完成后，曾将本 DEV 更新为 `implemented`。
- [x] 接受 `BIZ-20260809-04` 后先将本 DEV 重新打开为 `in_progress`，完成实现与自动化后更新为 `implemented`。
- [x] 接受 `BIZ-20260810-02`、确认 `BUG-20260810-01` 后再次将本 DEV 重新打开为 `in_progress`；既有固定四来源验证不作为本轮证据。

### 阶段 1：通用来源合同与批次骨架

- [x] 泛化 `ArtistDiscographySource`、单来源计划和 adapter registry。
- [x] 增加四来源 fixture seam、批次状态、共享取消和新 batchId 竞态保护。
- [x] 保持现有酷狗合同并纳入专题回归。

### 阶段 2：QQ 来源纵向切片

- [x] 在新目录 adapter 中覆盖 `BUG-20260805-03` 对应的响应、分页和歌曲映射路径；BUG 文档状态独立维护。
- [x] 实现 QQ 名称完全匹配、专辑分页和逐专辑详情 adapter。
- [x] 完成 QQ 脱敏固定样例和离线合同测试。

### 阶段 3：网易来源纵向切片

- [x] 在新目录 adapter 中覆盖 `BUG-20260805-02` 对应的分页、音质和空歌手信息路径；BUG 文档状态独立维护。
- [x] 实现网易名称完全匹配、专辑分页和逐专辑详情 adapter。
- [x] 完成网易脱敏固定样例和离线合同测试。

### 阶段 4：酷我来源纵向切片

- [x] 实现酷我名称完全匹配、专辑分页和逐专辑详情 adapter。
- [x] 完成酷我字段归一化、脱敏固定样例和离线合同测试。

### 阶段 5：统一预览与批量写入

- [x] 实现四身份统一确认、四来源并行计划、整批取消/重试和四份独立预览。
- [x] 旧版实现曾保留每来源专辑选择，并由 UI 将逐来源 `partial` 接受决定通过 `allowIncompleteBySource` 传给 apply；专辑选择已在阶段 7 移除，partial consent 已在阶段 9 删除。
- [x] 已实现旧版固定平台后缀命名、同名提示后新建、确定性写入和尽力补偿；命名中的最终歌曲数由阶段 10 修订。
- [x] 为 `AlbumCollection` 启用页面级 `KeepAlive`，保留已完成批次的页面状态且只由显式重新获取替换。
- [x] 页面失活时仅取消仍在进行的 planning，不在后台继续身份确认或抓取，也不清除已完成快照。

### 阶段 6：回归与交付

- [x] 执行专题测试、Renderer 类型检查、定向 ESLint 和 `build:renderer`。
- [x] 完成“蔡徐坤”四平台真实端点的临时 Vitest 只读冒烟，并删除临时测试文件。
- [x] 执行 `routePersistence.test.ts` 定向回归，验证进入、离开、返回只 setup 一次且快照保留；移除 `keepAlive` 时红、恢复后绿。
- [x] 将路由持久化测试纳入后的最终全套测试文件数和测试数更新到本 DEV、REQ 与 PROG。
- [ ] 完成真实 Electron 统一确认、预览、批量创建和补偿人工验收。
- [ ] 完成应用重启后的选中来源歌单持久化与原生下载弹窗人工验收。
- [x] 完成 Windows x64 NSIS 安装包构建及产物结构、随包资源和 native 模块校验。
- [ ] 完成安装器运行、安装态启动及四来源功能验证。
- [x] 更新 REQ 自动化可证明的验收项、DEV 状态和 PROG 证据；关联 BUG 状态不在本次文档范围内变更。

### 阶段 7：来源摘要与去重核查修订

- [x] 新建并接受 `BIZ-20260809-04`，同步 REQ、DEV、CONTEXT 和 PROG。
- [x] 新增 `assembly.ts` 与 `DiscographyTrackDeduplication`，使 plan/apply 共用同一首次出现去重并生成最终精确核查。
- [x] 保留 adapter 的既有 duplicate issue 合同，由 `preview.ts` 生成 identifier-only、`exact: false` 的早期回退，不伪造已丢失原始副本。
- [x] 将 batch apply 改为自动使用四个来源全部合法专辑，移除 `albumIdsBySource`。
- [x] 将来源卡改为摘要视图，移除逐专辑明细和选择，聚合普通问题并增加条件式核查卡及复制信息。
- [x] 保持来源摘要、完整性说明和去重核查随同一完成批次由页面实例跨路由缓存；失活时仍取消未完成 planning。
- [x] 将 Tools 测试 glob 纳入专题套件，补充 assembly、plan/apply、batch 和 preview 回归并重新执行验证矩阵。

### 阶段 8：网易专辑详情验证拦截回退

- [x] 新建 `BUG-20260809-01`，在 REQ、DEV、PROG 和 README 中记录目标合同与未验证边界。
- [x] 补充脱敏的主端点验证拦截与 v1 现代详情 fixture，完成精确拦截识别、备用请求和严格映射。
- [x] 实现主端点其他 non-200 与 fallback 任意 non-200 的单一 `provider_unavailable` 分类，并保持 code 200 malformed 为 `invalid_provider_response`。
- [x] 在来源摘要层仅对同 owner albumId 且 `actualCount=0` 的根因折叠派生计数/空目录提示，保持底层 issues、状态和 apply 规则不变。
- [x] 补充 adapter、mapper、plan/preview 回归并执行专题测试、Renderer 类型检查、定向 ESLint、Renderer 构建和 diff check。

### 阶段 9：删除 partial consent 并精简去重核查

- [x] 新建并接受 `BIZ-20260809-05`，同步被修订 BIZ、REQ、DEV、CONTEXT、PROG 和 README。
- [x] 从 batch apply input、预检和测试中删除 `allowIncompleteBySource`；非空 `partial` 直接允许写入，`failed/cancelled/0 首` 保持阻断。
- [x] 从 Tools 页面和 KeepAlive 状态中删除 partial consent 控件、状态及清理逻辑。
- [x] 将去重核查与复制文本精简为平台、类型、歌曲/歌手、单一 ID、保留/移除专辑名、albumId、曲序，移除位置、重复 Provider ID 和单独的首次出现原因。
- [x] 保持早期 duplicate 的 `exact: false` 与缺失字段边界，补充不伪造、跨来源隔离和无去重不显示回归。
- [x] 执行专题测试、Renderer TypeScript、core + Tools 定向 ESLint、Renderer 构建、三语言一致性和双重只读交叉审查，并据实更新 REQ/DEV/PROG。

### 阶段 10：来源歌单名称包含最终歌曲数

- [x] 新建并接受 `BIZ-20260810-01`，同步被修订 BIZ、REQ、DEV、CONTEXT、当日 PROG 和 README。
- [x] 提供共享的目标名称生成规则，严格输出“`<输入歌手名>-<酷狗|qq|网易|酷我>-<N>首`”。
- [x] 让目标名称预览、同名检查、core 实际创建和补偿失败残留报告使用同一名称。
- [x] 由 apply 时最终去重后的实际提交数组长度计算 `N`，保持 0 首阻断并防止旧计划或 UI 数量漂移。
- [x] 补充四来源不同曲数、去重后计数、同名冲突、0 首阻断和补偿残留名称回归，并执行专题测试、Renderer TypeScript、定向 ESLint 及 Renderer 构建。

### 阶段 11：严格别名顺序匹配与两阶段来源子集

- [x] 新建并接受 `BIZ-20260810-02`，确认 `BUG-20260810-01`，同步 REQ、DEV、CONTEXT、README 和当日 PROG。
- [x] 新增网易歌手名称规范化与完整别名段纯函数；adapter 按 Provider 原始顺序一次扫描首个 `exact/alias_exact`，覆盖“刘雨昕XIN LIU”在前、完全同名错误艺人在后及不完整子串拒绝。
- [x] 身份解析使用 all-settled 协调：失败来源保留 `failed`，只对成功身份非空子集统一确认并继续抓取；零成功不弹确认，确认异常或取消时不发起专辑请求。
- [x] 批次 `plan.sources` 接收非空抓取来源，只调用所选 adapter，并以 `Partial<Record<...>>` 保存每个请求来源计划、失败状态及 batch `canApply`。
- [x] Tools 增加默认全选的抓取来源复选组及生成来源复选组；分别实现零来源阻断、失败/取消/0 首禁用、切换生成来源不请求 Provider。
- [x] batch `apply.sources` 接收非空生成来源，只对合格选中子集生成名称、检查同名、创建和尽力补偿，未选来源保持零写入与零回滚。
- [x] 将 `fetchSourceSelection/generateSourceSelection` 纳入 KeepAlive 路由回归；显式重新抓取按当前选择重建快照并把生成选择重置为全部合格来源。
- [x] 修复 `BaseCheckbox` 禁用态键盘边界：禁用时从 Tab 顺序移除，键盘切换入口在修改状态前直接返回。
- [x] 完成 5 文件 62 项定向回归、网易 1 项真实只读身份冒烟、Renderer TypeScript、定向 ESLint 和生产 Renderer 构建。
- [ ] 完成无范围外超时的最终全专题、Main 类型检查、全量 lint、开发态 Renderer 编译、真实 Electron UI 及完整专辑/创建人工验收。

### 阶段 12：网易零曲序兼容

- [x] 用脱敏 legacy 与 v1 fixture 固化《梦之光年》两首合法歌曲均返回 `no=0` 的 mapper 和 adapter 回归。
- [x] 对 `no=0` 或没有独立曲序字段使用专辑详情原始位置补一基曲序；正整数原样保留，负数、非整数、非数字及其他必需字段继续严格拒绝。
- [x] 复跑网易 mapper/adapter、全专题、Renderer TypeScript、定向 ESLint、Renderer 生产构建，并执行真实只读复现。

### 阶段 13：酷我专辑封面尺寸规范化

- [x] 用真实 URL 形状补充酷我 mapper 红绿回归，将可信 `/star/albumcover/240/` 精确规范化为 `/500/`。
- [x] 保持非可信 URL、路径中段、其他尺寸、下载失败降级和既有文件兼容边界。
- [x] 复跑酷我专题、全专题、Renderer TypeScript、定向 ESLint 和 Renderer 生产构建，并执行真实只读 URL 复核。

### 阶段 14：酷我整专辑零基曲序兼容

- [x] 用脱敏《醇情歌》fixture 固化 19 首歌曲及连续零基 `track=0..18` 的 mapper 和 adapter 红色回归。
- [x] 在校验完整专辑原始序列后，将严格连续且与响应位置一致的 `0..N-1` 整体规范化为 `1..N`；不按成功映射后的剩余歌曲重新编号。
- [x] 保持可靠一基连续序列和一基中间缺口原样，非连续零基、负数、非整数、非数字及其他必需字段继续严格拒绝。
- [x] 复跑酷我 mapper/adapter、全专题、Renderer TypeScript、定向 ESLint 和生产构建，执行真实只读复现，并重新构建和静态核对 Windows x64 NSIS 安装包。

## 实现与验证记录

主要实现落点：

- `src/renderer/core/artistDiscography/batch.ts`：四来源 `plan/apply`、`batchId/status/canApply`、过期批次保护、写入预检和补偿。
- `src/renderer/core/artistDiscography/assembly.ts`：按稳定 `track.id` 首次出现规则组装全部合法专辑，返回精确 `DiscographyTrackDeduplication`；plan/apply 共用。
- `src/renderer/utils/musicSdk/{kg,tx,wy,kw}/artistDiscography.ts`：四来源目录 adapter；各目录配套 mapper、脱敏 fixture 与合同测试。
- `src/renderer/views/Tools/preview.ts`：聚合逐专辑普通问题，将精确 assembly 记录映射为核查卡，并用 duplicate issue 与保留快照生成 identifier-only 早期回退。
- `src/renderer/core/artistDiscography/assembly.test.ts`、`src/renderer/views/Tools/preview.test.ts`：覆盖首次出现精确审计、双方位置、无重复空状态、普通问题聚合和 `exact: false` 回退。
- `src/renderer/views/Tools/index.vue`：统一确认、四份来源摘要、精简去重核查与复制、同名提示和批量结果展示；无 partial consent、逐专辑列表或选择。
- `src/renderer/views/Tools/index.vue`：`onDeactivated` 在 `isPlanning` 时调用 `handleCancel`，保持未完成抓取不在失活页面后台运行。
- `src/renderer/router.ts`：`AlbumCollection` route 启用 `keepAlive: true`，在当前应用会话内保留页面实例。
- `src/renderer/views/Tools/routePersistence.test.ts`：使用 Vue `KeepAlive` 真实模拟进入、离开和返回。
- `vitest.config.mjs`：将 `src/renderer/views/Tools/**/*.test.ts` 纳入 `test:artist-discography`。
- `src/renderer/core/artistDiscography/batch.ts`：新增共享 `createArtistDiscographyPlaylistNames`；apply 以准备后的实际提交数组长度生成名称并校验计划去重曲数，创建目标与补偿残留复用同一名称。
- `src/renderer/core/artistDiscography/batch.test.ts`：覆盖四来源不同曲数、输入 trim、去重后计数、计数漂移阻断和补偿残留名称。
- `src/renderer/views/Tools/index.vue`：目标名称预览和同名检查复用 core helper，并显示各来源带最终曲数的名称。

2026-08-09 阶段 9 最终验证：

- `BUG-20260809-01` 定向 Vitest：5 个测试文件、59 项测试全部通过。
- `npm run test:artist-discography`：37 个测试文件、231 项测试全部通过；包含非空 `partial` 自动 apply、阻断状态、精简 presentation、网易 fallback 与路由持久化测试。
- 新增回归覆盖非空 `partial` 自动 apply、`failed/cancelled/0 首` 阻断、单一标识符与精简 occurrence、隐藏内部位置、早期 identifier-only `exact: false` 回退、不伪造及无重复不展示。
- `npx tsc --noEmit -p src/renderer/tsconfig.json --pretty false`：通过。
- `npm run build:renderer`：最终通过。
- core + Tools 定向 ESLint：通过。
- 中、繁、英三份语言文件的总键计数均为 1013，本专题各 104 个键；专题键集合与占位符一致，删除键无残留。
- 两轮独立只读交叉审查：均无 P0/P1/P2。
- 既有临时 Vitest 只读实时冒烟：4 项测试通过；“蔡徐坤”在 `kg/tx/wy/kw` 均完成身份解析、专辑列表和一张专辑详情归属校验。临时文件已删除，未写入歌单、未触发下载。
- 网易真实接口只读复核：《渡》（albumId `36855053`）连续 10 次均为声明 10 首、实际 10 首；主端点 7 次 `-462` 成功走 fallback，3 次 code 200 直接成稿。
- 截图所列 9 张网易专辑全部声明数=实际数：顽疾 1/1、湖泊 1/1、金斧子银斧子 1/1、无数 10/10、为了遇见你 1/1、渡 10/10、来日方长 1/1、绅士 3/3、方圆几里 2/2；其中 5 张主端点 `-462` 并成功 fallback。

2026-08-10 阶段 10 最终验证：

- `npm run test:artist-discography`：37 个测试文件、234 项测试全部通过。
- Renderer TypeScript：通过。
- core batch + test + Tools 定向 ESLint：通过。
- `npm run build:renderer`：成功。
- 运行时代码中旧无数量命名无残留；相关文档无尾随空白。
- 最终独立交叉审查未发现 P0/P1/P2 问题。

2026-08-10 阶段 11 实现与验证：

- `DiscographyBatchPlanInput/ApplyInput` 最终接口为 `plan({ artistName, sources, confirmArtists })` 与 `apply({ plan, sources })`；plan 保存稳定抓取 `sources`、同 key 的 `Partial<Record<source, plan>>`，batch `canApply` 表示至少一个来源可写，apply `sources` 表示生成子集。
- batch 使用 `arrived + waiters` 等待所选来源身份解析全部抵达；失败来源保留 `failed`，成功身份非空子集只统一确认一次，零成功不调用确认。Tools 增加 `fetchSourceSelection/generateSourceSelection` 两组默认全选状态，只允许合格已抓取来源进入生成选择。
- 网易 mapper 增加严格汉字/拉丁双脚本完整名称段分类，adapter 按 Provider 原始稳定顺序一次扫描首个 `exact/alias_exact`；不使用任意包含，也不全局优先 `exact`。
- `src/renderer/components/base/Checkbox.vue` 在 `disabled` 时使用 `tabindex=-1`，`handleToggle` 首行 guard 阻止 Enter/Space 改变禁用项；该修复覆盖抓取与生成来源中不可选项的键盘交互边界。
- `npx vitest run --config vitest.config.mjs src/renderer/core/artistDiscography/batch.test.ts src/renderer/utils/musicSdk/wy/artistDiscography.test.ts src/renderer/utils/musicSdk/wy/artistDiscographyMapper.test.ts src/renderer/views/Tools/sourceSelection.test.ts src/renderer/views/Tools/routePersistence.test.ts`：5 个文件、62 项测试全部通过；其中网易 adapter/mapper 33 项、core batch 25 项通过。
- `npx tsc --noEmit -p src/renderer/tsconfig.json --pretty false`：退出码 0。
- 包含 `src/renderer/components/base/Checkbox.vue` 的本轮 core、Tools、网易定向 ESLint：退出码 0。
- `npm run build:renderer`：webpack 成功，耗时 62.207 秒。
- `npx vitest run --config vitest.config.mjs src/renderer/utils/musicSdk/wy/artistDiscography.live.test.ts`：临时只读身份冒烟 1/1 通过。POST 搜索“刘雨昕”首项为 ID `12217134`、“刘雨昕XIN LIU”、24 张专辑，第二项为 ID `60333962`、“刘雨昕”、2 张专辑；稳定顺序首个合法结果和后续 canonical 详情均为 ID `12217134`、“刘雨昕XIN LIU”。临时测试文件已删除；未抓取完整专辑、未写入歌单。
- `npm run test:artist-discography` 本轮最终代码执行 254 项，253 项通过；唯一失败为本任务范围外 `flacConverter` 真实 FFmpeg 转换固定 5 秒超时，单独复跑仍在 5.039 秒超时并伴随清理 `EBUSY`。集成前曾有 38 个文件、254 项全绿，但早于最终 Tools/网易顺序修订，不作为最终全专题通过证据。
- 尚未执行真实 Electron UI（包括禁用来源的 Tab/Enter/Space 人工走查）、完整网易专辑抓取/生成歌单、Main 类型检查、全量 lint 或开发态 Renderer 编译；新安装包已完成构建与静态/native 校验，但未运行安装器或进行安装态验证。

2026-08-10 阶段 12 实现与验证：

- 网易 mapper 以原始 `rawSongs.entries()` 的 index 作为确定性位置，只在 Provider 曲序为 `0` 或没有独立曲序字段时补 `index + 1`；正整数原样保留，负数、非整数和非数字继续映射失败。
- 脱敏 legacy/v1 两类 `no=0` fixture 均覆盖 mapper 与 adapter；主成功单请求、精确验证拦截后 v1 fallback、缺少独立曲序、既有 albumId/艺人/时长负向边界均有回归。
- 网易 mapper/adapter 2 个文件、41 项测试全部通过；`npm run test:artist-discography` 为 38 个文件、263 项全部通过。
- Renderer TypeScript、网易四个相关文件定向 ESLint 与 `npm run build:renderer` 均通过；webpack 生产编译耗时 37.374 秒。
- 临时只读实时测试抓取《梦之光年》（albumId `158473631`）：主详情本次直接返回 legacy code 200、2 首歌曲及 `no=[0,0]`，修复后得到 2/2、曲序 `[1,2]`、无 issue。此前 v1 fallback 的同构真实响应由脱敏 adapter 合同锁定；临时文件已删除。
- 真实 Electron 页面、歌单创建和安装态仍未执行；Windows x64 NSIS 安装包已在阶段 12 后重新构建，ASAR 源码图已确认包含本次修复。

2026-08-10 阶段 13 实现与验证：

- `normalizeKwAlbumCoverImage` 仅接受绝对或协议相对图片 URL，并在主机为 `kuwo.cn` 或其子域、pathname 从 `/star/albumcover/240/` 起始时将尺寸段改为 `500`；规则同时作用于专辑级回退图与曲目级图片。
- 首轮 mapper 回归先得到两条 `/240/` 的 RED，再以最小实现转为 `/500/`；独立审查补充路径中段误改 RED，pathname 起点锚定后转绿。非酷我域名、相对 URL、查询参数、路径中段、`500/1000` 与畸形 URL 均保持原行为。
- 酷我 mapper/adapter 2 个文件 15 项、`npm run test:artist-discography` 38 个文件 265 项全部通过；Renderer TypeScript、定向 ESLint 与 `npm run build:renderer` 均通过，最终 webpack 生产编译耗时 44.596 秒。
- 真实只读复核《你值得太阳》同一酷我图片路径：`/240/` 为 `240×240 / 6,440 bytes`，`/500/` 为 `500×500 / 20,722 bytes`。未修改既有音频，未执行真实 Electron 新下载；阶段 13 新安装包已通过 ASAR 源码图确认包含本修复。

2026-08-11 阶段 14 实现与验证：

- mapper 先在专辑原始详情层判定曲序合同：严格连续且与全局响应位置一致的 `0..N-1` 统一使用 `rawOffset + index + 1`，可靠一基曲序直接保留，零基候选一旦断裂则整页拒绝，不泄漏部分平移结果；adapter 在跨页抓取时传递 `trackNumbering` 和全局 `rawOffset`。
- 回归覆盖单页完整零基、真实 100 项分页边界、后页断裂、可靠一基连续和 `1、2、3、5` 中间缺口，以及负数、非整数、非数字、albumId 和其他必需字段边界。
- 酷我 mapper/adapter 2 个文件 24 项、定向链路 4 个文件 47 项、`npm run test:artist-discography` 41 个文件 307 项全部通过；Renderer TypeScript 和定向 ESLint 通过，独立审查未发现 P0/P1/P2 问题。
- 真实只读 adapter 抓取《醇情歌》（albumId `65066`）：声明 19 首、实际 19 首、`complete=true`、曲序 `1..19`，首曲 `kw_40358244 / 爱就是你 / 曲序 1`，`issues=[]`；临时验证文件已删除。
- 使用 `LX_SKIP_WIN_EXECUTABLE_EDIT=true` 完整执行 `npm run pack`，退出码 0、总耗时 83 秒，四套 production webpack 成功，production build 耗时 39.669 秒。新安装包及 ASAR 已静态确认包含酷我 `trackNumbering/rawOffset/zero_based/completeZeroBasedSequence` 跨页实现；安装器未运行，真实 Electron 页面和实际下载未人工验收。

2026-08-10 Windows x64 NSIS 安装包构建验证：

- 初次执行 `npm run pack` 时四个 production webpack 均成功，随后 winCodeSign cache 解压因当前 Windows 账号无 symlink 权限失败；该次执行不作为安装包成功证据。
- 阶段 12 完成后，使用仓库既有开关执行 `$env:LX_SKIP_WIN_EXECUTABLE_EDIT='true'; npm run pack`，退出码为 0；四套 production webpack 全部成功，并于 2026-08-10 14:55:29 生成新的 `build/lx-music-desktop-v2.12.2-x64-Setup.exe`。
- 新安装包为 142,565,383 bytes，SHA-256 为 `55C39D470368BD35030A1C6D47D513B6584C9AA3E8C79AF70DE21F2EE6BA194C`；配套 blockmap 为 150,095 bytes，SHA-256 为 `5AA8791EE4660882CF1CC55E6AEE2764726937F03F114E922DBFF77D2C872011`。`latest.yml` 中 path、size 与 sha512 均与安装包一致，sha512 为 `L8J5ckdkUDEv8VK1ZqPvb1kRS0/bDJbQJNe2CU7ZounaxtiBGhgfvtaplUlSZP+9PkzUtFy9wb1WW1apaVlFIA==`。
- `7za t` 返回 `Everything is Ok`；NSIS 尾部数据警告属于可接受的自解压封装结构。`app.asar` 的 package name/version/main 为 `lx-music-desktop` / `2.12.2` / `./dist/main.js`，大小 33,385,627 bytes，SHA-256 为 `9742C36F0323F55610EA283A6B87F65E9FA871AA7D345E753852C23284E2070C`；源码图包含 `raw.no == null || providerTrackNumber == 0` 与 `responseIndex + 1`，证明阶段 12 已进入产物。
- 随包 FFmpeg SHA-256 保持为 `E9DA9E22D907A996982F18C7EBD7A4B15483D19CA8D581D295B0BD5E08511FEC`，LICENSE/NOTICE 均存在；使用打包后的 Electron 40.9.2 x64 配合 `ELECTRON_RUN_AS_NODE` 验证 better-sqlite3 执行 `select 1` 成功，qrc_decode 导出函数可正常调用。
- 本次通过 `LX_SKIP_WIN_EXECUTABLE_EDIT=true` 跳过 executable edit/sign，Authenticode 状态为 `NotSigned`；未运行安装器，也未执行安装态启动、真实 Electron UI 或四来源功能验收。

2026-08-10 阶段 13 Windows x64 NSIS 重新构建验证：

- 执行 `$env:LX_SKIP_WIN_EXECUTABLE_EDIT='true'; npm run pack`，退出码为 0；完整清理旧 `dist/build` 后，四套 production webpack 全部成功，并于 2026-08-10 15:55:37 生成当前 x64 NSIS 安装包。
- 安装包为 142,565,335 bytes，SHA-256 为 `974D5B6163FDAEACC3E54E299576816131D17B9397B347D5C385D16A69415E09`；blockmap 为 150,168 bytes，SHA-256 为 `B6706E5738D8B48C48A649E727E14E3B461CB55FBA3639E729FE773DB42533F9`；`latest.yml` 的 path、size、两处 sha512 与安装包一致，sha512 为 `ETo/PTvEusX6uhvJl34ruZg1t9etKznd2SLB24p1wIZPoaFgmNJHxNoEdP9M6X+x/afahNEHep/ThXLKmJwqMw==`。
- `7za t` 为 `Everything is Ok`；`app.asar` 为 33,386,895 bytes，SHA-256 为 `510165DF3F2CF0F26B0371501B41C1DB069CB70A97B15353685D0FCFCA8AC087`，metadata 为 `lx-music-desktop` / `2.12.2` / `./dist/main.js`。源码图确认包含酷我封面 normalizer、可信 host、pathname 起点约束及 `/500/` replacement。
- FFmpeg、LICENSE、NOTICE 和 native 模块均存在；打包 Electron 40.9.2 下 better-sqlite3 `select 1` 与 qrc_decode 导出验证通过。安装包为 `NotSigned`，未运行安装器，也未执行安装态或真实 Electron 新下载封面读回。

`BIZ-20260810-02` 已完成生产实现和定向验证，`BUG-20260810-01`、`BUG-20260810-02`、`BUG-20260810-03` 与 `BUG-20260811-01` 均已更新为 `verified`。阶段 14 的生产实现、离线回归、真实只读复现、生产构建和安装包静态内容验证已经完成，本 DEV 收口为 `implemented`；真实 Electron 页面、实际下载和安装态验证仍不在本结论内。

## 兼容性、回滚与降级

- 不新增数据库表或字段，不需要迁移。
- 既有普通本地歌单、酷狗目录快照和下载任务结构保持兼容。
- 抓取页面快照和两组来源选择只由 `KeepAlive` 保留在当前 Renderer 会话内，不新增数据库、磁盘或跨重启持久化结构。
- 新批次协调层可独立回滚；回滚代码时保留用户已经成功创建的普通本地歌单。
- 单个来源 adapter 未通过独立验收时，该来源不得伪装为完整可用；不得自动降级为歌曲搜索。用户仍可在生成阶段选择其他已有合格快照，这属于显式生成子集，不是静默降级。
- Provider 临时不可用时返回来源级失败并使该来源不可选；其他合格来源可由用户明确组成生成子集，用户现有在线歌单导入、搜索和普通下载继续可用。
- 网易主详情明确验证拦截时允许切换同专辑 v1 备用详情；若备用仍不可用则按 `provider_unavailable` 使网易来源不可选，不降级为歌曲搜索；是否生成其他来源歌单由用户的非空生成子集决定。

## 已知风险

- 四个平台接口均不受本项目控制，字段、签名、Cookie、限流或反爬策略可能变化。
- 默认四来源同时抓取会放大请求数量，需要验证未选来源零调用、每来源并发限制与所选批次取消是否真正生效。
- 同名或完整别名段严格结果在同一及不同平台都可能不是同一主体；Provider 稳定顺序和统一确认只能降低风险，不能建立跨平台身份保证。
- 本地歌单 action 非事务性，补偿失败时只能显式报告残留并由用户人工处理。
- 既有来源摘要、partial consent 删除、精简核查 presentation、精确 assembly、早期非精确回退、严格别名顺序匹配、动态来源子集和两组选择缓存已有相应自动化或打包静态证据；这些证据仍不能替代真实 Electron 身份确认、平台勾选和歌单创建验收。
- 当前 x64 NSIS 产物因本机 symlink 权限限制使用 `LX_SKIP_WIN_EXECUTABLE_EDIT=true` 构建，Authenticode 为 `NotSigned`，不能作为已签名正式发布包证据。
- 当前 `app-update.yml` 仍指向上游 `lyswhut/lx-music-desktop`，默认 `common.tryAutoUpdate=true`；受控长期分发前应关闭自动更新或切换自有更新源，避免后续上游版本覆盖本次定制功能。
- 网易主详情验证策略可能继续变化；当前只对精确 `code=-462`、`data.verifyType=50` 启用 v1 回退，未知失败必须保守分类并保留可重试、取消和脱敏边界。
