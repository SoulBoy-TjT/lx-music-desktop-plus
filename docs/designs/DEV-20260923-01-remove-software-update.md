---
id: DEV-20260923-01
type: DEV
title: 移除软件更新检查
status: verified
created_at: 2026-09-23
updated_at: 2026-09-23
owner: KhalilFong
req_ids:
  - REQ-20260923-01
---

# 移除软件更新检查技术方案

- 删除 Main autoUpdate 初始化链和 Renderer useUpdate 初始化链；移除软件更新 IPC 与 electron-updater 类型引用。
- 删除版本镜像请求工具以及更新、联网变更日志两个弹窗；移除相关全局状态和仅供更新使用的持久化访问函数。
- 保留 SettingUpdate 组件路径，改为纯本地版本信息显示，保留构建信息和原开发者工具入口，避免文件改名带来的额外变更。
- 清理默认设置、类型及三语言更新专用键；package-lock 仅同步依赖移除，不升级其他依赖。保留发布工具和仓库历史变更日志。
- 不迁移或删除现有用户数据库、配置、歌曲。重新构建后既有安装包仍需另行打包才能包含本次修改。

## 验证

Main/Renderer 类型检查、定向 ESLint 和 production build 通过；最终主进程及界面产物断言未包含更新请求入口。实际桌面启动和安装尚未验证，安装包仍为上一轮版本。
