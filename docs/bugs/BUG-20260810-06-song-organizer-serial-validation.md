---
id: BUG-20260810-06
type: BUG
title: 音频完整解码串行执行导致扫描过慢
status: verified
severity: medium
created_at: 2026-08-10
updated_at: 2026-08-10
owner: KhalilFong
req_ids:
  - REQ-20260806-02
discovered_in_req_id: REQ-20260806-02
introduced_by_req_id: REQ-20260806-02
---

# 音频完整解码串行执行导致扫描过慢

## 关联文档

- 来源需求：[REQ-20260806-02 歌曲文件夹整理与音频可播放性检查](../requirements/REQ-20260806-02-song-folder-organizer.md)
- 业务决策：[BIZ-20260810-04 歌曲整理操作进度与失败核查留存](../decisions/BIZ-20260810-04-song-organizer-operation-progress-and-failure-retention.md)
- 技术方案：[DEV-20260806-02 歌曲文件夹整理技术方案](../designs/DEV-20260806-02-song-folder-organizer.md)
- 当日进度：[PROG-20260810](../progress/PROG-20260810.md)

## 现象与根因证据

扫描器在发现每个唯一音频后立即 `await` 完整解码，导致 FFmpeg 校验峰值并发恒为 1。确定性最小场景包含 8 个文件、每次校验 50 ms，当前耗时稳定约 500 ms；真实目录 199 个音频全部完整解码耗时约 39.2 秒，而纯目录发现仅约 41 ms，验证阶段占总耗时约 99.8%。

## 期望行为

1. 继续对每个唯一物理 MP3/FLAC 执行一次完整解码，不引入跨扫描缓存或快速探测替代。
2. 使用经过真实样本验证的固定上限并发；结果排序、计数、异常归属和进度不依赖完成顺序。
3. 取消、超时或应用退出必须停止队列继续取任务，并终止所有在途 FFmpeg 子进程。
4. 并发上限不得造成磁盘或 CPU 明显过载；最终值由串行与多个候选并发的真实 199 首对照确定。

## 验证标准

- [x] 6 个固定延迟校验的确定性测试保留 6 次调用，峰值并发严格为 2。
- [x] 真实 199 首只读扫描校验次数仍为 199，结果仍为 199 playable、0 failed，墙钟时间低于串行基线。
- [x] 取消、首个异常与稳定排序测试证明不会晚启动新任务、不会遗留在途校验或打乱结果。
- [x] 定向测试、Main TypeScript、ESLint 与生产构建通过。

Scanner 已改为固定 2 路 worker，同一扫描以物理身份缓存校验 Promise，硬链接仍只完整解码一次且不增加跨扫描缓存。真实 199 首目录由串行 39,164.1 ms 降至 18,346.8 ms，缩短约 53.1%，校验调用数、playable 与 failed 数量不变；取消、异常收敛、完成乱序与 Collator 等价路径的稳定排序均有回归覆盖。专题测试、Main TypeScript、ESLint 与生产构建均通过；2026-08-10 18:44:14.170 的阶段 15 Windows x64 NSIS 安装包已通过 ASAR Main 标志确认包含固定并发 2 实现。未再次通过安装态 UI 执行 199 首扫描，不改变已有真实只读性能证据和本缺陷 `verified` 状态。
