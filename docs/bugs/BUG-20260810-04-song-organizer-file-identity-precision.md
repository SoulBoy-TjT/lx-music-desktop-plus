---
id: BUG-20260810-04
type: BUG
title: Windows 文件身份精度丢失导致歌曲漏计
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

# Windows 文件身份精度丢失导致歌曲漏计

## 关联文档

- 来源需求：[REQ-20260806-02 歌曲文件夹整理与音频可播放性检查](../requirements/REQ-20260806-02-song-folder-organizer.md)
- 业务决策：[BIZ-20260810-03 歌曲整理详情仅展示异常与阻塞信息](../decisions/BIZ-20260810-03-song-organizer-anomaly-only-details.md)
- 技术方案：[DEV-20260806-02 歌曲文件夹整理技术方案](../designs/DEV-20260806-02-song-folder-organizer.md)
- 当日进度：[PROG-20260810](../progress/PROG-20260810.md)

## 发现方式

用户目录中的“刘雨昕”歌手文件夹由 Windows 资源管理器统计为 199 个文件、46 个文件夹，歌曲整理却显示 198 首、46 张专辑，且详情没有解释少计的歌曲。只读实盘扫描确认 199 个文件全部为受支持音频，其中 198 个 FLAC、1 个 MP3；注入恒定可播放校验器后仍稳定得到 198 首，因此问题不在解码或扩展名识别。

## 根因

1. Scanner 使用默认 `fs.lstat()`，Windows 的 64 位 `dev/ino` 文件身份被 Node.js 作为 JavaScript `number` 返回。
2. 超过 `Number.MAX_SAFE_INTEGER` 的不同文件 ID 会发生舍入。实盘中精确 `ino` 为 `21110623254199041` 和 `21110623254199038` 的两个普通文件，均被舍入为 `21110623254199040`。
3. 计数逻辑以舍入后的 `dev:ino` 无条件去重，因此把两个不同文件误认为同一物理文件，歌手总数从 199 变为 198。
4. 两个文件的 `nlink` 都是 1，异常逻辑只把 `nlink >= 2` 的身份组报告为重复硬链接，所以误合并不会产生任何异常说明。

发生碰撞的两个相对路径为：

- `2023-06-15 虽然留不住时光\04. 刘雨昕 - 虽然留不住时光 (纯音乐深情版).flac`
- `2026-02-10 唐宫奇案之青雾风鸣 影视原声带\14. 袁娅维TIA RAY - 罪与花 (伴奏).flac`

两者大小、时长、SHA-256 均不同，且各自只有一个硬链接路径；它们不是内容重复或硬链接，只是错误地进入同一个舍入后身份组。因此不存在一首真正缺失的磁盘歌曲，缺失的是扫描计数中的一个独立身份。

## 期望行为

1. Windows 文件身份必须从读取起就使用无损表示；`dev/ino` 采用 `bigint` 取得并在身份键中完整保留，不允许先转为 `number` 再恢复。
2. `size`、`nlink` 显式转换为现有数值字段；`mtimeMs` 从无损 `mtimeNs` 按毫秒整数与剩余纳秒分段换算，保留亚毫秒精度且不改变 IPC 数据模型。
3. 精确身份不同的普通文件分别计数，即使它们转换为 JavaScript `number` 后相等；真实硬链接仍按同一精确身份去重并报告可核查路径。
4. 修复后该实盘目录应得到 199 首、46 张专辑，且无虚假的重复硬链接异常。

## 验证标准

- [x] Scanner 确定性回归构造两个精确 `ino` 不同但 `Number(ino)` 相等、`nlink=1` 的普通文件身份，扫描结果分别计数、分别校验且不产生硬链接异常。
- [x] Scanner 跨专辑真实硬链接回归证明同一精确身份只校验一次、歌手总数只计一次、两个专辑各计一次，并产生两条 `cleanupEligible=false` 的不可自动清理异常。
- [x] 实盘只读扫描“刘雨昕”目录返回 199 首、46 张专辑，数量与 199 个物理音频文件一致。
- [x] Song Organizer 定向测试、Main TypeScript、相关 ESLint 和生产构建通过。

## 当前状态

已新增文件身份边界，统一通过 `lstat(..., { bigint: true })` 取得无损 `dev/ino`，身份键不再经过 JavaScript `number`；`size`、`nlink` 显式转换，`mtimeMs` 从 `mtimeNs` 的毫秒整数与剩余纳秒分段换算，在保持既有快照模型的同时避免丢失亚毫秒精度。确定性身份测试确认两个精确 inode `21110623254199041`、`21110623254199038` 在 `Number()` 均为 `21110623254199040` 时仍形成不同身份；扫描器级碰撞回归进一步确认校验器调用 2 次、歌曲计数 2、专辑计数合计 2 且不存在硬链接异常。跨专辑真实硬链接回归确认校验器只调用 1 次、歌手总数为 1、两个专辑各计 1，并为两个路径分别生成 `cleanupEligible=false` 的异常。

真实目录临时回归先稳定复现 RED：199 个物理音频得到 `snapshotAudioCount=198`、`anomalyCount=0`、46 张专辑；修复后同一目录 GREEN：`snapshotAudioCount=199`、目标名称“刘雨昕（199首）”、`anomalyCount=0`、46 张专辑，临时测试随后删除。Main 与 Renderer 定向 5 个文件 42 项（其中 `scanner.test.ts` 8 项）、专题 39 个文件 272 项测试、Main/Renderer TypeScript、9 个相关文件 ESLint 和四套 production webpack 构建均通过，状态保持 `verified`。本轮重新构建的 Windows x64 NSIS 安装包已通过 ASAR Main 静态核对，确认包含 `lstat(..., { bigint: true })`、精确 `dev:ino`、`mtimeNs` 分段换算和清理复核统一 helper。真实 Electron 页面点击和安装态仍属于 REQ 的整体验收边界，不影响本缺陷的计数根因与修复验证。
