---
id: DEV-20260806-02
type: DEV
title: 歌曲文件夹整理技术方案
status: implemented
created_at: 2026-08-06
updated_at: 2026-08-10
owner: KhalilFong
req_ids:
  - REQ-20260806-02
biz_ids:
  - BIZ-20260806-02
  - BIZ-20260806-03
  - BIZ-20260807-02
  - BIZ-20260807-03
  - BIZ-20260808-01
  - BIZ-20260808-02
  - BIZ-20260810-03
  - BIZ-20260810-04
bug_ids:
  - BUG-20260810-04
  - BUG-20260810-05
  - BUG-20260810-06
  - BUG-20260810-07
supersedes: []
---

# 歌曲文件夹整理技术方案

## 关联文档

- 来源需求：[REQ-20260806-02 歌曲文件夹整理与音频可播放性检查](../requirements/REQ-20260806-02-song-folder-organizer.md)
- 导航决策：[BIZ-20260806-02 专辑抓取与歌曲整理独立导航](../decisions/BIZ-20260806-02-album-collection-and-song-organizer-navigation.md)
- 整理决策：[BIZ-20260806-03 歌曲文件夹扫描、清理、计数与重命名规则](../decisions/BIZ-20260806-03-song-folder-organization-rules.md)
- 安全与兼容补充：[BIZ-20260807-02 歌曲整理跨模块安全与目录兼容策略](../decisions/BIZ-20260807-02-song-organizer-safety-and-directory-compatibility.md)
- 工作区交互修订：[BIZ-20260807-03 歌曲整理采用 Easy Music 文件夹整理工作区](../decisions/BIZ-20260807-03-song-organizer-easy-music-workspace.md)
- 启动与布局修订：[BIZ-20260808-01 歌曲整理启动预扫描、清理隔离与工作区排版修订](../decisions/BIZ-20260808-01-song-organizer-startup-prescan-and-layout.md)
- 详情交互修订：[BIZ-20260808-02 歌曲整理移除固定扫描状态并使用详情弹窗](../decisions/BIZ-20260808-02-song-organizer-detail-dialog.md)
- 异常详情修订：[BIZ-20260810-03 歌曲整理详情仅展示异常与阻塞信息](../decisions/BIZ-20260810-03-song-organizer-anomaly-only-details.md)
- 操作反馈修订：[BIZ-20260810-04 歌曲整理操作进度与失败核查留存](../decisions/BIZ-20260810-04-song-organizer-operation-progress-and-failure-retention.md)
- 阻断缺陷：[BUG-20260810-04 Windows 文件身份精度丢失导致歌曲漏计](../bugs/BUG-20260810-04-song-organizer-file-identity-precision.md)
- 操作日志缺陷：[BUG-20260810-05 Windows 操作日志原子替换偶发 EPERM](../bugs/BUG-20260810-05-song-organizer-journal-replace-eperm.md)
- 扫描性能缺陷：[BUG-20260810-06 音频完整解码串行执行导致扫描过慢](../bugs/BUG-20260810-06-song-organizer-serial-validation.md)
- 操作反馈缺陷：[BUG-20260810-07 重命名无进度且操作失败无法再次核查](../bugs/BUG-20260810-07-song-organizer-operation-feedback-loss.md)
- 下载目录方案：[DEV-20260806-01 下载目标解析与任务固化技术方案](DEV-20260806-01-album-structured-download.md)

## 状态与实施前置条件

首版业务规则、无损文件身份、异常详情收敛及 `BUG-20260810-05/06/07` 已实现。操作日志使用有限退避处理 Windows 瞬时替换失败，扫描使用固定并发 2 保持完整解码，重命名进度和会话级操作失败核查已贯通 Main、IPC 与 Renderer。自动化、双端 TypeScript、ESLint 和生产构建通过，方案状态恢复为 `implemented`；真实 Electron 与安装态人工验收仍未完成，因此不进入 `verified`。

1. `REQ-20260805-01` 的 AC-10：最高音质可选、自动降级提示和逐曲实际任务音质人工复测。
2. 固定 BtbN Windows x64 `lgpl` 构建并完成版本、配置、SHA-256、对应源码、许可证、体积和分发方式审计。
3. Windows 回收站、文件身份、重解析点、危险根目录和不同文件系统能力的最小只读/临时目录验证。
4. 下载任务、本地歌曲身份、播放状态和异常恢复日志的更新边界通过只读审计与无副作用测试设计。

2026-08-10 18:44:14.170 的阶段 15 Windows x64 NSIS 安装包已静态确认包含 BigInt 文件身份、异常详情收敛、日志重试、并发扫描、重命名进度与操作异常留存修复。安装器尚未运行，真实 Electron/UI 和实际清理/重命名仍未人工验收，因此 DEV 保持 `implemented`，不进入 `verified`。

## 实现结果

- `src/main/modules/songOrganizer/` 已移除跨扫描校验缓存和 `forceFullValidation`，每次扫描创建独立校验上下文，同一扫描内仍按稳定物理身份去重；扫描阶段同时预检重命名目标冲突，且只阻塞重命名计划。任务 ID 和局部取消控制器在首个异步检查前绑定，旧扫描不能提交快照或广播进度。
- `src/main/modules/songOrganizer/fileIdentity.ts` 统一使用 BigInt stats 读取 Windows 文件身份，以完整 `dev:ino` 生成身份键；Scanner 将 `size`、`nlink` 显式转换为普通数值，并从 `mtimeNs` 的毫秒整数与剩余纳秒分段生成 `mtimeMs`，同时避免不同 64 位 inode 因 `Number` 精度丢失而误去重和时间戳亚毫秒精度丢失。
- Main 在应用初始化后立即发起一次不阻塞主窗口的后台扫描，并监听下载目录与歌曲整理目录设置；即使用户从未打开歌曲整理页，有效根目录变化也会取消旧任务并扫描新目录。统一运行态使用单调 revision 保存进度、完整快照和失败状态，Renderer 先订阅再查询并接管同根任务，不重复扫描。
- `src/renderer/views/SongOrganizer/` 已移除固定扫描状态和详情日志，固定区域只保留无顶部操作的全宽工作区、紧凑“扫描目录”轨道、五列表格、并列状态标签和行级操作；`DetailModal.vue` 统一承载查看详情、清理预览/确认和操作结果，长内容可滚动、可选择复制。
- 详情弹窗状态由独立控制器管理：切换页面会取消尚未确认的清理并关闭弹窗，磁盘操作在其他页面完成时暂存结果并在返回后展示，组件卸载后忽略晚到结果；四项纯状态测试覆盖确认、失活、延迟展示和详情替换时序。
- 普通“查看详情”的文本组装已下沉为纯函数，只输出当前阻塞原因和异常记录；无异常时输出一句简洁提示，不再重复歌手、目标名称和逐专辑正常信息。异常行继续携带相对路径和原因；加入操作进度与异常文案后，简体中文、繁体中文和英文各 1025 个键保持一致。
- 操作日志替换仅对 Windows 瞬时 `EPERM/EACCES` 执行 10/25/50/100 ms 有限退避；持续失败返回首次原始错误、保留旧日志并在磁盘步骤前终止。
- Scanner 使用固定 2 路 worker 并在同一扫描内按稳定物理身份复用校验 Promise；取消或首个校验异常会终止队列并等待在途任务收敛，结果通过精确文本后备比较保持稳定顺序。
- 重命名新增 `song_organizer_operation_progress` 全链，广播准备、执行、回滚、重扫及终态；Renderer 以 `operationId/sourceTaskId/artistPath` 隔离事件并展示真实计数和当前相对目标。
- Renderer 按歌手保留最近一次操作异常覆盖层，自动重扫不清除；同一歌手下一次操作替换旧记录，根目录变化与应用重启清空。运行态协调在同根操作期间保留该覆盖层，避免下载占用触发的空闲事件误清进度。
- `src/renderer/router.ts` 和 `src/renderer/components/layout/View.vue` 只对 Song Organizer 启用路由保活，离开页面后任务监听和状态继续，其他页面不进入全局缓存。
- Main 生成扫描任务 ID，Renderer 只接管相同任务 ID 的进度与终态；Main 同时按任务 ID 与控制器身份拒绝旧扫描覆盖新根目录。清理与重命名 IPC 继续只提交单歌手普通数组，避免响应式 Proxy 的 `DataCloneError`。清理预览分别返回被引用文件数和去重后的受影响歌单数，重命名结果按成功、已回滚、失败和回滚失败准确分组。
- 下载占用已拆分为歌手级重命名阻塞和清理项级保护：活动输出、同基名 `.lrc`、两者的 `.lxmtemp`/`.lxmbackup`、音频 `.lxcover.*` 与其待清理祖先会显示明确占用状态，其他安全歌词仍可预览；执行范围严格取用户确认路径与最新安全预览的交集。Main 在每个清理项和每位歌手重命名前重新读取下载及播放占用，路径引用部分更新失败会先恢复下载记录再回滚目录。
- 下载完成后的标签、封面和歌词处理使用可恢复的持久化中间态并服从统一下载并发上限；MP3、FLAC 与 LRC 的实际落盘完成前任务不会进入完成态，也不会被播放或歌曲整理操作使用。Provider 和封面网络失败按 30 秒 deadline、10 MB 封面上限安全降级，目标文件 I/O 失败释放下载槽并保留可重试状态；应用重启后无需进入下载页面即可恢复。新建、完成或移除任务会使旧整理快照失效并触发 Main 去抖重扫。
- `src/renderer/router.ts` 与 `NavBar.vue` 已把旧工具入口改为“专辑抓取”，增加 Windows x64 门控的“歌曲整理”并兼容旧 `/tools`。
- Windows x64 构建使用固定 BtbN LGPL FFmpeg；开发和打包运行时均只解析受控资源路径，不读取 `PATH`，不在运行时下载。
- 其他平台和架构的既有打包脚本保留，且不携带歌曲整理 FFmpeg 资源。

## 设计目标

- 把目录遍历、音频校验、文件身份识别、回收站清理和重命名放在 Main 侧。
- Renderer 只负责根目录选择、后台扫描运行态接管、行级计划与异常展示、详情弹窗和用户命令；扫描状态不固定渲染。
- 用可替换的 validator、file identity、recycle bin 和 filesystem port 隔离核心规则。
- 将扫描、清理和重命名建模为三个独立任务，不在一次确认中混合删除与改名。
- 所有磁盘修改必须绑定最新完整扫描快照和当前操作歌手；Renderer 即使复用数组型 IPC，也只提交单元素普通数组。

## 平台与资源门控

- 功能可用条件为 `process.platform === 'win32'` 且 `process.arch === 'x64'`。
- Renderer 从 Main 获取能力标志；不支持时不注册或不展示歌曲整理侧边栏入口。
- Windows x64 安装包内置 FFmpeg；开发态和打包态分别解析固定资源路径。
- FFmpeg 不从 `PATH` 隐式选择，不要求用户安装，也不运行时联网下载。
- 校验器资源缺失、不可执行或版本检查失败时返回 `validator_unavailable`，不得把全部歌曲标为损坏。
- 使用 FFmpeg 官方下载页推荐来源中的固定 BtbN Windows x64 `lgpl` 构建，只携带 `ffmpeg.exe`，不使用 GPL/nonfree 变体。
- 资源接入前记录许可证、来源、版本、构建提交、配置、SHA-256、对应源码、压缩前后体积和安装包增量，并随发行物提供所需许可证与源码说明。

## 模块边界

建议新增深 module：

```text
src/main/modules/songOrganizer/
  index.ts               # 对外只暴露 scan/cancel/cleanup/rename
  scanner.ts             # 层级发现、路径边界、统计和扫描快照
  audioValidator.ts      # AudioValidator port 与 FFmpeg adapter
  fileIdentity.ts        # 硬链接身份与稳定保留路径
  cleanupPlanner.ts      # 纯逻辑生成清理预览
  cleanupExecutor.ts     # 回收站操作、重验证和逐项结果
  renamePlanner.ts       # 纯逻辑生成后缀、冲突和歌手级计划
  renameExecutor.ts      # 歌手隔离执行、引用更新、有限重试和回滚
  operationJournal.ts    # 最小持久化步骤日志与异常中断恢复检查
  downloadOccupancy.ts   # 未完成任务、后处理与已完成任务路径 port
  localMusicRefs.ts      # 本地歌曲 ID、songId、filePath 与缓存索引 port
  playbackGuard.ts       # 当前播放文件保护
  taskRegistry.ts        # 任务 ID、当前 runner 与退出回收
  types.ts

src/renderer/views/AlbumCollection/
  index.vue               # 迁移现有 Tools 视图或兼容导出

src/renderer/views/SongOrganizer/
  index.vue
  useSongOrganizer.ts     # 页面状态机和 IPC 适配
```

`scanner` 不依赖 Vue、路由或下载 store；planner 不执行磁盘写入；executor 不负责页面提示。下载和本地歌曲状态通过窄 port 注入，歌曲整理不得直接依赖 Renderer store。`artistDiscography` 不依赖歌曲整理 module；`downloadTarget` 只通过独立的数量后缀目录解析器复用已整理目录，不反向依赖扫描任务。

## 设置模型

通过统一设置机制保存歌曲整理目录来源，语义为：

```ts
interface SongOrganizerSetting {
  useCustomRoot: boolean
  customRoot: string
}
```

- `useCustomRoot=false` 时每次读取当前下载根目录，不复制一份可能过期的默认路径。
- `useCustomRoot=true` 时使用持久化的 `customRoot`。
- 页面不暴露布尔开关，使用“选择指定目录”和“使用下载目录”更新以上字段。
- 应用启动时在设置、数据库、IPC 和主窗口初始化后解析上述有效目录，并以 fire-and-forget 方式发起一次后台扫描；不得等待扫描完成后才显示窗口。
- 成功选择指定目录或切回下载目录时清空旧结果并自动扫描；取消选择保持原字段和结果不变。
- 使用下载目录期间，如果设置页修改下载路径，则歌曲整理运行态监听按根目录变化清空并自动扫描，不依赖再次激活页面。
- 设置只保存路径模式，不保存扫描快照、异常清单或操作结果。

具体字段命名在实施时沿用现有 `app_setting` 类型和迁移方式，不为此新增数据库表。

同时把新安装的 `download.savePathMode` 默认值改为 `album`；设置迁移必须区分新安装和已有配置，已有用户继续保留 `root/playlist/album` 当前值。歌曲整理不为非 `album` 模式增加目录结构提示。

## 数据模型

```ts
type AudioCheckStatus =
  | 'pending'
  | 'checking'
  | 'playable'
  | 'unplayable'
  | 'check_failed'
  | 'cancelled'

type AnomalyType =
  | 'unplayable_audio'
  | 'audio_check_failed'
  | 'unsupported_file'
  | 'duplicate_hardlink'
  | 'reparse_point'
  | 'empty_directory'
  | 'operation_failed'

interface ScannedFile {
  id: string
  path: string
  relativePath: string
  artistPath: string
  albumPath?: string
  ext: string
  size: number
  fileIdentity?: string
  audioStatus?: AudioCheckStatus
  errorCode?: string
  errorMessage?: string
}

interface FolderSummary {
  path: string
  discoveredAudioCount: number
  playableCount: number
  unplayableCount: number
  checkFailedCount: number
  unsupportedFileCount: number
}

interface SongOrganizerSnapshot {
  taskId: string
  root: string
  status: 'scanning' | 'complete' | 'partial' | 'cancelled' | 'failed'
  checkedCount: number
  totalAudioCount: number
  artists: Array<FolderSummary & { albums: FolderSummary[] }>
  anomalies: SongOrganizerAnomaly[]
  cleanupPlan: CleanupPlan
  renamePlan: ArtistRenamePlan[]
}

interface OperationResult {
  taskId: string
  type: 'cleanup' | 'rename'
  succeeded: OperationStepResult[]
  skipped: OperationStepResult[]
  failed: OperationStepResult[]
  rollbackFailed: OperationStepResult[]
}
```

Renderer 只接收异常项目和文件夹汇总，不接收正常文件的完整展示列表。Main 可在当前任务生命周期内保留完整内部快照，但不得跨重启持久化。

内部快照还需要维护根目录能力、下载占用和本地引用；这些字段只通过最小视图暴露给 Renderer：

```ts
interface RootCapabilities {
  stableFileIdentity: boolean
  recycleBin: boolean
  rename: boolean
}

interface ArtistOperationBlocker {
  artistPath: string
  type: 'download_task' | 'download_postprocess' | 'playing_local_file'
  relatedIds: string[]
}

interface SongOrganizerRuntimeState {
  status: 'idle' | 'scanning' | 'complete' | 'cancelled' | 'failed'
  taskId?: string
  root?: string
  progress?: SongOrganizerProgress
  snapshot?: SongOrganizerSnapshot
  errorMessage?: string
}
```

`SongOrganizerRuntimeState` 是 Main 对单一当前扫描任务的可结构化克隆运行态。Service 在首个异步检查前绑定任务 ID 和局部取消控制器，保存最近进度和终态；Renderer 先订阅状态变化，再查询当前状态，同根目录进行中任务只接管、同根目录完成任务直接采用，只有根目录不一致时才发起新扫描。

## 扫描与目录模型

```text
选择或解析根目录
  -> Main 规范化并验证根目录
  -> 拒绝卷根、共享根、系统目录、应用目录及危险包含路径
  -> 检测文件身份、回收站与重命名能力
  -> 只枚举根目录的直接子目录作为歌手
  -> 忽略根目录直属文件
  -> 歌手直接子目录作为专辑，更深目录只递归统计
  -> 识别重解析点但不跟随
  -> 冻结 MP3/FLAC 校验总数
  -> 识别文件身份和重复硬链接
  -> 识别下载任务、后处理和当前播放占用
  -> 在本次扫描内按物理文件身份去重并受控并发执行完整解码
  -> 汇总唯一物理音频计数和异常
  -> 生成只读清理计划与重命名计划
  -> Renderer 展示完整快照
```

- 使用 `lstat` 和 Windows 文件属性识别符号链接、目录联接及其他重解析点。
- 使用可测试的 `FileIdentityPort` 取得卷与文件身份；Windows `lstat` 必须启用 `bigint`，以精确 `dev:ino` 字符串形成身份键，不能先经过 JavaScript `number` 舍入，也不能只按规范化路径判断硬链接。
- `size`、`nlink` 在 BigInt stats 边界显式转换为现有普通数值字段；`mtimeMs` 从 `mtimeNs / 1_000_000n` 的整数毫秒和余数分别转换后相加，保留亚毫秒精度。Renderer 与 IPC 数据模型保持不变，身份键自身禁止转换为 `number`。
- 所有路径在发现、计划和执行三个阶段分别校验仍位于根目录及目标歌手内。
- 扫描顺序按歌手、专辑和相对路径进行中文数字自然排序，结果不受并发完成顺序影响。
- 只有目录枚举完整结束的快照才能修改磁盘；单文件检查失败不降低枚举完整性。
- 可读根目录的单项能力缺失不阻断扫描，只禁用依赖该能力的清理或重命名步骤。
- 被下载任务或后处理占用的音频不执行解码，所属歌手的重命名进入操作阻塞；清理不使用该歌手级阻塞，执行前按规范化实际任务目标及其派生 `.lrc` 路径逐项保护。当前播放文件同样只按实际目标粒度跳过清理，但阻塞所属歌手重命名。

## 音频验证器

```ts
interface AudioValidator {
  validate(filePath: string, signal: AbortSignal): Promise<AudioValidationResult>
}
```

FFmpeg adapter 使用等价于以下参数的全文件解码：

```text
ffmpeg -v error -nostdin -i <file> -map 0:a:0 -f null -
```

- 正常启动、未超时、未取消且退出码为 0 才标记为可播放。
- 能确认格式或音频数据错误时标记 `unplayable`。
- 权限、占用、超时、文件变化和单文件 runner 异常标记 `check_failed`。
- 校验器整体不可用时任务失败或部分失败，不生成可执行计划。
- 超时和并发默认值通过合法/损坏/长音频样例性能测试确定，首期不暴露设置项。
- 取消或超时必须终止对应子进程；应用退出时统一回收全部子进程。
- 每次启动、目录触发或操作后扫描都创建新的单次扫描校验上下文并完整解码，不读取上一次扫描结果；同一扫描中具有相同稳定物理身份的硬链接复用一次解码结果。
- 扫描器使用固定 2 个 worker 消费唯一物理音频队列；每个身份的 Promise 在单次扫描 Map 中只建立一次，收集结果后再按原始稳定顺序组装快照。并发完成顺序不得改变计数、异常归属或 UI 顺序。

## 硬链接与重解析点

### 硬链接

1. 按文件系统身份分组；专辑计数在单专辑范围去重，歌手总数在整个歌手范围去重。
2. 跨歌手、歌手根目录与专辑之间、不同专辑之间的硬链接组始终阻塞自动清理并展示全部路径。
3. 只有同一专辑范围内的重复硬链接进入清理计划；专辑内部更深目录仍属于该专辑。
4. 保留路径优先选择完整解码且扩展名匹配实际格式的 MP3/FLAC，再按相对层级、路径长度和中文数字自然顺序选择。
5. 清理执行前重新读取全部链接身份并确认至少保留一个路径。
6. 普通内容相同文件不计算哈希，不进入重复清理。
7. 跨专辑硬链接存在时允许专辑曲数之和大于歌手总数，Renderer 显示该计数解释。

### 重解析点

1. 扫描记录链接路径和可安全取得的目标摘要，但不进入目标。
2. 清理计划只包含链接入口，不包含目标内容。
3. 执行前再次确认仍是重解析点；无法证明只移除入口时跳过。
4. 结果明确区分链接入口和目标，避免用户误解。

## 一键清理计划与执行

建议建立：

```ts
interface RecycleBinPort {
  trash(path: string): Promise<void>
}
```

执行流程：

1. Renderer 提交完整快照 `taskId` 和当前歌手路径；现有数组型 IPC 只接收包含该路径的单元素普通数组。
2. Main 验证快照仍为当前 `complete` 快照，并重新验证当前歌手边界。
3. 生成预览：同一专辑内重复硬链接的保留/清理路径、所有非 MP3/FLAC、重解析点和预计空目录。
4. Main 实时读取未完成下载与后处理任务，按规范化路径从预览中排除实际输出、同基名 `.lrc`、两者的 `.lxmtemp`/`.lxmbackup`、音频 `.lxcover.*` 及其待清理祖先目录；不得因歌手存在下载任务而排除整位歌手的其他安全目标。
5. Renderer 展示数量、标称总大小和完整清单，标记本地歌单引用、当前播放文件和能力降级原因，使用既有 Dialog 二次确认；不得把回收站移动或硬链接入口移除宣传为立即释放空间。
6. Renderer 将用户确认的普通字符串路径列表随执行请求提交。Main 重新生成最新安全集合，并只执行“确认路径集合 ∩ 最新安全集合”；页面输入不得新增快照外目标，下载状态变化也不得扩大已确认范围。
7. Main 逐项重新检查路径、文件身份、类型和选择范围；变化项和当前播放文件跳过。其余重复硬链接路径、非 MP3/FLAC 和重解析点入口移入回收站；本地歌单引用只警告，不自动修改条目。
8. 再从最深层检查空目录；只把已经确认、执行时仍安全且真正为空、不是根目录或歌手目录的项移入回收站。
9. 回收站不可用或操作失败时记录失败，不永久删除，不把非空目录伪装为已清理。
10. 执行开始后不接受取消；完成后返回逐项结果并触发全量重新扫描。

清理开始前写入最小操作日志并阻止正常退出；每个回收站结果逐步记入日志。异常中断后只展示已完成和未处理项目，不自动继续，也不由应用直接恢复回收站内容。

日志 writer 继续由 Service 单操作注册表串行调用。临时文件写完后替换正式日志若返回 Windows 瞬时 `EPERM/EACCES`，按短退避做有限次重试；持续失败原样返回并在首个磁盘步骤前终止。不得通过删除正式日志、降低目录权限或忽略持久化错误来换取继续执行。

清理失败后仍含非音频文件且没有 MP3/FLAC 的专辑进入阻塞状态，所属歌手不得重命名。

## 重命名计划与执行

1. 从歌手名称末尾剥离严格匹配的 `（\d+首）`。
2. 从专辑名称末尾剥离严格匹配的 `\s\(\d+首\)`。
3. 按唯一物理 MP3/FLAC 计数生成 `歌手（N首）` 和 `专辑 (N首)`。
4. 空歌手生成 `歌手（0首）`；空的非歌手目录由清理流程处理。
5. Renderer 在歌手行展示歌手目标名称，逐专辑目标只保留在重命名计划中；普通“查看详情”不重复展示歌手或专辑正常目标。不提供复选框、批量操作或单专辑选择。
6. 点击当前行“重命名”后直接调用 Main，不再弹二次确认。
7. Main 对每个歌手单独完成全量预检；任一冲突或阻塞会跳过整个歌手。
8. 对可执行歌手先从深层专辑开始重命名，再重命名歌手目录。
9. Windows 临时占用错误进行有限重试；中途失败停止当前歌手并按逆序回滚。
10. 其他歌手继续执行；结果返回最终真实路径和回滚状态。
11. 执行开始后不接受取消；完成后触发全量重新扫描。
12. Main 在准备、执行和回滚阶段广播结构化操作进度；`completed/total` 只统计计划中的真实重命名步骤，`currentRelativeTarget` 使用当前根目录内相对路径。终态必须覆盖进行中状态。

不得跨盘移动、合并目录、覆盖目标或删除歌手目录。大小写或规范化名称相同的特殊重命名必须使用经过临时目录测试验证的安全步骤。

重命名前还必须确认目标歌手没有未完成下载、下载后处理或当前播放的本地歌曲。执行日志逐步记录目录变更、已完成下载任务 `filePath` 变更，以及本地歌曲 `id/meta.songId/meta.filePath` 和相关缓存索引变更；每个磁盘步骤与引用更新形成可逆单元。异常中断后只展示实际状态，由用户选择是否尝试回滚。

## 下载目录兼容

在 `downloadTarget` 边界增加纯目录候选解析能力：

```ts
interface OrganizedDirectoryResolver {
  resolveUniqueArtistDirectory(root: string, baseName: string): Promise<DirectoryMatch>
  resolveUniqueAlbumDirectory(artistPath: string, baseName: string): Promise<DirectoryMatch>
}
```

- 只在已经验证的下载根目录及目标歌手目录内枚举直接子目录。
- 严格剥离末尾 `（\d+首）` 或 `\s\(\d+首\)` 后比较规范化基名。
- 唯一候选返回其真实路径；无候选继续使用无后缀目录；多候选返回冲突并让任务创建按批次汇总提示。
- 不读取后缀数字作为真实数量，不修改已创建任务，也不移动已有文件。

## IPC 与任务生命周期

建议新增类型化事件：

- `song_organizer_capability_get()`
- `song_organizer_scan_start({ root })`
- `song_organizer_scan_progress`
- `song_organizer_operation_progress`
- `song_organizer_snapshot_get(taskId)`
- `song_organizer_state_get()`
- `song_organizer_state_changed`
- `song_organizer_cleanup_preview({ taskId, artistPaths })`
- `song_organizer_cleanup_apply({ taskId, artistPaths, confirmedItemPaths })`
- `song_organizer_rename_apply({ taskId, artistPaths })`
- `song_organizer_recovery_get()`
- `song_organizer_recovery_rollback(operationId)`
- `song_organizer_recovery_dismiss(operationId)`

文件定位继续复用 `open_dir_in_explorer`，其语义为在父目录中选中传入路径；Main 必须再次验证路径属于当前根目录。Main 同时只维护一个当前扫描 runner；新扫描开始前取消旧 runner。清理和重命名执行期间禁止开始新扫描，避免快照在磁盘操作中被替换。快速切换根目录时，Renderer 还必须按任务 ID 和根目录忽略旧扫描进度与结果。

`song_organizer_operation_progress` 至少携带 `operationId`、`sourceTaskId`、`type`、`artistPath`、`phase`、`completed`、`total` 与可选 `currentRelativeTarget`。Renderer 以当前 operationId、sourceTaskId 与 artistPath 三重过滤事件；旧操作、其他歌手和根目录变化前的事件全部忽略。

应用启动链在 `initAppSetting()`、`registerModules()` 与 `app_inited()` 完成后调用歌曲整理启动器。启动器仅在 Windows x64 能力范围内解析当前有效目录，以 fire-and-forget 方式调用 Service，拒绝结果写日志但不阻塞窗口。Service 在 `idle/scanning/complete/cancelled/failed` 间更新统一运行态并广播普通对象；旧任务只有同时匹配任务 ID 和局部控制器身份时才能提交进度、快照或终态。按后续 `BIZ-20260811-05` 修订，应用退出时不取消当前扫描或检查，而是统一提示等待任务完成；内部中止仅用于异常收敛、任务替换和自动化测试。

正常退出流程必须查询操作注册表；存在清理或重命名 runner 时拒绝退出并显示进行中状态。强制终止、崩溃或断电无法拦截，由持久化操作日志在下次启动时进入只读恢复页。

歌曲整理 route 单独使用 Vue `KeepAlive`（或等价的页面级状态容器），其他页面不因此被全局缓存。页面失活时继续监听扫描、清理和重命名任务，激活后采用最终结果；详情弹窗只由用户“查看详情”或磁盘操作打开，失活时关闭，磁盘操作在其他页面完成时暂存到返回后再显示，后台预扫描和自动重扫不得主动弹窗。应用重启后不恢复。

同根目录扫描开始时，Renderer 将现有完整结果保留为只读展示并立即禁用磁盘操作；新扫描完整结束后替换并重新启用。取消或失败继续显示旧结果和本次状态。根目录变化时清空旧快照、详情和可操作标志，并等待 Main 广播新根运行态，不从 Renderer 重复 invoke 扫描。页面挂载时先订阅 `song_organizer_state_changed`，再读取 `song_organizer_state_get`：同根任务进行中只接管，同根完整快照直接采用，空闲、失效或根目录不一致时等待 Main 的启动/配置扫描，从而覆盖启动扫描早于或晚于 Renderer 装载的两种时序。

## UI 方案

### 专辑抓取

- 现有 `Tools` 页面更名为“专辑抓取”，业务流程保持不变。
- 推荐路由 `/album-collection`、route name `AlbumCollection`；旧 `/tools` 重定向。

### 歌曲整理

- Windows x64 新增 `/song-organizer`、route name `SongOrganizer`；其他平台/架构隐藏入口。
- 未完成操作恢复警告位于主工作区上方，继续独立展示恢复、回滚或忽略入口。
- 主工作区使用一张无阴影的全宽内容面板；标题行只保留标题和说明，不提供顶部“扫描”或“打开目录”。
- “扫描目录”轨道展示标签、可省略的普通路径文本、“选择指定目录”和“使用下载目录”；路径不使用实心主色输入框。
- 目录轨道下方直接进入五列表格，不渲染固定扫描状态、进度、当前文件、取消入口或最近详情容器。扫描运行态只用于接管快照、禁用目录切换和磁盘操作以及淘汰旧任务。
- 主结果固定为“歌手文件夹、歌曲数、目标名称、状态提示、操作”五列；表格填充剩余高度、内部滚动且表头吸顶，移除汇总卡、异常卡、筛选器、复选框和批量操作栏。
- 每行操作为“清理”“重命名”“查看详情”“打开文件夹”。清理保留预览和二次确认；重命名直接执行；打开文件夹使用 `showItemInFolder` 类语义在父目录中选中歌手目录。
- “状态提示”同时容纳待清理、待重命名、音频异常、清理受阻、重命名受阻和操作受阻标签；下载占用但存在安全清理项时显示“待清理 + 重命名受阻”，部分清理目标受保护时使用“清理受阻”，仅两类操作均被阻塞时使用泛化“操作受阻”。无清理目标时禁用清理，无重命名步骤或受下载、播放、冲突、能力限制时禁用重命名，原因必须可见。“打开文件夹”保持可用。
- “查看详情”打开只读详情弹窗，只组装阻塞原因和异常记录；两者都为空时显示一句“未发现异常或操作阻塞。”。清理预览和二次确认在同一个详情弹窗完成；清理、重命名和恢复操作的成功、失败、跳过、阻塞及回滚结果在操作结束后使用同一弹窗反馈。
- 用户触发重命名后立即显示操作进度，展示阶段、真实 `completed/total` 和当前相对路径；回滚阶段使用独立文案。操作完成后以终态结果替换进行中内容。
- Renderer 维护 `Map<artistPath, OperationFailure[]>` 作为当前根目录会话覆盖层：从清理/重命名终态提取失败、回滚失败和异常跳过；自动重扫保留，同一歌手下一次操作先替换，根目录变化或组件会话重建时清空。普通详情将该覆盖层追加到扫描阻塞与异常之后，成功步骤不进入。

视觉实现采用两遍设计约束：

1. 令牌与骨架：颜色只使用 LX Music 现有语义内容背景、按钮背景、列表分隔、主色、警告色和错误色变量；禁止把实际为高不透明度的 `--color-primary-alpha-100/200` 用作大面积浅色背景。字体和控件沿用现有应用层级；全宽内容面板、扫描目录轨道和高密度表格构成固定布局，详情弹窗作为唯一覆盖层。
2. 自检与收敛：删除通用统计卡片、独立异常面板和批量选择区，避免多个视觉焦点；不新增固定十六进制主题色、渐变、装饰标题或与文件整理无关的展示元素；通过吸顶表头、合理列宽和内部滚动保证大目录可读性。

```text
[未完成操作恢复警告]
┌─ 歌曲整理（标题与说明）──────────────────────────────────────┐
│ 扫描目录  当前路径................. [选择指定目录] [使用下载目录] │
│ ┌ 歌手文件夹 │ 歌曲数 │ 目标名称 │ 状态提示 │ 操作 ┐          │
│ │ ... sticky header / internal scroll ...           │          │
│ └───────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────┘

                         [按需详情 / 清理确认 / 操作结果弹窗]
```

页面状态：

```text
idle -> discovering -> validating -> ready
          |               |          |-> cleanup_preview -> cleaning -> rescanning -> ready
          |               |          |-> renaming -> rescanning -> ready
          |               |          |-> operation_failed
          |               |-> partial
          |               \-> cancelled
          \-> failed
```

## 错误模型

稳定错误码至少包括：

- `unsupported_platform`
- `root_not_found`
- `root_not_directory`
- `root_permission_denied`
- `path_outside_root`
- `file_changed`
- `file_read_failed`
- `validator_unavailable`
- `decode_failed`
- `decode_timeout`
- `duplicate_hardlink`
- `hardlink_cross_selection`
- `reparse_point_changed`
- `reparse_point_unsafe`
- `recycle_bin_unavailable`
- `trash_failed`
- `scan_cancelled`
- `target_exists`
- `rename_busy`
- `rename_permission_denied`
- `rename_rollback_failed`

错误文案必须区分音频损坏、检查失败、扫描不完整、回收站不可用和重命名失败。

## 测试方案

### 单元测试

- Easy Music 歌手/专辑后缀生成与严格剥离幂等性，包括空歌手 `0首`。
- 根目录直属文件忽略、歌手/专辑层级、深层目录递归计数。
- 可播放、无法播放、检查失败和校验器整体不可用映射。
- 文件身份分组、稳定保留路径、跨歌手/跨专辑硬链接阻塞、同专辑硬链接清理和普通重复文件不判重。
- 构造两个精确 `bigint ino` 不同但 `Number(ino)` 相等、`nlink=1` 的普通文件，验证分别计数且不产生硬链接异常；既有真实硬链接用例继续只计一次。
- 详情文本组装覆盖“正常专辑存在但无异常”“只有阻塞”“只有异常”“阻塞与异常并存”，确认不输出歌手汇总、目标名称或逐专辑正常信息。
- 清理计划只包含当前行歌手，根目录和歌手目录永不删除。
- 重解析点不跟随，安全入口与不安全入口正确区分。
- 歌手级冲突隔离、专辑先行、回滚成功和回滚失败。

### 集成测试

- 临时目录构造多歌手、多专辑、歌曲直放歌手目录、根目录直属文件、空歌手和深层碟号目录。
- 小型合法、截断、零字节、扩展名伪装 MP3/FLAC 固定样例。
- 注入验证器覆盖成功、损坏、占用、超时、取消和 runner 不可用。
- 在支持的 Windows 临时卷验证真实硬链接身份、链接删除至少保留一个路径。
- 注入回收站 port 覆盖成功、不可用、文件变化和部分失败；不得在测试中永久删除用户文件。
- 符号链接/目录联接不跟随，清理只影响链接入口。
- 清理后空目录、歌手目录保护、自动重扫和操作结果保留。
- IPC 旧任务进度不覆盖新任务，磁盘操作期间拒绝新扫描。
- 跨歌手、跨专辑和同专辑硬链接分别覆盖阻塞、保留和清理；验证各专辑计数与歌手总数按范围去重。
- 未完成任务、下载后处理、已完成任务路径和当前播放文件使用注入 port 覆盖歌手隔离、单项跳过、同步更新和回滚。
- 同歌手存在活动下载时，安全旧 `.lrc` 仍进入预览；活动音频、同基名 `.lrc` 及其待清理祖先目录被排除，重命名仍保持歌手级阻塞。
- 清理执行覆盖确认路径与最新安全路径求交集：确认后任务状态变化只能缩小范围，不能把未确认项目加入执行。
- 本地歌曲引用覆盖 `id/meta.songId/meta.filePath`、缓存索引、多个歌单引用和路径前缀边界。
- 连续两次启动/显式任务、目录切换和操作后重扫都重新调用校验器；同一扫描内相同稳定物理身份只调用一次。
- 操作日志覆盖正常完成清除、逐步写入、异常中断检测、只读展示、回滚成功和回滚失败。
- 操作日志覆盖瞬时 `EPERM/EACCES` 恢复、持续失败有限终止、旧日志保留和磁盘步骤零调用。
- 扫描性能测试断言 6 个固定延迟校验峰值并发为 2、调用数仍为 6；硬链接单次复用、跨扫描重新校验、取消、首个异常和稳定排序边界继续覆盖。
- 新安装默认 `album`、已有用户迁移保留，以及唯一/无/多个数量后缀候选的下载目录解析。

### UI、打包与人工验收

- Windows x64 显示入口，其他平台能力标志下隐藏入口。
- “选择指定目录”“使用下载目录”、持久化和取消选择符合规则；启动后台预扫描不阻塞窗口，页面接管同根运行态且不重复扫描，根目录变化自动扫描。
- 无顶部“扫描/打开目录”、无固定扫描状态与最近详情、扫描目录轨道、固定五列、吸顶表头、内部滚动、LX 语义主题变量和独立恢复警告符合设计。
- 大目录扫描时窗口可操作；切换路由后任务继续，返回采用最终结果，其他页面不被全局缓存。
- 同根目录扫描取消或失败保留旧结果但禁用磁盘操作；根目录变化清空旧表格和详情，旧任务事件不覆盖新根目录。
- “查看详情”使用可滚动、可选择复制的弹窗，只显示异常与阻塞，无异常时显示一句简洁提示；清理预览在弹窗内确认，清理、重命名和恢复结果自动弹出，后台预扫描与自动重扫不主动弹窗。
- 歌手目录能在 Windows 资源管理器中定位目标本身；歌手操作不会直接进入歌手目录。
- 行按钮按清理目标、重命名计划、逐项下载/播放保护、冲突和快照有效性正确禁用；只阻塞重命名时使用明确文案，“打开文件夹”始终可用。
- 清理预览、回收站恢复、回收站不可用跳过和非永久删除。
- 重命名预览后直接执行、按歌手隔离、失败回滚和自动重扫。
- 重命名准备、逐步执行、回滚与终态进度可见；清理失败自动重扫后普通详情仍可核查，下一次操作和根目录变化正确清理旧记录。
- Windows x64 开发构建与安装包均能解析内置 FFmpeg 路径。
- 本地 NTFS、移动磁盘、能力不足文件系统和 UNC 音乐子目录分别验证扫描、文件身份、回收站与重命名降级；卷根、共享根和系统/应用危险目录被拒绝。
- 清理或重命名期间正常退出被阻止；模拟异常中断后只展示恢复信息，不自动继续磁盘修改。

## 实施顺序

1. 完成 `REQ-20260805-01` 的 AC-10 人工复测并收口状态。
2. 完成固定 BtbN LGPL FFmpeg、回收站、硬链接、重解析点、危险根目录和不同文件系统能力审计，记录许可证与验证证据。
3. 建立类型、目录模型、计数、硬链接和重命名纯逻辑 module，先完成无副作用测试。
4. 建立下载占用、本地歌曲引用、播放保护和操作日志 port，并验证引用变更的事务/回滚边界。
5. 实现 Main 安全扫描 runner、FFmpeg 校验、进度、取消、单次扫描物理身份去重和任务隔离。
6. 实现清理预览、引用警告、回收站 executor、空目录保护、操作日志和自动重扫。
7. 实现歌手级重命名、冲突预检、路径引用同步、异常恢复、回滚和自动重扫。
8. 实现新安装默认值、数量后缀目录复用和歌曲整理设置；按 `BIZ-20260807-03` 改造独立页面、行级操作、最近详情、路由保活和文件定位。
9. 按 `BIZ-20260808-01` 增加启动后台预扫描与统一 Main 运行态，拆分清理/重命名下载保护，并收敛扫描目录、审计带与主题样式。
10. 迁移“工具”为“专辑抓取”，增加 Windows x64 平台门控和旧路由兼容。
11. 运行专题测试、类型检查、lint、构建、Windows x64 安装包和人工验收。
12. 同步 REQ、DEV、BUG（如有）和 PROG 的证据、风险及遗留项。
13. 按 `BIZ-20260810-03` 收敛普通详情组装，并按 `BUG-20260810-04` 将 Windows 文件身份读取改为无损 `bigint`；先运行确定性精度碰撞回归，再用原只读目录核对 199 首结果。
14. 按 `BIZ-20260810-04` 修复操作日志瞬时替换失败，使用固定并发 2 完整解码，增加重命名数值进度和会话级操作失败核查；分别保留 RED→GREEN、真实 199 首和安装态边界证据。
15. 重新构建 Windows x64 NSIS 安装包，静态核对阶段 14 Main/Renderer 代码、随包 FFmpeg、许可证与 native 模块，并保留未签名、未运行安装器和未执行真实磁盘操作的边界。

阶段 14 已完成代码与自动化闭环：Song Organizer 12 个文件、67 项测试通过，`npm run test:artist-discography` 为 41 个文件、284 项通过；Main/Renderer TypeScript、19 个相关文件定向 ESLint及全量 lint 均通过。首轮 production build 暴露 Vue 模板对可选进度对象未正确收窄，改为非可选 computed 展示值后复跑 `npm run build`，四套 webpack 均成功，总耗时 48.872 秒。三语各 1025 个键，其中 Song Organizer 110 个键，键集与占位符一致。

阶段 15 已完成重新打包与静态入包核对：执行带 `LX_SKIP_WIN_EXECUTABLE_EDIT=true` 的 `npm run pack`，退出码 0，完整构建 46.015 秒、总命令 99.9 秒；当前 Setup 为 142,577,852 bytes，SHA-256 `AE0E7D52DB0D7CDA3B75B9F0B1ECBB96EC91D2A506E1D01772D0F350AB067C00`。`7za t` 返回 `Everything is Ok`；`app.asar` 为 33,415,180 bytes，SHA-256 `6F045E9B8FD9F2B6D34D7C3B53AB4D93EEA219E8D27F455E9CB37F1FD3D2AB9E`，Main bundle 与 Renderer source map 中日志重试、固定并发 2、进度事件/监听、同根操作态保留、操作异常组装和进度 UI 标志均命中。FFmpeg、LICENSE/NOTICE 和 native 模块验证通过；Setup 与 unpacked exe 均未签名。真实 Electron 点击、安装器运行和实际清理/重命名仍未验证。

## 回滚与数据安全

- 功能代码回滚不移动或删除用户现有音乐目录。
- 新设置字段为向后兼容可选字段，旧代码忽略。
- 删除能力只通过回收站 port 执行，不提供永久删除分支。
- 已进入回收站的数据由用户通过 Windows 回收站恢复；应用不自建备份或恢复格式。
- 某歌手重命名失败时只回滚该歌手的本次步骤，不触碰其他歌手。
- 平台能力门控可以独立关闭歌曲整理入口，不影响专辑抓取、下载或播放。
- 已完成下载任务与本地歌曲路径引用属于同一重命名步骤，必须随磁盘路径一起提交或回滚。
- 异常中断日志只用于检测、展示和用户确认后的回滚，不能在应用启动时自动执行磁盘修改。
