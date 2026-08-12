---
id: DEV-20260805-01
type: DEV
title: 歌手专辑目录组装技术方案
status: implemented
created_at: 2026-08-05
updated_at: 2026-08-09
owner: KhalilFong
req_ids:
  - REQ-20260805-01
biz_ids:
  - BIZ-20260805-01
  - BIZ-20260807-01
  - BIZ-20260809-02
bug_ids:
  - BUG-20260805-01
  - BUG-20260805-02
  - BUG-20260805-03
  - BUG-20260805-04
  - BUG-20260805-05
  - BUG-20260805-06
  - BUG-20260805-07
  - BUG-20260805-08
  - BUG-20260805-09
  - BUG-20260805-10
  - BUG-20260806-01
  - BUG-20260806-02
  - BUG-20260807-01
supersedes: []
---

# 歌手专辑目录组装技术方案

## 关联文档

- 需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 业务决策：[BIZ-20260805-01 歌手专辑目录口径与来源策略](../decisions/BIZ-20260805-01-discography-scope-and-source.md)
- 业务决策：[BIZ-20260807-01 批量下载优先音质与逐曲自动降级策略](../decisions/BIZ-20260807-01-batch-download-quality-fallback.md)
- 交互修订：[BIZ-20260809-02 工具页面采用歌手名称输入、可选来源目录与独立图标](../decisions/BIZ-20260809-02-tool-input-directory-and-icons.md)
- 后续来源扩展：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 后续技术方案：[DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](DEV-20260809-01-four-source-artist-discography-playlists.md)
- 已知缺陷：
  - [BUG-20260805-01 酷狗歌手 adapter 映射错误](../bugs/BUG-20260805-01-kg-singer-adapter.md)
  - [BUG-20260805-02 网易云歌手 adapter 分页与音质错误](../bugs/BUG-20260805-02-wy-singer-adapter.md)
  - [BUG-20260805-03 QQ 音乐歌手 adapter 响应与分页错误](../bugs/BUG-20260805-03-tx-singer-adapter.md)
  - [BUG-20260805-04 酷狗歌手 adapter 将等级字段误映射为性别](../bugs/BUG-20260805-04-kg-singer-gender-mapping.md)
  - [BUG-20260805-05 酷狗专辑详情分页重复请求元数据并耦合失败](../bugs/BUG-20260805-05-kg-album-detail-pagination.md)
  - [BUG-20260805-06 原生批量下载弹窗未禁用不可用音质](../bugs/BUG-20260805-06-batch-download-quality-fallback.md)
  - [BUG-20260805-07 酷狗目录分页按请求页大小提前终止](../bugs/BUG-20260805-07-kg-pagination-limit-assumption.md)
  - [BUG-20260805-08 工具页预览模板未保持计划结果的非空类型](../bugs/BUG-20260805-08-tools-template-nullability.md)
  - [BUG-20260805-09 工具页缺少来源输入与完整歌手确认信息](../bugs/BUG-20260805-09-tools-source-and-artist-confirmation.md)
  - [BUG-20260805-10 酷狗歌手畸形响应被误判为歌手不存在](../bugs/BUG-20260805-10-kg-artist-response-classification.md)
  - [BUG-20260807-01 批量下载最高音质被精确交集规则禁用](../bugs/BUG-20260807-01-batch-download-highest-quality-disabled.md)
  - [BUG-20260806-01 酷狗专辑曲目扩展遗漏 album_audio_id 导致多发行版缺曲](../bugs/BUG-20260806-01-kg-album-audio-id.md)
  - [BUG-20260806-02 工具页 v-for 索引隐式 symbol 转换导致开发态启动编译失败](../bugs/BUG-20260806-02-tools-v-for-symbol-key.md)

## 状态与前置条件

本方案已获批准并进入实施。开始业务代码前的条件为：

1. `REQ-20260805-01` 为 `approved`。
2. `BIZ-20260805-01` 为 `accepted`。
3. 第一阶段来源确认为酷狗。
4. 建立可离线运行的 module interface 和 adapter 合同测试入口。

## 关键语义修正

最初设想为：

```text
获取全部专辑 ID
→ 获取歌手全部歌曲
→ 按专辑 ID 过滤
```

该流程只能取得目标歌手参与的歌曲，可能漏掉专辑中的合作曲、伴奏、序曲或未把目标歌手列为曲目艺人的内容，不能单独证明“完整专辑”。

本方案允许歌手歌曲列表作为可选预填优化，但不把它作为完整性证据：

```text
获取歌手全部专辑
→ 可选获取歌手全部歌曲并按 albumId 预分组
→ 对每张专辑始终调用专辑详情
→ 以详情去重曲数与专辑声明曲数校验
→ 仍不一致则标记 incomplete
→ 汇总、预览、创建普通本地歌单
→ 用户主动进入洛雪原生下载
```

当前只有酷狗同时存在歌手专辑列表和专辑详情实现，因此第一阶段只支持 `kg`。网易云和 QQ 音乐在获得等价的专辑详情 adapter 之前不得被标记为支持“完整专辑”。

> 本段记录酷狗第一阶段的实现前提。2026-08-09 已按 [DEV-20260809-01](DEV-20260809-01-four-source-artist-discography-playlists.md) 启动 `kg/tx/wy/kw` 四来源扩展；新来源在各自合同测试和独立验收完成前仍不得标记为支持。

## 现有能力

- `src/renderer/utils/musicSdk/kg/singer.js:8`：歌手信息。
- `src/renderer/utils/musicSdk/kg/singer.js:36`：歌手专辑分页。
- `src/renderer/utils/musicSdk/kg/singer.js:57`：歌手歌曲分页。
- `src/renderer/utils/musicSdk/kg/album.js:40`：按专辑 ID 获取完整曲目。
- `src/common/utils/tools.ts:3`：旧歌曲结构转换为 `MusicInfoOnline`。
- `src/renderer/store/list/action.ts:55`：创建普通本地歌单。
- `src/renderer/store/list/action.ts:38`：向本地歌单添加歌曲。
- `src/renderer/store/download/action.ts:357`：原生下载任务入口。

当前 `kg/index.js` 没有导出 `singer` 和 `album`。现有代码来自未接入 UI 的预留实现，必须先修复并用固定样例验证，不能直接从页面调用。

## module 设计

新增一个深 module，建议位置：

```text
src/renderer/core/artistDiscography/
├─ index.ts
├─ types.ts
├─ plan.ts
├─ apply.ts
└─ adapters/
   ├─ artistCatalog.ts
   └─ playlist.ts
```

调用者只学习两个入口：只读生成计划和确认后应用计划。分页、Provider 差异、补齐、校验、去重、错误聚合及歌单写入补偿均隐藏在 implementation 内。

### 外部 interface

```ts
interface ArtistDiscographyModule {
  plan(input: {
    source: 'kg'
    artistRef: string
    signal?: AbortSignal
    onProgress?: (progress: DiscographyPlanProgress) => void
    confirmArtist?: (artist: ArtistRef) => boolean | Promise<boolean>
  }): Promise<DiscographyPlan>

  apply(input: {
    plan: DiscographyPlan
    albumIds?: string[]
    target:
      | { type: 'new'; name: string }
      | { type: 'existing'; listId: string }
    allowIncomplete?: boolean
  }): Promise<DiscographyApplyResult>
}
```

约束：

- `plan` 只读，不写歌单、不创建下载任务。
- `apply` 默认拒绝含 `incomplete` 或 `failed` 专辑的计划。
- `albumIds` 省略时写入全部专辑；传入时只写入选中专辑，并在 module 内按稳定歌曲 ID 重新生成扁平歌单。空选择必须拒绝。
- 调用者不接触页码、offset、重试次数或 Provider 原始字段。
- 输出歌曲必须是合法的 `LX.Music.MusicInfoOnline`。
- 下载不进入该 interface，继续使用洛雪原生界面。

### 计划结果

```ts
interface DiscographyPlan {
  source: 'kg'
  status: 'complete' | 'partial' | 'failed' | 'cancelled'
  artist: ArtistRef | null
  expectedAlbumCount: number | null
  actualAlbumCount: number
  albums: Array<{
    album: AlbumRef
    tracks: LX.Music.MusicInfoOnline[]
    expectedCount: number | null
    actualCount: number
    status: 'complete' | 'incomplete' | 'unknown' | 'failed'
    issues: DiscographyIssue[]
  }>
  tracks: LX.Music.MusicInfoOnline[]
  rawTrackCount: number
  deduplicatedTrackCount: number
  canApply: boolean
  fetchedAt: number
  issues: DiscographyIssue[]
}
```

每张专辑必须先完成自身曲数校验，再进行扁平歌单的全局歌曲 ID 去重。同一歌曲出现在普通版、豪华版或精选集时，扁平歌单只保留一个歌曲 ID，但计划必须报告被折叠的专辑归属。

## seam 与 adapter

在线平台属于不可控制的真实外部依赖。module 内部建立 `ArtistCatalogPort` seam；生产使用酷狗 adapter，离线测试使用 fixture adapter，后续可增加网易云和 QQ adapter。

```ts
interface ArtistCatalogPort {
  resolveArtist(ref: string, signal?: AbortSignal): Promise<ArtistRef>
  getArtistAlbums(artistId: string, signal?: AbortSignal): Promise<CatalogCollection<AlbumRef>>
  getArtistTracks?(artistId: string, signal?: AbortSignal): Promise<CatalogCollection<LX.Music.MusicInfoOnline>>
  getAlbumTracks(albumId: string, signal?: AbortSignal): Promise<CatalogCollection<LX.Music.MusicInfoOnline>>
}

interface CatalogCollection<T> {
  items: T[]
  reportedTotal: number | null
  complete: boolean
  issues: DiscographyIssue[]
}
```

adapter 隐藏：

- 歌手名称完全匹配搜索，以及数字 ID/官方链接兼容解析。
- 一基页码、零基 offset 和分页终止差异。
- 旧歌曲结构到 `MusicInfoOnline` 的转换。
- Provider 请求、有限重试和错误归一化。
- 专辑详情分页和字段差异。
- 取消后停止创建新请求。

生产酷狗 adapter 默认调用歌手搜索接口并只接受名称完全匹配的 Provider 首项，再使用 canonical numeric ID 调用歌手信息接口；纯数字 ID 和白名单 `www.kugou.com`、`m.kugou.com` 官方歌手链接继续兼容。它不会请求用户输入的任意 URL。既有 `album.getSongList` 的单页与重复元数据请求不再进入本链路，专辑详情分页由新 adapter 独立管理。

### 歌单 adapter

歌单创建和歌曲添加是两次独立 IPC，不是数据库事务。建立内部 `PlaylistPort` 以集中补偿逻辑：

```ts
interface PlaylistPort {
  create(id: string, name: string): Promise<void>
  add(id: string, tracks: LX.Music.MusicInfoOnline[]): Promise<void>
  remove(id: string): Promise<void>
}
```

生产 adapter 复用 `createUserList`、`addListMusics` 和 `removeUserList`。新建歌单成功但添加失败时立即删除本次空歌单；清理也失败时返回残留歌单 ID，界面必须明确提示用户手工处理。

现有 `createUserList` 不返回 ID，且 `removeUserList` 接收 ID 数组。因此 module 在调用前生成唯一歌单 ID，生产 adapter 将 `remove(id)` 包装为 `removeUserList([id])`；不得依赖 `createUserList` 的默认 ID。

写入现有歌单时不执行回滚删除，只报告未写入结果并保留既有用户数据。

## plan 算法

1. 解析来源和歌手引用，调用歌手信息接口验证身份。
2. 获取全部歌手专辑分页；按 `(source, albumId)` 去重并保留 Provider 顺序。
3. adapter 可选获取全部歌手歌曲分页，转换为 `MusicInfoOnline` 并按 albumId 预分组；该结果只用于异常提示或请求调度，不进入最终曲目判定。
4. 对每张专辑始终调用 `getAlbumTracks`，获取全部详情分页，并以详情结果替换任何预分组结果。
   - 酷狗专辑详情扩展必须同时向 Gateway 传递详情行中的 `hash` 和经校验的 `album_audio_id`，以锁定同一音频在目标专辑中的具体发行版本。
   - `album_audio_id` 缺失或非法时报告 `invalid_provider_response`，不得退化为 hash-only 查询；否则 Gateway 可能返回默认单曲或旧专辑版本。
5. 详情曲目按稳定歌曲 ID 去重；缺少稳定 ID、必要字段或专辑归属不一致的条目进入异常报告。
6. 专辑详情去重曲数等于声明曲数时标记 `complete`；不一致标记 `incomplete`；请求失败标记 `failed`。
7. 先保存每张专辑完整曲目，再按稳定歌曲 ID 生成扁平歌单并记录全局去重数量。
8. 只有全部专辑均为 `complete`，且扁平结果非空时，计划状态为 `complete` 且 `canApply` 默认为 `true`；取消、失败和部分结果分别返回稳定状态与 issue。

### 并发与分页保护

- 歌手专辑和歌手歌曲分页顺序获取，确保页码和 total 可核验。
- 专辑详情并发数最大为 3，避免对 Provider 造成突发请求。
- 记录已访问页和返回 ID；重复页、连续异常空页或 total 变化时标记不完整。
- total 存在时按累计原始条目数达到 total 终止；Provider 返回非空短页时继续请求，同时保留空页、重复页和安全最大页数保护。
- 单请求有限重试；耗尽后按专辑记录失败，不把网络错误当成空专辑。
- `AbortSignal` 触发后停止创建新请求，并把计划状态标记为 `cancelled`。

## apply 与下载链路

`apply` 的执行顺序：

1. 验证计划状态、`allowIncomplete` 和选中专辑集合。
2. 从选中专辑重新按稳定歌曲 ID 生成扁平 `MusicInfoOnline[]`。
3. 创建新歌单或确认既有普通本地歌单。
4. 添加选中专辑的扁平歌曲。
5. 失败时执行上述补偿逻辑。
6. 返回实际歌单 ID、计划歌曲数、已提交歌曲数及错误。

生成的歌单不设置 `sourceListId`，避免 `syncSourceList` 用远端在线歌单整体覆盖结果。

MVP 不自动调用 `createDownloadTasks`。保存成功后导航到 `/list?id=<歌单 ID>`，用户通过现有列表界面打开 `DownloadMultipleModal`、选择音质并进入原生下载队列。

审计发现原 `DownloadMultipleModal` 固定启用四档音质，worker 对不支持的选择会静默降级，不能满足 FR-06。当前按 `BIZ-20260807-01` 将用户选择视为整批优先音质：弹窗与 worker 共用逐曲解析规则；只要每首歌曲都存在与当前用户源共同支持的音质，该档即可选择，不支持优先音质的歌曲自动向下降级并明确提示；不存在任何共同音质时才禁用。任务创建、去重、持久化和失败处理仍复用原生 `createDownloadTasks`，专辑抓取页不复制下载器。

## UI 方案

在现有 router 和侧边栏增加一个“工具”入口，只实现本 REQ 的“专辑抓取”视图，不提前创建文件整理和转换占位功能。

> 本段记录第一阶段已实现状态。后续导航调整以 [BIZ-20260806-02 专辑抓取与歌曲整理独立导航](../decisions/BIZ-20260806-02-album-collection-and-song-organizer-navigation.md) 和 [DEV-20260806-02 歌曲文件夹整理技术方案](DEV-20260806-02-song-folder-organizer.md) 为准；专辑抓取业务流程本身不变。

状态：

```text
idle -> resolving -> planning -> ready -> applying -> saved
                         |         |          |-> apply_failed
                         |         |-> incomplete
                         |-> failed
                         \-> cancelled
```

界面必须展示：

- 来源和歌手名称输入，示例使用“蔡徐坤”；下载音源可用性说明条不再显示。
- Provider 返回的歌手名称、头像和声明专辑数，开始前由用户确认。
- 专辑目录获取阶段、已处理专辑数、专辑详情获取进度和取消按钮；页码保持在 adapter 内，不泄漏到只暴露阶段进度的 module/UI 边界。
- 每张专辑的声明曲数、实际曲数、状态和问题。
- 原始曲目数、扁平去重数和当前可下载来源提示。
- 专辑选择、创建新歌单、写入已有歌单、重新获取和明确接受部分结果的操作。

第一阶段的“重试”重新执行整个 `plan`，不把单张失败专辑的新响应拼回旧快照。原因是专辑分页、声明 total 和其他专辑详情可能已变化，混合不同抓取时间会破坏快照完整性语义；后续若需要专辑级重试，必须先为快照版本和替换规则增加独立设计。

工具页复用 `BaseSelection`、`BaseInput`、`BaseBtn`、Dialog 和现有主题变量；确认操作使用既有 Dialog，专辑预览使用普通响应式网格，不为当前目录规模新增自定义弹窗或虚拟列表。下载仍进入既有 `DownloadMultipleModal`。远端文本只使用文本绑定，不使用 `v-html`。

## 错误模型

稳定错误码至少包括：

- `unsupported_source`
- `invalid_artist_ref`
- `artist_not_found`
- `provider_unavailable`
- `invalid_provider_response`
- `pagination_inconsistent`
- `album_incomplete`
- `empty_catalog`
- `cancelled`
- `playlist_create_failed`
- `playlist_add_failed`
- `playlist_rollback_failed`

用户消息不得暴露 Cookie、请求正文、用户源内容或其他凭据。开发日志只记录来源、阶段、脱敏 ID 和错误摘要。

## 测试方案

仓库原先没有通用单元测试脚本。实施中已增加精确版本 `vitest@4.0.17` 作为 devDependency，并提供 `npm run test:artist-discography` 与独立 `vitest.config.mjs`；不增加生产依赖。锁文件使用嵌套安装策略保留既有间接依赖基线。

### module interface 测试

- 多页专辑和歌手歌曲不跳页、不重复页。
- 同名不同 albumId 的专辑不合并。
- 即使预分组曲数等于声明曲数，每张专辑也仍请求详情一次且只请求一次。
- 专辑详情结果保留合作、伴奏等完整曲目，不被歌手歌曲预分组过滤。
- 详情补齐后曲数仍不一致时标记 `incomplete`。
- 同一歌曲 ID 在多张专辑中出现时，逐专辑保留归属，扁平歌单去重并报告数量。
- 取消后不再请求下一页或新专辑详情。
- `allowIncomplete` 默认为 false。
- 只写入选中专辑，并对选中歌曲重新按稳定 ID 去重；空选择被拒绝。
- 新歌单添加失败时删除本次新建歌单；删除失败时返回残留 ID。
- `plan` 阶段任意失败都不产生持久化副作用。

### adapter 合同测试

- 使用脱敏固定响应验证酷狗第 1 页、中间页和末页。
- 验证歌手、专辑和专辑详情字段归一化。
- 验证每首歌曲都能转换为合法 `MusicInfoOnline`，酷狗必需的 hash 等字段得到保留。
- 验证同一音频存在多个发行版本时，`album_audio_id` 能定位目标专辑版本；缺失该字段时必须失败且不得发起 hash-only 降级查询。
- 空数据、非法数据、超时和失败产生稳定错误，不抛出无上下文 `TypeError`。

### 集成与回归

- 创建歌单、写入歌曲、应用重启后仍存在。
- 同名歌单的新建、合并、取消行为。
- 未配置用户源时歌单仍可创建，但下载操作保持不可用并有说明。
- 配置有效用户源后能从生成歌单进入原生批量下载弹窗。
- 批量下载把用户选择视为优先音质；弹窗与 worker 共用逐曲解析规则，不支持的歌曲降级到共同支持的最高音质并显示提示，不存在共同音质时禁用。
- 现有在线歌单导入、搜索、歌单同步和普通批量下载不回归。

必须执行：

```text
npm run test:artist-discography
npm run lint
npx cross-env NODE_ENV=development webpack --config build-config/renderer/webpack.config.dev.js --no-cache --stats errors-only
npm run build:renderer
npm run build
```

实时 Provider 只做人工或 opt-in 冒烟，不进入默认离线测试。至少使用一个合法歌手 ID 和一个非法 ID；不固定容易变化的线上专辑总数。实时成功不得替代固定样例测试。

## 实施阶段

### 阶段 0：文档确认

- [x] 用户确认 REQ、BIZ 和 DEV。
- [x] 状态流转完成后再开始业务代码。

### 阶段 1：测试入口与酷狗 adapter 基线

- [x] 增加离线测试入口和 fixture adapter。
- [x] 修复 `BUG-20260805-01`。
- [x] 包装并导出酷狗歌手与专辑详情能力。
- [x] 统一分页、错误和 `MusicInfoOnline` 转换。

### 阶段 2：酷狗最小纵向切片

- [x] 实现 `plan`：歌手确认、专辑分页、可选歌曲预分组、详情成稿和完整性报告。
- [x] 实现取消、有限重试和最大 3 个专辑详情并发。
- [x] 通过 module interface 与酷狗 adapter 合同测试。

### 阶段 3：UI 与歌单写入

- [x] 增加“工具 → 专辑抓取”。
- [x] 完成进度、专辑预览、异常报告、取消和全量重新获取。
- [x] 实现 `apply` 与新歌单失败补偿。

### 阶段 4：原生下载衔接

- [x] 保存后打开本地歌单。
- [x] 为 `DownloadMultipleModal` 增加用户源与全选歌曲音质可用性判断；2026-08-07 调整为最高音质可选、逐曲自动降级，并让 UI 与 worker 共用解析规则。
- [x] 不新增第二套下载器，不默认自动下载。

### 阶段 5：回归与交付

- [x] 执行目标测试、类型检查、lint、Renderer 构建和完整构建。
- [x] 完成酷狗合法与非法 numeric ID 的只读实时冒烟；链接白名单和 token 解析由固定样例验证。
- [x] 更新 REQ 验收项、BUG 状态和每日 PROG。

## 实施结果

- `src/renderer/core/artistDiscography/` 已形成只暴露 `plan/apply` 的深 module，Provider 与本地歌单均通过 port 隔离。
- 生产酷狗 adapter 始终逐专辑获取详情，并用详情中的 `hash + album_audio_id` 锁定目标专辑版本；分页不假定 Provider 遵守请求页大小，重试、取消、非法响应与部分结果均有离线合同测试。
- “工具 → 专辑抓取”已接入现有路由、主题组件、本地歌单 action 和保存后歌单导航；下载仍由用户在原生列表界面手动发起。
- 2026-08-07 自动化验证为 10 个测试文件、61 项测试，Renderer TypeScript、仓库 lint、Renderer 生产构建和完整构建均通过；其中 7 项音质测试覆盖保持最高音质、逐曲降级、用户源降级与无共同音质禁用。
- 用户已完成人工交互中的歌单新建/合并、重启持久化和既有功能回归；最高音质禁用问题在人工验收中暴露并已修复，尚待复测修复后的按钮与实际任务音质，因此本 DEV 仍为 `implemented`。
- 2026-08-09 按 `BIZ-20260809-02` 增加酷狗歌手名称完全匹配搜索，保留数字 ID/官方链接兼容和既有歌手确认；移除专辑抓取页的下载音源状态说明。离线测试覆盖中文名、拉丁名、同名首项、模糊结果拒绝、空结果和当前/旧版 Provider envelope，真实只读接口冒烟确认“蔡徐坤”解析为歌手 ID `192980`。

### 后续来源扩展

网易云和 QQ 音乐不属于第一阶段完成标准。2026-08-09 用户已通过 [REQ-20260809-01](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md) 和 [BIZ-20260809-03](../decisions/BIZ-20260809-03-four-source-discography-playlist-strategy.md) 确认 QQ、网易、酷我与既有酷狗组成四平台批次，具体协调、批量写入和实施阶段以 [DEV-20260809-01](DEV-20260809-01-four-source-artist-discography-playlists.md) 为准。

开始每个新来源实现前仍必须：

- 修复 `BUG-20260805-02` 或 `BUG-20260805-03`。
- 提供可靠的逐专辑详情 adapter 与固定样例。
- 证明合作、伴奏等完整专辑曲目不会被歌手歌曲过滤遗漏。
- 为该来源执行独立验收；不能仅因歌手歌曲列表可用就宣称支持全专辑。

酷我同样必须提供可靠逐专辑详情 adapter、脱敏固定样例和独立验收；本 DEV 不包含其具体实现。

## 兼容性、回滚与降级

- 不新增数据库表或字段，不需要迁移。
- 新结果只使用现有本地歌单和下载持久化。
- 新入口可以独立移除，不影响既有在线歌单、搜索、播放和下载。
- 已创建的汇总歌单属于普通用户数据，代码回滚时保留，不自动删除。
- 某来源 adapter 失效时可单独从支持列表隐藏，不自动降级到模糊歌曲搜索。
- 没有用户下载源时降级为“只生成歌单”。
- 平台接口不可用时，保留用户现有的“导入平台全专辑歌单”手工路径。

## 已知风险

- 酷狗接口属于不可控制的外部依赖；当前只读冒烟已确认字段有效，但后续仍可能受字段、反爬或限流策略变化影响。
- Provider 字段、分页和限流策略可能变化。
- `createUserList` 与 `addListMusics` 非事务性，必须验证失败补偿。
- 本 DEV 的第一阶段仍严格限制为酷狗；四平台支持状态只由 `REQ-20260809-01` 与 `DEV-20260809-01` 的独立验收决定。
