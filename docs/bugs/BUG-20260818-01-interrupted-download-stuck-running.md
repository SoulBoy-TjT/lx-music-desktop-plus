---
id: BUG-20260818-01
type: BUG
title: 下载响应中途断开后任务停留在运行状态
status: fixed
severity: high
created_at: 2026-08-18
updated_at: 2026-08-18
owner: KhalilFong
req_ids:
  - REQ-20260811-01
discovered_in_req_id: REQ-20260811-01
introduced_by_req_id: null
---

# 下载响应中途断开后任务停留在运行状态

## 关联文档

- 需求：[REQ-20260811-01 下载音频真实格式校验与降级发布](../requirements/REQ-20260811-01-download-actual-format-publication.md)
- 技术方案：[DEV-20260811-01 下载真实格式校验与元数据发布技术方案](../designs/DEV-20260811-01-download-actual-format-publication.md)
- 当日进度：[PROG-20260818](../progress/PROG-20260818.md)

## 现象与根因

部分歌曲已经接收一段数据后，下载进度永久停在最后一次上报值；用户必须手动暂停并重新开始，任务才会从临时文件断点续传。

Node HTTP 响应中途断开时会报告 `ECONNRESET` 且错误消息为 `aborted`。Downloader 先把内部状态改为 `ERROR`、清除无数据超时并关闭请求，随后对该消息直接返回而不发出 `error` 事件；请求包装层还会忽略 `socket hang up`。Download Worker 因而收不到可重试错误，Renderer 继续保留 `run` 状态，任务也持续占用并发槽位。

下载自身不申请 `powerSaveBlocker`，系统休眠、网络切换或 Provider/CDN 主动断流都可能触发连接终止；本地 HTTP 服务无需系统休眠即可稳定复现，因此休眠不是必要根因。

## 期望行为与验证边界

- 已接收部分数据的响应异常终止时，Downloader 必须恰好上报一次错误，不得把网络断流收敛为用户暂停。
- Download Worker 必须沿用现有重试上限，关闭旧连接后从临时文件发起 Range 续传；初次失败后最多自动重试 2 次，第 3 次失败进入明确错误终态并释放并发槽位。
- 用户主动暂停、删除或旧 generation 的迟到事件不得触发自动重试。
- 回归必须通过本机 HTTP 服务真实中断响应，并从 Worker 公开 `startTask` seam 观察 Range 重试或终态错误；不得只断言私有方法。

## 修复与验证结果

- `Downloader` 不再忽略 `aborted`；响应以 `complete=false` 结束时改为上报传输错误。错误会先等待当前写流完全关闭再唯一上报，每次 `start()` 的 attempt token 同时隔离旧请求、响应、超时和磁盘初始化回调。
- 下载请求包装层不再忽略 `socket hang up`，错误能够进入 Download Worker 既有的最多两次自动重试；已有 transfer 文件继续使用 10 字节重叠校验的 Range 续传。
- 本地 HTTP 纵向回归从 Worker 公开 `startTask` seam 证明“发送一半后销毁响应”会按精确 Range 自动续传并逐字节还原完整音频，“响应头前销毁 socket”连续 3 次时会发起两次自动重试并在第 3 次失败后进入错误终态。
- Downloader 回归覆盖 `complete=false` 的 `end` 恰好上报一次错误、写流关闭前不重试、主动停止不报错、旧 response 与旧磁盘初始化回调不影响新 attempt，以及 mismatch 错误不被销毁请求产生的 `aborted` 抢占。
- 下载发布、断点续传和 generation 相关 3 个测试文件共 47 项全部通过；扩展下载回归 5 个文件、59 项全部通过。
- Common/Renderer `tsc --noEmit`、4 个变更 TypeScript 文件定向 ESLint、全量 `npm run lint` 与 Renderer production webpack 均退出 0。
- 尚未在真实 Electron 安装态执行受控断流或休眠/唤醒下载，因此状态收口为 `fixed`，不标记为 `verified`。
