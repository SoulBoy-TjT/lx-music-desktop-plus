---
id: DEV-20260811-01
type: DEV
title: 下载真实格式校验与元数据发布技术方案
status: implemented
created_at: 2026-08-11
updated_at: 2026-08-18
owner: KhalilFong
req_ids:
  - REQ-20260811-01
biz_ids:
  - BIZ-20260811-01
  - BIZ-20260811-04
  - BIZ-20260811-06
bug_ids:
  - BUG-20260811-02
  - BUG-20260811-05
  - BUG-20260811-06
  - BUG-20260811-07
  - BUG-20260811-08
  - BUG-20260818-01
---

# 下载真实格式校验与元数据发布技术方案

## 关联文档

- [REQ-20260811-01](../requirements/REQ-20260811-01-download-actual-format-publication.md)
- [BIZ-20260811-01](../decisions/BIZ-20260811-01-download-actual-format-publication.md)
- [BIZ-20260811-04](../decisions/BIZ-20260811-04-flac-trailing-data-normalization.md)
- [BIZ-20260811-06](../decisions/BIZ-20260811-06-download-long-name-semantic-truncation.md)
- [BUG-20260811-02](../bugs/BUG-20260811-02-requested-flac-published-mp3-as-flac.md)
- [BUG-20260811-05](../bugs/BUG-20260811-05-download-worker-preparation-lifecycle-not-cloneable.md)
- [BUG-20260811-06](../bugs/BUG-20260811-06-valid-flac-rejected-for-trailing-data.md)
- [BUG-20260811-07](../bugs/BUG-20260811-07-download-internal-artifact-name-too-long.md)
- [BUG-20260811-08](../bugs/BUG-20260811-08-flac-terminal-frame-boundary-ambiguity.md)
- [BUG-20260818-01](../bugs/BUG-20260818-01-interrupted-download-stuck-running.md)
- 上游方案：[DEV-20260806-01 下载目标解析与任务固化技术方案](DEV-20260806-01-album-structured-download.md)

## 设计

1. 在下载临时文件完成、元数据写入与最终发布之间增加真实格式探测 seam；读取有限文件头并用现有音频工具确认容器/codec，返回结构化 `actualFormat`，未知或冲突为失败而非猜测。
2. 由 `actualFormat` 选择扩展名和元数据写入器；FLAC 计划得到 MP3 时重解析最终目标为 `.mp3`，同步更新任务持久化路径、文件名、歌词基名和展示数据。
3. MP3 降级沿用 MP3 标签写入能力补齐可获得的标题、歌手、专辑和封面；标签失败不得把未完成临时文件发布为成品。
4. 将 `requestedQuality`、`actualQuality/actualFormat` 与结构化降级原因分开保存；Renderer 聚合为明确降级提示。
5. 发布继续使用不覆盖原子边界；若重解析后的 `.mp3` 目标已存在则按既有冲突规则处理，不覆盖，也不遗留计划 `.flac`。
6. 所有 Worker 参数必须满足结构化克隆边界；Renderer 先组装包含 `beginTask`、`isTaskCancelled`、`finishTask` 的完整下载生命周期对象，再对整个对象调用 `Comlink.proxy` 并将其作为第 7 个参数传输，禁止把独立代理函数嵌入普通对象后裸走 structured clone。
7. Download Worker 按任务登记 lifecycle、action callback 和 validator 三类远程代理并 exactly-once release；generation guard 隔离旧回调，`taskTeardowns` 串行暂停、删除、transfer 清理和重试。Downloader 只负责在关闭后上报断点 mismatch，Worker 负责删除后从零重试，删除失败时终止重试并上报写入错误。
8. Downloader 必须区分用户主动停止与异常断流：`aborted`、`socket hang up` 及 `complete=false` 的响应结束都通过唯一 `error` seam 上报，包装层不得按错误文本吞错。错误上报前必须等待当前写流完全关闭，并对同一写流复用单一关闭 Promise；每次 `start()` 使用独立 attempt token，隔离旧请求、响应、超时、写回调和 `stat/open/read/close` 初始化回调，主动停止同时使旧 attempt 失效。Download Worker 沿用初次失败后最多自动重试 2 次的上限；有 transfer 文件时通过 10 字节重叠校验执行 Range 续传，重试耗尽后进入错误终态。暂停、删除及旧 generation 的迟到事件继续由 generation guard 拦截，不得触发重试。

## 内部文件名预算补充设计

1. `src/common/downloadArtifactPaths.ts` 统一定义 `WINDOWS_MAX_PATH_COMPONENT_LENGTH=255`、publication/transfer/FLAC repair/owner 后缀、repair ID 长度以及 repair/owner 路径函数；按最长 owner 组合反推 `MAX_DOWNLOAD_FILE_STEM_LENGTH=158`，供下载目标、Main validator 和 Renderer publication 共同使用。
2. 用户可见名称超出 158 字符基名预算时，按 `BIZ-20260811-06` 分别缩短歌手名和歌曲名，在字符边界输出 `...~<hash>`，同时保留曲序、字段分隔符和稳定消歧信息；真实扩展名在基名预算之外追加。
3. 真实格式重解析为其他扩展名时继续通过统一下载目标解析生成最终名称，重新验证内部后缀预算；不得只替换扩展名后沿用可能超限的基名。
4. Worker 对规范化结果的信任边界继续使用任务登记路径和实例校验；缩短用户文件名不放宽完整解码、真实格式、样本数、CRC、不覆盖或临时文件清理语义。
5. 新增或改变内部后缀时，必须同步更新共享最长后缀预算及构造实际派生文件名的自动化；Windows 长路径支持不替代单个文件名组件限制。

## 尾随数据规范化补充设计

1. 在严格解码失败且已识别为 FLAC 时才进入候选检查；解析 STREAMINFO、音频帧边界和 CRC，必须证明解码样本总数等于 STREAMINFO 声明值、最终音频帧有效且所有异常数据都位于最终帧之后。
2. 候选尾随数据必须非空且不超过实现中固定的小范围上限；截断位置只能取解析得到的最终合法帧结束偏移，不使用时长、FFmpeg 最后输出时间或文件大小猜测。
3. 在发布暂存边界内生成规范化副本，不原地修改下载临时文件；规范化过程不重编码音频帧。对副本重新执行现有严格完整解码、真实格式和样本数校验，全部通过后才进入元数据与原子不覆盖发布。
4. 候选证明失败、尾随超限、规范化写入失败或复验失败均沿用当前失败与临时文件清理语义；中段损坏、样本数不一致、帧/CRC 错误不得进入规范化分支。
5. 原始严格解码即使以错误退出，也同步计算其已经输出的 canonical s16le PCM 字节数和 SHA-256；只有该字节数与 STREAMINFO 声明总样本数对应字节数一致时，才允许进入末帧候选检查。
6. 末帧扫描将去重后的合法结束偏移限制为最多 4 个并按偏移升序返回。Main validator 依次复制各候选边界之前的原始字节，对副本执行同一严格解码；候选必须同时满足退出码为 0、解码字节数等于声明样本数对应字节数、canonical s16le PCM SHA-256 与原始失败解码输出一致，取首个匹配候选。
7. 某候选严格解码失败、样本数或 PCM SHA-256 不一致时立即清理副本并继续；候选超过 4 个或全部失败时抛回原始严格解码错误。该流程不修改来源文件，不将“多个 CRC-valid 候选”本身视为损坏，也不依赖 FFmpeg 对多余尾部的宽容行为。

## 验证计划

- 固定真实 FLAC、320k MP3、MP3 内容伪装 `.flac`、损坏与未知内容样例。
- 增加最终帧后 15/30 字节尾随数据、无尾随正常 FLAC、中段损坏、样本数不足/超出、CRC 错误、最终帧不可定位和尾随超限样例；验证只修复前两类固定尾随样例并保持其他失败。
- 增加相邻 CRC-valid 末帧边界样例，覆盖首候选严格解码失败、首候选 canonical PCM SHA-256 不一致后采用下一候选、全部候选失败和候选数超 4；不得以候选唯一性作为正确性前提。
- 覆盖真实格式探测、写入器路由、目标重解析、任务持久化、歌词基名、封面/标签、重试、冲突和临时文件清理。
- 使用本地 HTTP 服务分别在部分响应后和响应头前断开连接，覆盖 `aborted`、`socket hang up` 与 Range 续传；Downloader 回归覆盖 `complete=false` 和错误事件去重；既有 Worker generation 回归覆盖重试耗尽终态，以及暂停、删除后不重试。
- 增加歌手超长、歌曲名超长、二者同时超长及同前缀不同原文样例；从最终目标构造 transfer、publishing、FLAC 规范化和 owner 文件名，验证每个组件均在 Windows 单段预算内且保持稳定消歧。
- 执行相关 Vitest、Main/Renderer 类型检查、定向 ESLint、生产构建和 Windows x64 安装包静态核验。
- 最终由用户重新下载目标专辑，核对扩展名、完整解码、Windows 时长/专辑/封面和降级提示；不操作既有 10 个文件。

## 实施与验证结果

- 已实现 Main 持有的真实内容探测与完整 FFmpeg 解码、真实格式驱动的路径/写入器选择、`requestedQuality` 与实际格式分离持久化、结构化降级提示、`.lx-publishing.*` 暂存及不覆盖发布。
- 已覆盖启动与同会话恢复、目标冲突、设置变化、重试、任务删除、未知/损坏内容、真实 FLAC、正常 MP3 和计划 FLAC 实际 MP3；MP3/FLAC 元数据发布要求标题、歌手、专辑及封面具备可用值，失败不发布半成品。
- whole-object lifecycle proxy、lifecycle/action callback/validator exactly-once release、generation guard、`taskTeardowns` 串行及 Worker-owned mismatch 清理均已实现，并覆盖正常完成、终态错误、暂停、删除、初始化早退、重试替换和删除失败路径。
- 断流错误 seam 已修复：Downloader 不再忽略 `aborted`，`complete=false` 的响应结束改为恰好上报一次错误，请求包装层不再忽略 `socket hang up`；写流关闭完成后才上报错误，attempt token 隔离旧网络、超时和磁盘初始化回调，mismatch 错误优先于销毁请求产生的 `aborted`。Worker 复用既有最多两次重试并从 transfer 文件 Range 续传。本地 HTTP、Downloader 与 Worker generation 核心回归 3 个文件、47 项通过，扩展下载回归 5 个文件、59 项通过，覆盖中途断流、响应头前连续 3 次断连终态、暂停/删除隔离及慢磁盘迟到回调；Common/Renderer TypeScript、定向与全量 ESLint、Renderer production webpack 均退出 0。
- FLAC 尾随数据规范化已实现：仅在声明样本、最终帧结构与 CRC 完整且异常全部位于末帧后有界范围时生成不重编码副本，精确裁剪后再执行严格完整解码、真实格式和样本数复验；中段损坏、样本/CRC 异常、末帧不可定位及尾随超限继续失败。
- 末帧候选消歧已实现：最多 4 个去重候选按结束偏移升序逐一严格解码，只有声明样本数对应字节数与 canonical s16le PCM SHA-256 均匹配原始失败解码输出时才采用首个匹配候选；失败候选立即清理，全部失败继续拒绝。
- 尾随数据最终定向回归 3 个文件、75 项全部通过；最终全专题为 55 个文件通过、1 个文件跳过，461 项通过、1 项跳过。Main 与 Renderer `tsc --noEmit`、全量 lint（157.5 秒）及最终变更文件定向 lint 均通过。
- 真实《STRANGE》文件经 Main public service 隔离验证：来源文件保持不变，规范化副本精确删除末帧后的 30 字节，严格复验通过。
- 在 `LX_SKIP_WIN_EXECUTABLE_EDIT=true` 下完整执行 `npm run pack`，退出码 0、总耗时 87.1 秒。Setup 生成于 2026-08-11 23:49:17.4363217 +08:00，为 142,763,630 bytes，SHA-256 `509B1A24BE394A977EC4E2AC439A5ADA000096B083CC6891B5468DC53B409DF8`；blockmap 生成于 23:49:19.0982183，为 150,410 bytes，SHA-256 `EB039FF0047A24A347125D224ED111BBA5C83CB0BFA83C93D9338EA8E094002E`；`app.asar` 生成于 23:48:46.4698759，为 34,187,373 bytes，SHA-256 `A64CF5BE1065E8840B40A66E41596707B77DCFACFFD6EC99106D4DB6A5A03850`。
- `latest.yml` 与 Setup 的 path、size 和两处 SHA-512 `t5YSrh8VXpz/F/nfWk9KHqSucQSlg+lO3r9sN8TgmsS9qyOzMzzLFnWmLQZ8dlSyIEZPsNn/lK1VoKXuBotmkA==` 一致；`7za t` 退出码 0 并返回 `Everything is Ok`，仅有标准 NSIS tail warning。`app.asar` metadata 为 `lx-music-desktop` / `2.12.2` / `./dist/main.js`，下载真实格式、尾随规范化、内部文件名预算和末帧候选消歧 4 个实现标志均存在。随包 FFmpeg SHA-256 为 `E9DA9E22D907A996982F18C7EBD7A4B15483D19CA8D581D295B0BD5E08511FEC`，LICENSE/NOTICE 存在；打包 Electron 在 `ELECTRON_RUN_AS_NODE` 与 `process.dlopen` 下加载 better-sqlite3、qrc_decode 成功。Setup 与 unpacked exe 均为 `NotSigned`。

2026-08-11 后续真实下载发现并修复 `BUG-20260811-07`：下载目标已使用 158 字符基名上限和字段级 `...~<hash>`，Main validator 与 Renderer publication 已改为复用共享后缀及 repair/owner 路径函数。真实 Windows public validator 测试成功创建长度恰为 255 的最长 owner 文件，并完成有界尾随 FLAC 规范化；深层路径极限缩短回归同时证明可辨识省略与消歧保持有效。

末帧候选修复后的定向回归为 4 个文件、92 项全部通过；全专题 55 个文件通过、1 个文件跳过，469 项通过、1 项跳过。Common、Main、Renderer `tsc --noEmit` 与 3 个变更 TypeScript 文件定向 ESLint 均退出 0。真实《怜心（伴奏）》经 Main public validator seam 验证：`49,788,606` bytes 原件保持不变，31 字节候选失败后选中删除 30 字节的 `49,788,576` bytes 副本；副本严格解码成功、声明样本数一致，两次 canonical s16le PCM SHA-256 均为 `bd4865b157626989061b6f7e933b3a2a7301f2662785c87ca319dce91c105185`。

当前设计状态保持 `implemented`。`BUG-20260811-07` 已完成代码、自动化、TypeScript、定向 ESLint、生产构建和静态验包，收口为 `fixed`；尚未在真实 Electron 中重下两首长合唱曲，不标记为 `verified`。`BUG-20260811-08` 已完成代码、自动化、真实 public seam、生产构建和静态验包，收口为 `fixed`；安装器与真实 Electron 重新下载《怜心（伴奏）》尚未完成，不能标记为 `verified`。`BUG-20260818-01` 已完成代码和本地 HTTP 公开 Worker seam 自动化，收口为 `fixed`；真实 Electron 安装态受控断流及休眠/唤醒尚未验证。用户已在真实 Electron 确认任务可离开 `0%`，BUG-20260811-05 为 `verified`。关联 REQ 保持 `in_progress`，既有 10 个伪 FLAC 未修改，Windows 元数据展示、降级提示、新规范化结果与长名称发布仍待用户人工验证。

当前实现对严格解码输出的 canonical s16le PCM 做流式 SHA-256，不缓存整段 PCM，因此不增加同等大小的内存或磁盘占用；相较只计数字节会增加哈希 CPU 开销。该开销不影响正确性，长音频批量下载的性能基准尚未执行，后续如有必要可评估仅在失败修复路径复解码取哈希的权衡。
