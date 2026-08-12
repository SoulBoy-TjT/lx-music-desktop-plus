---
id: DEV-20260806-01
type: DEV
title: 下载目标解析与任务固化技术方案
status: verified
created_at: 2026-08-06
updated_at: 2026-08-11
owner: KhalilFong
req_ids:
  - REQ-20260806-01
biz_ids:
  - BIZ-20260806-01
  - BIZ-20260811-06
bug_ids:
  - BUG-20260811-07
---

# 下载目标解析与任务固化技术方案

## 关联文档

- 来源需求：[REQ-20260806-01 下载文件曲序命名与专辑目录组织](../requirements/REQ-20260806-01-album-structured-download.md)
- 业务决策：[BIZ-20260806-01 下载曲序命名与专辑目录策略](../decisions/BIZ-20260806-01-album-download-path-and-file-name.md)
- 长名称补充决策：[BIZ-20260811-06 超长歌手与歌曲字段分别省略并预留下载内部文件名空间](../decisions/BIZ-20260811-06-download-long-name-semantic-truncation.md)
- 关联缺陷：[BUG-20260811-07 下载内部文件名超出 Windows 单段上限导致长名称歌曲发布失败](../bugs/BUG-20260811-07-download-internal-artifact-name-too-long.md)
- 相关需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 后续集成决策：[BIZ-20260807-02 歌曲整理跨模块安全与目录兼容策略](../decisions/BIZ-20260807-02-song-organizer-safety-and-directory-compatibility.md)

## 目标与边界

本方案只扩展原生下载任务创建前的元数据、命名和路径解析，不复制或替换音质选择、URL 获取、下载传输、重试、暂停、进度、持久化和关联文件保存逻辑。现有用户默认行为、旧任务和已下载文件保持不变。

## 当前链路与问题

当前任务创建时固化 `fileName`，但将 `filePath` 留空；任务启动时才读取即时设置并通过 `buildSavePath` 计算目录。排队期间修改设置会改变目标路径，数据库恢复后又不保留 `listId`，因此无法稳定恢复按歌单目录。现有 `filterFileName` 也没有覆盖 `..`、Windows 保留名称、尾随点或空格与完整路径长度。

## module 与 interface

在 `src/common/utils/downloadTarget/` 建立纯逻辑 module，只暴露以下能力：

```ts
resolveDownloadTarget(input): DownloadTargetResult
normalizeReleaseDate(value): string | null
sanitizePathSegment(value, options): string
```

输入包含歌曲、实际扩展名、文件命名方式、下载根目录、目录模式和可选歌单名；输出包含最终 `fileName`、`directory`、`filePath` 和结构化 `fallbackReasons`。Renderer 设置页和下载 store 不直接拼接最终磁盘路径。

## 设置与迁移

- 新增 `download.savePathMode: 'root' | 'playlist' | 'album'`，默认 `root`。
- 将设置版本提升到 `2.2.0`；旧 `download.isSavePathGroupByListName=true` 迁移为 `playlist`，否则迁移为 `root`。
- 新增文件命名值 `曲序. 艺术家 - 歌曲名`，原默认值 `歌名 - 歌手` 不变。
- 设置界面使用互斥选择，不保留两个可同时启用的目录布尔开关。

## 元数据模型

在通用歌曲 meta 增加向后兼容的可选字段：

```ts
discographyArtist?: string | null
albumArtist?: string | null
releaseDate?: string | null
trackNumber?: number | null
trackTotal?: number | null
```

酷狗歌手专辑列表保留严格校验后的发布日期；逐专辑详情在既有稳定 Provider 顺序上补充连续 `trackNumber`，并将已确认的抓取目标歌手、专辑艺术家、日期和总曲数写入每首歌曲。该字段随普通歌曲 `meta` JSON 持久化，不从歌单名称截取，也不新增列表数据库字段。普通搜索和旧歌单不做模糊补查，缺失时走回退。

## 命名、目录与回退

- 曲序宽度至少两位，专辑超过 99 首时按总曲数扩展。
- 缺少可靠曲序时，曲序格式回退为 `艺术家 - 歌曲名`。
- 一级目录按“抓取目标歌手 → 专辑艺术家 → 曲目艺术家”选择；普通入口没有抓取目标歌手时从专辑艺术家开始回退。
- 日期不是有效完整日期时省略日期；专辑名缺失时停在艺术家目录；艺术家也缺失时停在根目录。
- 多碟首期只使用详情全局稳定顺序，不增加碟号目录。
- 不生成或更新 `(N首)` 后缀，不在下载完成后移动目录。
- 回退原因按一次任务创建操作聚合提示，不逐曲弹窗。

## 路径安全与冲突

- 动态目录段和文件基名分别处理控制字符、Windows 非法字符、分隔符、`.`/`..`、保留名称和尾随点或空格。
- 使用下载根目录的解析后绝对路径校验最终结果不得逃逸。
- 在保留扩展名和曲序前缀的前提下限制文件名与完整路径长度。
- 文件命名先保留曲序、格式分隔符和扩展名，再为歌手名与歌曲名分配独立可辨识预算；字段超限时在字符边界输出 `...~<hash>`，不能继续从整个基名末尾统一截断。相同输入稳定复现，同前缀但不同原文及深层路径极限缩短后仍保持消歧。
- `src/common/downloadArtifactPaths.ts` 统一定义 `WINDOWS_MAX_PATH_COMPONENT_LENGTH=255`、publication/transfer/FLAC repair/owner 后缀、repair ID 长度和 repair/owner 路径函数。`MAX_DOWNLOAD_FILE_STEM_LENGTH` 按最长 owner 组合反推为 158，下载目标、Main validator 与 Renderer publication 共同使用，确保所有派生文件组件均不超过 Windows 上限。
- 内部后缀常量或组合变化时必须同步更新共享预算及回归样例；Windows 长路径开关不解决单个文件名组件超限，不能作为实现依赖。
- 已存在文件继续遵守 `download.skipExistFile`；同一批新任务解析到同一目标路径时只保留第一项并汇总提示。

## 任务固化与兼容

- Worker 在确定实际音质和扩展名后立即解析最终目标，并把 `fileName`、`filePath` 和回退原因放入下载任务。
- 现有下载表已经持久化 `fileName` 与 `filePath`，不新增表或字段。
- 新任务启动时使用固化 `filePath` 的目录；旧任务 `filePath` 为空时继续使用旧目录算法并写回结果。
- 设置变更不重算非空 `filePath`，歌词继续从音频最终路径派生相同基名。

## 非下载场景兼容

通用 `formatMusicName` 不承担曲序解析。播放器标题和复制歌曲名在选择曲序下载格式时使用可读的既有格式；下载页优先展示任务固化的文件名，避免设置变化或缺少专辑上下文时显示原始模板。

## 验证方案

1. 纯模块测试覆盖完整样例、曲序宽度、全部回退、日期、保留名、尾随字符、路径穿越、长度和同路径冲突；长名称补充覆盖歌手超长、歌曲名超长、两者同时超长以及相同前缀的稳定消歧。
2. 设置迁移测试覆盖旧开关 true/false 与默认值。
3. 歌手专辑测试验证抓取目标歌手、专辑艺术家、发布日期和稳定曲序进入生成歌单。
4. 下载任务测试验证单曲/批量共用固化目标、重启兼容和设置变化不重算。
5. 发布链测试从最长最终目标构造 transfer、publishing、FLAC 规范化和 owner 文件名，逐项验证 Windows 单段预算、真实格式重解析与歌词同基名关系。
6. 执行专题测试、Renderer TypeScript、lint、开发态无缓存编译、Renderer 构建和完整构建。

## 回滚

代码回滚不会移动或删除任何文件。新任务的 `filePath` 仍是既有字段，旧版本可读取；新增歌曲 meta 字段为可选字段，旧代码会忽略；设置回滚只会忽略新目录枚举，不修改用户磁盘内容。

## 实施阶段

- [x] 阶段 1：设置、类型和迁移。
- [x] 阶段 2：下载目标纯逻辑与测试。
- [x] 阶段 3：酷狗专辑元数据传递。
- [x] 阶段 4：任务创建、固化、旧任务兼容与提示。
- [x] 阶段 5：设置 UI、非下载显示兼容、回归和文档收口。

## 实施结果

- 下载设置已使用 `root/playlist/album` 互斥模式，旧布尔设置通过 `2.2.0` 迁移保持原行为；文件命名新增曲序格式但默认值不变。
- `downloadTarget` module 已集中完成日期校验、曲序宽度、文件名和目录回退、Windows 路径清洗、长度控制、根目录逃逸校验与同路径去重。
- 酷狗歌手目录会额外保留 `discographyArtist` 抓取目标歌手，酷狗歌手目录和普通专辑详情均会保留专辑艺术家、完整发行日期、稳定曲序和总曲数；其他入口元数据不足时不补查、不伪造并按批次汇总提示。
- `album` 模式已按 Easy Music 语义改为“按歌手和专辑”：一级目录优先使用 `discographyArtist`，缺失时才使用 `albumArtist` 和曲目艺术家；不解析歌单名称，也不生成 `(N首)` 后缀。
- 新任务在实际音质与扩展名确定后固化 `fileName/filePath`；非空路径不再因设置变化重算，旧空路径任务仍保留原算法。回退原因通过现有 `musicInfo` JSON 的向后兼容附加字段持久化，不变更下载表结构。
- 下载页展示任务固化名称；播放器标题和复制歌曲名在缺少专辑上下文时保持原有可读格式；歌词仍从音频最终路径派生同一基名。
- 初次实现时专题测试为 10 个文件、57 项；Easy Music 存放语义修订后增加到 10 个文件、58 项并全部通过。Renderer TypeScript、三份语言 JSON、全仓库 lint、开发态无缓存编译、Renderer 生产构建和完整构建均通过。
- 2026-08-06 用户使用真实下载结果复测通过：专辑目录名称包含发行时间，歌曲文件名包含稳定曲序，确认元数据已从专辑抓取结果进入下载目标解析和实际落盘路径。
- 2026-08-07 用户确认其余人工验收全部通过：设置重启后保留，设置变化不重算既有任务，不移动已有文件，歌词与音频同目录同基名；本 DEV 更新为 `verified`。
- 2026-08-11 根据 `BIZ-20260811-06` 完成字段级 `...~<hash>` 省略和共享内部后缀预算；真实 Windows public validator 测试以 158 字符基名成功创建长度恰为 255 的 owner 文件并完成有界尾随 FLAC 规范化，验证当前最长内部组件可创建。
- 长名称定向回归 4 个文件、89 项全部通过；全专题 55 个文件通过、1 个文件跳过，466 项通过、1 项跳过。Common、Main、Renderer `tsc --noEmit`、变更文件定向 ESLint、`build:main` 和 `build:renderer` 生产构建均退出 0。深层路径极限缩短回归确认歌手字段仍保留 `...` 且同前缀不同原文不会碰撞。
- `BUG-20260811-07` 收口为 `fixed`。本轮未构建安装包，也尚未在真实 Electron 中重新创建两首长合唱曲任务，原 `verified` 状态表示此前已验收范围，本次补充仍保留独立人工验收边界。

## 后续歌曲整理集成边界

`BIZ-20260807-02` 新增的以下行为由 `DEV-20260806-02` 实施和验证，不冒充为本方案已经完成的结果：

- 新安装用户默认使用按歌手和专辑目录，已有用户继续保留迁移后的原设置。
- 任务创建时复用下载根目录内唯一匹配的 `歌手（N首）` 和 `专辑 (N首)` 目录；多候选时不猜测，使用无后缀目录并汇总提示。
- 歌曲整理重命名目录后，精确更新已完成下载任务的固化路径；未完成任务和下载后处理继续阻塞所属歌手。

上述扩展仍须保持已确认的路径固化、根目录逃逸保护、既有任务不重算和已有文件不自动移动语义。
