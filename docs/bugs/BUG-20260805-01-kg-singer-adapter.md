---
id: BUG-20260805-01
type: BUG
title: 酷狗歌手 adapter 专辑封面映射会抛出类型错误
status: verified
severity: high
created_at: 2026-08-05
updated_at: 2026-08-05
owner: KhalilFong
req_ids:
  - REQ-20260805-01
discovered_in_req_id: REQ-20260805-01
introduced_by_req_id: null
---

# 酷狗歌手 adapter 专辑封面映射会抛出类型错误

## 关联文档

- 来源需求：[REQ-20260805-01 歌手全专辑歌单生成与原生下载衔接](../requirements/REQ-20260805-01-artist-discography-playlist.md)
- 修复方案：[DEV-20260805-01 歌手专辑目录组装技术方案](../designs/DEV-20260805-01-artist-discography-playlist.md)

## 发现方式

在 `REQ-20260805-01` 的实现前静态审查中发现。缺陷存在于既有预留代码，不是本需求引入，因此 `introduced_by_req_id` 为 `null`。

## 位置

- `src/renderer/utils/musicSdk/kg/singer.js:72-81`
- 关键语句：`img: item.replaceAll('{size}', '480')`

## 实际行为

`filterAlbumList` 中的 `item` 是专辑对象，却直接调用字符串方法 `replaceAll`。只要 Provider 返回正常专辑对象，该映射就会产生 `TypeError`，导致酷狗歌手专辑列表无法稳定返回。

## 期望行为

- 从 Provider 实际封面字段读取 URL；字段缺失时使用 `null` 或稳定占位值。
- 封面字段异常不得阻断专辑 ID、名称、作者和声明曲数的返回。
- 返回结果通过酷狗 adapter 固定样例合同测试。

## 影响

- 阻断 `REQ-20260805-01` 第一阶段酷狗纵向切片。
- 目录获取会在专辑映射阶段失败，无法进入专辑详情和歌单创建。

## 修复约束

1. 先保存脱敏 Provider 样例并确认真实封面字段，不能凭字段名猜测。
2. 修复必须位于酷狗 adapter 内，不把来源字段泄漏到目录 module 或 UI。
3. 增加封面正常、封面缺失和空专辑列表的离线测试。
4. 不修改与本需求无关的酷狗搜索、歌单或下载逻辑。

## 验证标准

- [x] 正常专辑对象不会抛出 `TypeError`。
- [x] 缺少封面仍可返回专辑核心字段。
- [x] 多页专辑结果中的 albumId、声明曲数和顺序正确。
- [x] 酷狗 adapter 合同测试、目标 module 测试、lint 和 renderer build 通过。

## 修复与验证记录

- 已确认 Provider 封面字段为 `imgurl`，并对缺失封面返回 `null`。
- 已新增酷狗 mapper 固定样例，覆盖正常、缺封面、非法行与多页顺序。
- mapper 合同测试、目录 module 测试、Renderer TypeScript、仓库 lint、Renderer 构建与完整构建均通过，状态更新为 `verified`。
