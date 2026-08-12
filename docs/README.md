# 项目文档约定

本目录维护功能需求、业务决策、技术方案、缺陷和每日进度。仓库根目录 `AGENTS.md` 中的 PRD 对应这里的 `REQ`；具体业务内容不得写入 `AGENTS.md`。

## 文档类型

| 类型 | 目录 | 命名格式 | 用途 |
| --- | --- | --- | --- |
| REQ | `requirements/` | `REQ-YYYYMMDD-XX-*.md` | 定义范围、用户场景、业务规则和验收标准 |
| BIZ | `decisions/` | `BIZ-YYYYMMDD-XX-*.md` | 记录与 REQ 关联的业务选择及其取舍 |
| DEV | `designs/` | `DEV-YYYYMMDD-XX-*.md` | 定义 module、interface、seam、阶段、兼容和验证方案 |
| BUG | `bugs/` | `BUG-YYYYMMDD-XX-*.md` | 记录实施或审查中发现的真实缺陷 |
| PROG | `progress/` | `PROG-YYYYMMDD.md` | 每日唯一进度日志，记录证据、阻塞和下一任务 |

文件名中的日期使用 `Asia/Shanghai` 当地日期；`XX` 在同一天、同一文档类型内从 `01` 递增且不得重复。文件创建后不得因标题或状态变化而改名。

## 必填文件头

所有文档使用 YAML front matter：

```yaml
---
id: REQ-20260805-01
type: REQ
title: 示例需求
status: draft
created_at: 2026-08-05
updated_at: 2026-08-05
owner: KhalilFong
---
```

附加字段规则：

- `BIZ`、`DEV`、`BUG` 必须提供非空的 `req_ids`。
- `PROG` 必须提供非空的 `req_ids`；当天处理 BUG 时还必须提供 `bug_ids`。
- `BUG` 必须同时区分 `discovered_in_req_id` 与 `introduced_by_req_id`。既有代码缺陷的后者为 `null`，不得错误归因给当前 REQ。
- `BIZ` 完整替代旧决策时使用 `supersedes`，并将旧决策更新为 `superseded`；只调整旧决策的局部条款时使用 `amends`，在正文中精确说明被修订章节，旧决策其余内容和状态保持不变。
- YAML 保存稳定 ID；正文“关联文档”使用相对 Markdown 链接，确保人和工具都能追踪。

## 状态流转

```text
REQ:  draft -> approved -> in_progress -> accepted
                           \-> cancelled

BIZ:  proposed -> accepted -> superseded
                \-> rejected

DEV:  draft -> approved -> in_progress -> implemented -> verified
                                      \-> superseded

BUG:  open -> confirmed -> fixing -> fixed -> verified -> closed
                               \-> wont_fix

PROG: active -> final
```

约束：

- REQ 未达到 `approved` 前，不开始对应业务代码。
- 影响实现的 BIZ 未达到 `accepted` 前，不把提议内容当作已确认需求。
- REQ 只有在全部验收项完成且不存在阻断 BUG 时才能进入 `accepted`。
- BUG 只有在记录回归验证证据后才能进入 `verified`。
- PROG 进入 `final` 前必须记录验证结果、遗留问题和下一任务。

## 关联规则

1. PROG 文件头必须引用相关 REQ；每条完成项还必须以 `[REQ-...]` 标记具体来源。
2. PROG 记录 BUG 工作时，文件头和对应条目必须同时引用 BUG 及该 BUG 的来源 REQ。
3. BUG 必须引用发现该缺陷时正在推进的 REQ，并明确该 REQ 是否真正引入缺陷。
4. BIZ 必须引用对应 REQ；没有 REQ 的业务决定不得创建。
5. DEV 必须引用 REQ，并引用所有会约束实现的 BIZ 和阻断实现的 BUG。
6. 所有引用必须指向仓库内真实文件；仅写 ID 而没有正文链接不算完整关联。
7. 一个日期只能有一个 PROG；涉及多个 REQ 时在同一日志内分节记录。

## 文档创建流程

1. 新功能或大范围改造先创建 REQ，状态为 `draft`。
2. 将会改变用户可见行为的选择记录为 BIZ，状态为 `proposed`。
3. 复杂实现创建 DEV，并把未解决的业务决定和现有缺陷列为前置条件。
4. 发现真实缺陷立即创建 BUG；不得为了占号创建空 BUG。
5. 当天在 PROG 中记录文档、代码、验证、阻塞和下一任务。
6. 用户确认后更新 REQ/BIZ/DEV 状态，再开始最小可验证纵向切片。

## 当前文档

- [REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](requirements/REQ-20260805-01-artist-discography-playlist.md)
- [REQ-20260806-01 下载文件曲序命名与专辑目录组织](requirements/REQ-20260806-01-album-structured-download.md)
- [REQ-20260806-02 歌曲文件夹整理与音频可播放性检查](requirements/REQ-20260806-02-song-folder-organizer.md)
- [REQ-20260808-01 FLAC 批量转换为 MP3](requirements/REQ-20260808-01-flac-to-mp3.md)
- [REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- [REQ-20260811-01 下载音频真实格式校验与降级发布](requirements/REQ-20260811-01-download-actual-format-publication.md)
- [BIZ-20260805-01 歌手专辑目录口径与来源策略](decisions/BIZ-20260805-01-discography-scope-and-source.md)
- [BIZ-20260806-01 下载曲序命名与专辑目录策略](decisions/BIZ-20260806-01-album-download-path-and-file-name.md)
- [BIZ-20260806-02 专辑抓取与歌曲整理独立导航](decisions/BIZ-20260806-02-album-collection-and-song-organizer-navigation.md)
- [BIZ-20260806-03 歌曲文件夹扫描、清理、计数与重命名规则](decisions/BIZ-20260806-03-song-folder-organization-rules.md)
- [BIZ-20260807-01 批量下载优先音质与逐曲自动降级策略](decisions/BIZ-20260807-01-batch-download-quality-fallback.md)
- [BIZ-20260807-02 歌曲整理跨模块安全与目录兼容策略](decisions/BIZ-20260807-02-song-organizer-safety-and-directory-compatibility.md)
- [BIZ-20260807-03 歌曲整理采用 Easy Music 文件夹整理工作区](decisions/BIZ-20260807-03-song-organizer-easy-music-workspace.md)
- [BIZ-20260808-01 歌曲整理启动预扫描、清理隔离与工作区排版修订](decisions/BIZ-20260808-01-song-organizer-startup-prescan-and-layout.md)
- [BIZ-20260808-02 歌曲整理移除固定扫描状态并使用详情弹窗](decisions/BIZ-20260808-02-song-organizer-detail-dialog.md)
- [BIZ-20260808-03 FLAC 转 MP3 使用独立模块与导航](decisions/BIZ-20260808-03-flac-converter-independent-module.md)
- [BIZ-20260808-04 FLAC 转 MP3 采用来源目录与可选输出父目录](decisions/BIZ-20260808-04-flac-converter-directory-output.md)
- [BIZ-20260809-01 FLAC 转 MP3 使用歌手列表、行内进度与异常结果](decisions/BIZ-20260809-01-flac-converter-artist-workspace.md)
- [BIZ-20260809-02 工具页面采用歌手名称输入、可选来源目录与独立图标](decisions/BIZ-20260809-02-tool-input-directory-and-icons.md)
- [BIZ-20260809-03 四平台抓取与来源歌单批量写入策略](decisions/BIZ-20260809-03-four-source-discography-playlist-strategy.md)
- [BIZ-20260809-04 专辑抓取采用来源摘要与结构化去重审计](decisions/BIZ-20260809-04-album-summary-and-dedup-audit.md)
- [BIZ-20260809-05 部分结果直接写入与去重核查字段精简](decisions/BIZ-20260809-05-partial-direct-apply-and-dedup-summary.md)
- [BIZ-20260810-01 来源歌单名称包含最终歌曲数量](decisions/BIZ-20260810-01-playlist-name-with-track-count.md)
- [BIZ-20260810-02 来源子集选择与歌手别名身份确认](decisions/BIZ-20260810-02-source-subset-and-artist-alias-confirmation.md)
- [BIZ-20260810-03 歌曲整理详情仅展示异常与阻塞信息](decisions/BIZ-20260810-03-song-organizer-anomaly-only-details.md)
- [BIZ-20260810-04 歌曲整理操作进度与失败核查留存](decisions/BIZ-20260810-04-song-organizer-operation-progress-and-failure-retention.md)
- [BIZ-20260810-05 FLAC 转 MP3 输出歌手目录追加实际歌曲数量](decisions/BIZ-20260810-05-flac-converter-output-song-count-suffix.md)
- [BIZ-20260811-01 下载按真实音频格式发布并明确提示降级](decisions/BIZ-20260811-01-download-actual-format-publication.md)
- [BIZ-20260811-02 应用关闭时安全取消 FLAC 转换并保留歌曲整理退出保护](decisions/BIZ-20260811-02-flac-converter-safe-exit-cancel.md)
- [BIZ-20260811-03 歌曲整理拆分为快速扫描、检查与整理](decisions/BIZ-20260811-03-song-organizer-fast-scan-check-organize.md)
- [BIZ-20260811-04 完整 FLAC 仅对末帧后有界尾随数据执行无损规范化](decisions/BIZ-20260811-04-flac-trailing-data-normalization.md)
- [BIZ-20260811-05 歌曲整理所有任务均不可由用户或退出流程取消](decisions/BIZ-20260811-05-song-organizer-non-cancellable-operations.md)
- [BIZ-20260811-06 超长歌手与歌曲字段分别省略并预留下载内部文件名空间](decisions/BIZ-20260811-06-download-long-name-semantic-truncation.md)
- [DEV-20260805-01 歌手专辑目录组装技术方案](designs/DEV-20260805-01-artist-discography-playlist.md)
- [DEV-20260806-01 下载目标解析与任务固化技术方案](designs/DEV-20260806-01-album-structured-download.md)
- [DEV-20260806-02 歌曲文件夹整理技术方案](designs/DEV-20260806-02-song-folder-organizer.md)
- [DEV-20260808-01 FLAC 批量转换为 MP3 技术方案](designs/DEV-20260808-01-flac-to-mp3.md)
- [DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](designs/DEV-20260809-01-four-source-artist-discography-playlists.md)
- [DEV-20260811-01 下载真实格式校验与元数据发布技术方案](designs/DEV-20260811-01-download-actual-format-publication.md)
- [DEV-20260811-02 FLAC 转换关闭安全取消技术方案](designs/DEV-20260811-02-flac-converter-safe-exit-cancel.md)
- [DEV-20260811-03 歌曲整理快速扫描、检查与整理技术方案](designs/DEV-20260811-03-song-organizer-fast-scan-check-organize.md)
- [BUG-20260805-01 酷狗歌手 adapter 映射错误](bugs/BUG-20260805-01-kg-singer-adapter.md)
- [BUG-20260805-02 网易云歌手 adapter 分页与音质错误](bugs/BUG-20260805-02-wy-singer-adapter.md)
- [BUG-20260805-03 QQ 音乐歌手 adapter 响应与分页错误](bugs/BUG-20260805-03-tx-singer-adapter.md)
- [BUG-20260805-04 酷狗歌手 adapter 将等级字段误映射为性别](bugs/BUG-20260805-04-kg-singer-gender-mapping.md)
- [BUG-20260805-05 酷狗专辑详情分页重复请求元数据并耦合失败](bugs/BUG-20260805-05-kg-album-detail-pagination.md)
- [BUG-20260805-06 原生批量下载弹窗未禁用不可用音质](bugs/BUG-20260805-06-batch-download-quality-fallback.md)
- [BUG-20260805-07 酷狗目录分页按请求页大小提前终止](bugs/BUG-20260805-07-kg-pagination-limit-assumption.md)
- [BUG-20260805-08 工具页预览模板未保持计划结果的非空类型](bugs/BUG-20260805-08-tools-template-nullability.md)
- [BUG-20260805-09 工具页缺少来源输入与完整歌手确认信息](bugs/BUG-20260805-09-tools-source-and-artist-confirmation.md)
- [BUG-20260805-10 酷狗歌手畸形响应被误判为歌手不存在](bugs/BUG-20260805-10-kg-artist-response-classification.md)
- [BUG-20260806-01 酷狗专辑曲目扩展遗漏 album_audio_id 导致多发行版缺曲](bugs/BUG-20260806-01-kg-album-audio-id.md)
- [BUG-20260806-02 工具页 v-for 索引隐式 symbol 转换导致开发态启动编译失败](bugs/BUG-20260806-02-tools-v-for-symbol-key.md)
- [BUG-20260807-01 批量下载最高音质被精确交集规则禁用](bugs/BUG-20260807-01-batch-download-highest-quality-disabled.md)
- [BUG-20260809-01 网易专辑详情验证拦截缺少 v1 回退并产生级联提示](bugs/BUG-20260809-01-wy-album-verification-fallback.md)
- [BUG-20260810-01 网易歌手全局完全同名优先遮蔽正确别名结果](bugs/BUG-20260810-01-wy-artist-alias-candidate.md)
- [BUG-20260810-02 网易专辑曲序 no=0 被严格映射误拒导致漏曲](bugs/BUG-20260810-02-wy-zero-track-number.md)
- [BUG-20260810-03 酷我专辑抓取固化 240 像素缩略图导致下载封面偏低](bugs/BUG-20260810-03-kw-album-cover-resolution.md)
- [BUG-20260810-04 Windows 文件身份精度丢失导致歌曲漏计](bugs/BUG-20260810-04-song-organizer-file-identity-precision.md)
- [BUG-20260810-05 Windows 操作日志原子替换偶发 EPERM](bugs/BUG-20260810-05-song-organizer-journal-replace-eperm.md)
- [BUG-20260810-06 音频完整解码串行执行导致扫描过慢](bugs/BUG-20260810-06-song-organizer-serial-validation.md)
- [BUG-20260810-07 重命名无进度且操作失败无法再次核查](bugs/BUG-20260810-07-song-organizer-operation-feedback-loss.md)
- [BUG-20260811-01 酷我整专辑零基曲序被严格映射误拒并导致曲序错位](bugs/BUG-20260811-01-kw-zero-based-track-number.md)
- [BUG-20260811-02 请求 FLAC 但实际 MP3 被错误发布为 FLAC](bugs/BUG-20260811-02-requested-flac-published-mp3-as-flac.md)
- [BUG-20260811-03 暂停的 FLAC 转换无限保持繁忙并阻止退出](bugs/BUG-20260811-03-paused-flac-converter-blocks-exit.md)
- [BUG-20260811-04 歌曲整理首次完整解码与操作后重扫导致结果迟缓](bugs/BUG-20260811-04-song-organizer-eager-validation-and-rescan.md)
- [BUG-20260811-05 下载生命周期回调对象无法被 Worker 结构化克隆](bugs/BUG-20260811-05-download-worker-preparation-lifecycle-not-cloneable.md)
- [BUG-20260811-06 完整 FLAC 因末帧后尾随数据被严格校验拒绝](bugs/BUG-20260811-06-valid-flac-rejected-for-trailing-data.md)
- [BUG-20260811-07 下载内部文件名超出 Windows 单段上限导致长名称歌曲发布失败](bugs/BUG-20260811-07-download-internal-artifact-name-too-long.md)
- [BUG-20260811-08 完整 FLAC 因相邻末帧 CRC 候选被歧义保护误拒](bugs/BUG-20260811-08-flac-terminal-frame-boundary-ambiguity.md)
- [PROG-20260805](progress/PROG-20260805.md)
- [PROG-20260806](progress/PROG-20260806.md)
- [PROG-20260807](progress/PROG-20260807.md)
- [PROG-20260808](progress/PROG-20260808.md)
- [PROG-20260809](progress/PROG-20260809.md)
- [PROG-20260810](progress/PROG-20260810.md)
- [PROG-20260811](progress/PROG-20260811.md)
