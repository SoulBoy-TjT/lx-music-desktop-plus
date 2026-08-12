---
id: BUG-20260810-03
type: BUG
title: 酷我专辑抓取固化 240 像素缩略图导致下载封面偏低
status: verified
severity: medium
created_at: 2026-08-10
updated_at: 2026-08-10
owner: KhalilFong
req_ids:
  - REQ-20260809-01
discovered_in_req_id: REQ-20260809-01
introduced_by_req_id: REQ-20260809-01
---

# 酷我专辑抓取固化 240 像素缩略图导致下载封面偏低

## 关联文档

- 来源需求：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 技术方案：[DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](../designs/DEV-20260809-01-four-source-artist-discography-playlists.md)
- 当日进度：[PROG-20260810](../progress/PROG-20260810.md)

## 发现方式

用户对比“刘雨昕XIN LIU”的本地 FLAC 后发现，酷我目录 10 个文件的内嵌封面全部为 `240×240`，对照目录 6 个文件全部为 `500×500`。共同曲目《你值得太阳》和《STRANGE》也稳定复现该差异。

## 实际行为

1. 酷我专辑详情的专辑图 URL 使用 `/star/albumcover/240/`，曲目图为空或不可用时 mapper 将该 URL 写入 `meta.picUrl`。
2. 下载后处理发现 `meta.picUrl` 已存在后直接作为 `APIC` 使用，绕过酷我既有 `pictype=500&size=500` 图片接口。
3. 标签写入器不缩放图片；本地《你值得太阳》和《STRANGE》的内嵌图片与实时 `/240/` 响应逐字节一致。

## 期望行为

1. 酷我目录 mapper 只对可信 `*.kuwo.cn` 主机、路径精确为 `/star/albumcover/240/` 的绝对或协议相对 URL，将尺寸段规范化为 `500` 后写入歌曲元数据。
2. 非酷我主机、相对 URL、查询参数中的数字、已经为其他尺寸的路径及非法 URL 保持既有行为，不进行宽泛替换。
3. 下载、超时、大小限制和写标签降级语义不变；已下载文件不自动改写，需要重新下载或另行重新嵌入封面。

## 验证标准

- [x] 脱敏固定样例覆盖酷我专辑级回退图和曲目级绝对图的 `240 → 500` 规范化。
- [x] 非酷我域名、相对 URL、查询参数、路径中段、已为 `500/1000` 及畸形 URL 不被误改。
- [x] 酷我 mapper/adapter、专题回归、Renderer TypeScript、定向 ESLint 与 Renderer 生产构建通过。
- [x] 真实只读 URL 复核同一封面 `/500/` 返回 `500×500`；真实 Electron 新下载和已有文件升级仍单独验收。

## 当前状态

已在酷我目录纯 mapper 中完成可信主机与标准路径的精确尺寸规范化。首轮回归先稳定复现两条 `/240/` 输出后转绿；独立审查新增“路径中段不得误改”红例并将 pathname 匹配锚定到路径起点。酷我 mapper/adapter 15 项、全专题 38 个文件 265 项、Renderer TypeScript、定向 ESLint 与 Renderer 生产构建均通过；真实只读复核同一图片为 `240×240 / 6,440 bytes` 与 `500×500 / 20,722 bytes`。既有音频文件未被修改；2026-08-10 15:55:37 生成的新 Windows x64 NSIS 安装包已通过 ASAR 源码图确认包含本修复，但尚未执行真实 Electron 新下载与封面读回。
