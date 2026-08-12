---
id: BUG-20260806-02
type: BUG
title: 工具页 v-for 索引隐式 symbol 转换导致开发态启动编译失败
status: verified
severity: high
created_at: 2026-08-06
updated_at: 2026-08-06
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: REQ-20260805-01
---

# 工具页 v-for 索引隐式 symbol 转换导致开发态启动编译失败

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)
- 当日进度：[PROG-20260806](../progress/PROG-20260806.md)

## 发现方式

用户重新运行开发实例后，Electron 错误覆盖层报告 `src/renderer/views/Tools/index.vue.ts` 中 3 个 `TS2731`，提示将 `symbol` 隐式转换为字符串可能在运行时失败，导致 Renderer 以 `Compiled with problems` 状态启动。

## 位置与根因

- `src/renderer/views/Tools/index.vue`

工具页的目录级、专辑级和歌单写入级问题列表都使用 `` `${issue.code}-${index}` `` 作为 `v-for` key。Vue 模板生成代码中的 `renderList` 重载上下文会让第二个回调参数被推断为可能包含 `symbol` 的键类型，因此开发态虚拟 TS 文件拒绝把 `index` 隐式插入模板字符串；这不表示数组索引运行时实际为 `symbol`。`DiscographyIssue.code` 自身是纯字符串联合类型，不是问题来源。

单变量复现确认：只将第一处索引改为 `String(index)` 后，开发态 Renderer 编译错误从 3 个精确减少为 2 个。

## 期望行为

- 三个问题列表的 key 都必须显式把模板索引转换为字符串。
- 不改变问题列表内容、顺序、去重语义或用户交互。
- 开发态 Renderer 冷编译必须无 `TS2731`，不能只依赖不检查 Vue 模板的普通 `tsc`。

## 修复约束

1. 修改仅限工具页的三处 key 表达式和直接相关文档。
2. 不放宽 TypeScript 检查，不修改 Vue、ts-loader 或 webpack 配置。
3. 不修改酷狗 adapter、网易云、QQ 音乐、歌单或下载逻辑。

## 验证标准

- [x] 修复前首次开发态 Renderer 单次编译精确报告 3 个 `TS2731`，与用户截图一致。
- [x] 单独修复第一处后只剩 2 个同类错误。
- [x] 三处均修复后开发态 Renderer 无缓存编译通过。
- [x] 工具页 ESLint、Renderer TypeScript 和目录专题测试通过。
- [x] Renderer 生产构建和完整构建通过。
- [x] 重新启动开发实例后不再报告 `TS2731`，主进程与 Renderer 均编译成功。

## 当前修复记录

- 三处 `v-for` key 已改为 `` `${issue.code}-${String(index)}` ``。
- `npx cross-env NODE_ENV=development webpack --config build-config/renderer/webpack.config.dev.js --no-cache --stats errors-only` 已通过。
- 目标 ESLint、Renderer TypeScript、7 个文件 40 项专题测试和 `npm run build` 均通过。
- 开发实例已重新启动，日志中 `TS2731` 为 0，BUG 状态更新为 `verified`。
