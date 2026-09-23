---
id: BUG-20260923-01
type: BUG
title: 安装包混入开发主进程导致页面无法加载
status: verified
created_at: 2026-09-23
updated_at: 2026-09-23
owner: KhalilFong
req_ids:
  - REQ-20260923-02
discovered_in_req_id: REQ-20260923-02
introduced_by_req_id: null
---

# 安装包混入开发主进程导致页面无法加载

- 现场：安装路径 app.asar/dist/main.js 包含 eval-source-map、开发入口和编译固化的 localhost:9080 URL，导致 chrome-error://chromewebdata/ 及自动打开开发工具；包内 index.html 存在，非安装路径缺文件。
- 已安装 main.js 与当时 dist/main.js 一致，说明上一轮“包与 dist 一致”校验未检查正式构建属性。当前未发现仍运行的开发编译器，不能断言具体改写进程；共用 dist 和缺少产物模式校验是已确认缺口。
- 修复：四个开发 webpack 配置及开发启动器改用 .dev-dist；正式打包前校验入口/静态引用和开发标志，打包后对 app.asar 重复同一校验。开发启动器准备原生模块时不执行正式产物检查。
- 回归：旧产物断言失败，新 guard 拒绝旧 dist/main.js；7 项内存输入测试通过；四个开发配置输出隔离断言通过，定向 ESLint 通过。
- 全部正式构建、NSIS 打包及 asar 校验通过。实际启动 build/win-unpacked/lx-music-desktop.exe（独立 --user-data-dir、隐藏窗口和本地 CDP），页面 URL 为包内 file:///.../app.asar/dist/index.html，#container 存在且 #root 可见。截图显示完整应用及新用户协议页。未代用户接受协议，未覆盖已安装应用。
- 新安装包 SHA-256：ADAD310CD1FB0664F6AF44F7D9741B8DE02727B104D279175EC8D31F85CCD7DA，142609570 字节。7za t 返回 0，含 NSIS 尾部数据提示。此前两个安装包应由该包替代。
