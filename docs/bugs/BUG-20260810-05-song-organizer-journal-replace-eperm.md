---
id: BUG-20260810-05
type: BUG
title: Windows 操作日志原子替换偶发 EPERM
status: verified
severity: high
created_at: 2026-08-10
updated_at: 2026-08-10
owner: KhalilFong
req_ids:
  - REQ-20260806-02
discovered_in_req_id: REQ-20260806-02
introduced_by_req_id: REQ-20260806-02
---

# Windows 操作日志原子替换偶发 EPERM

## 关联文档

- 来源需求：[REQ-20260806-02 歌曲文件夹整理与音频可播放性检查](../requirements/REQ-20260806-02-song-folder-organizer.md)
- 业务决策：[BIZ-20260810-04 歌曲整理操作进度与失败核查留存](../decisions/BIZ-20260810-04-song-organizer-operation-progress-and-failure-retention.md)
- 技术方案：[DEV-20260806-02 歌曲文件夹整理技术方案](../designs/DEV-20260806-02-song-folder-organizer.md)
- 当日进度：[PROG-20260810](../progress/PROG-20260810.md)

## 现象与复现

用户在重命名歌手目录时得到：

```text
EPERM: operation not permitted, rename
song-organizer-operation.json.tmp -> song-organizer-operation.json
```

失败后正式日志和临时日志均不存在，操作结果无法在普通详情中再次核查。确定性回归在覆盖现有日志时精确注入一次同路径 `EPERM`，当前实现立即透传失败。

## 期望行为

1. 继续依赖 Service 的单操作注册表与逐步 `await` 保证同进程日志写入有序；本缺陷不引入新的并发写入抽象。
2. Windows 瞬时 `EPERM` 或 `EACCES` 只允许有限退避重试；持续拒绝必须在有限时间内失败。
3. 日志替换失败时不得开始磁盘清理或重命名；错误必须进入该歌手当前会话的操作异常。
4. 每次写入只清理自身临时文件，不删除其他写入或已有有效日志；正常完成仍按既有规则删除日志。

## 验证标准

- [x] 单次瞬时替换失败经有限重试后写入成功并可读回最新 operationId。
- [x] 持续替换失败最终返回原始错误，不无限重试且不执行磁盘步骤。
- [x] 既有顺序写入、正常完成删除和异常中断读回测试继续通过。
- [x] 定向测试、Main TypeScript、ESLint 与生产构建通过。

`operationJournal.ts` 仅对 `EPERM/EACCES` 执行 10/25/50/100 ms 的有限退避，耗尽后返回第一次原始错误；已有正式日志不会被删除，本次临时文件会被清理。确定性测试覆盖瞬时 `EPERM/EACCES` 恢复与持续 `EPERM` 五次后终止；同一应用数据目录的隔离探针在 3,000 次覆盖中遇到 7 次瞬时 `EPERM`，均在第 2 次替换恢复。专题测试、Main TypeScript、ESLint 与生产构建均通过；2026-08-10 18:44:14.170 的阶段 15 Windows x64 NSIS 安装包已通过 ASAR Main 标志确认包含重试间隔实现。安装器与真实失败流程仍未人工运行，不改变本缺陷 `verified` 状态及 REQ 的整体验收边界。
