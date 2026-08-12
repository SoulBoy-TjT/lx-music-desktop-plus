---
id: BUG-20260810-01
type: BUG
title: 网易歌手全局完全同名优先遮蔽正确别名结果
status: verified
severity: high
created_at: 2026-08-10
updated_at: 2026-08-10
owner: KhalilFong
req_ids:
  - REQ-20260809-01
discovered_in_req_id: REQ-20260809-01
introduced_by_req_id: REQ-20260809-01
---

# 网易歌手全局完全同名优先遮蔽正确别名结果

## 关联文档

- 来源需求：[REQ-20260809-01 四平台歌手专辑预览与来源歌单批量创建](../requirements/REQ-20260809-01-four-source-artist-discography-playlists.md)
- 业务决策：[BIZ-20260810-02 来源子集选择与歌手别名身份确认](../decisions/BIZ-20260810-02-source-subset-and-artist-alias-confirmation.md)
- 修订方案：[DEV-20260809-01 四平台歌手专辑抓取与批量写入技术方案](../designs/DEV-20260809-01-four-source-artist-discography-playlists.md)
- 当日进度：[PROG-20260810](../progress/PROG-20260810.md)

## 发现方式

用户以“刘雨昕”执行四平台抓取后，网易来源显示为名称“刘雨昕”、ID `60333962`、2 张专辑；用户确认网易目标艺人的 Provider 展示名实际为“刘雨昕XIN LIU”。原规则只接受完整展示名完全相等；加入严格别名段识别后，如果实现仍先在全部结果中查找 `exact`、再回退 `alias_exact`，后置的完全同名错误艺人仍会遮蔽 Provider 原始顺序中更靠前的正确别名结果。

问题位于 `REQ-20260809-01` 新增的四来源身份解析与统一确认流程，因此 `introduced_by_req_id` 关联本需求。

## 实际行为

1. 网易原实现只接受规范化后完整展示名等于输入的搜索项，“刘雨昕XIN LIU”会被当作模糊结果排除。
2. 若修复仅写成 `find(exact) ?? find(alias_exact)`，仍会跨越 Provider 原始顺序全局优先完全同名项。
3. 后置完全同名错误艺人会被提交给统一确认，随后抓取错误主体的专辑目录，即使正确的“刘雨昕XIN LIU”在搜索结果中更靠前。

## 期望行为

1. “刘雨昕”与“刘雨昕XIN LIU”在汉字到拉丁字母脚本边界形成完整别名段精确匹配。
2. adapter 按 Provider 原始稳定顺序选择第一个 `exact` 或 `alias_exact` 结果，两类资格相同，不全局优先 `exact`。当“刘雨昕XIN LIU”在前、完全同名错误艺人在后时，前者必须被选中。
3. 统一确认界面展示已选结果的 Provider 完整名称、ID、头像和可用声明专辑数，用户确认后才继续，取消或关闭不发起专辑请求。
4. 不使用任意子串、前缀、编辑距离、拼音或专辑数量自动推断身份；“刘雨”等不完整片段不得命中“刘雨昕XIN LIU”。
5. 系统等待全部已选来源身份解析 settled；解析失败来源保留 `failed`，只对成功身份非空子集统一确认并继续抓取。用户未确认成功子集前不开始专辑分页或详情请求；零个成功身份不弹确认。

## 影响

- 网易目录可能属于同名的错误主体，后续来源摘要、去重、歌曲数量和本地歌单均会建立在错误身份上。
- 界面虽展示名称和 ID，但若 adapter 先全局优先完全同名项，统一确认拿不到 Provider 顺序中更靠前的正确组合展示名结果。

## 修复约束

- 别名识别位于网易 adapter 的可测试纯 matcher，不在 UI 使用临时字符串包含判断。
- mapper 保留 Provider 搜索结果稳定顺序；adapter 用一次顺序扫描选择首个 `exact/alias_exact`，不得分两次 `find` 形成全局类型优先。
- 选中身份必须携带稳定 Provider ID；确认只展示该身份，不新增候选选择 UI，也不跨来源比较。
- 远端名称只按普通文本渲染，错误和日志不得包含 Cookie、请求正文或凭据。
- 默认测试使用脱敏固定响应，实时网易查询只作为显式只读冒烟。

## 验证标准

- [x] 输入“刘雨昕”时，“刘雨昕XIN LIU”被识别为 `alias_exact` 合法结果。
- [x] 固定样例按 Provider 顺序返回“刘雨昕XIN LIU”在前、完全同名错误艺人在后时，adapter 选择前者；反转顺序时仍选择原始顺序中的首个严格合法结果。
- [x] 完整展示名精确匹配、汉字/拉丁双脚本完整名称段及大小写归一均有正向固定样例。
- [x] 任意 contains、不完整前后缀、相似名、拼音近似和空输入均有拒绝样例。
- [x] 单个来源身份解析失败能定位并保留 `failed`，不阻断其他成功身份在 all-settled 后确认和抓取；全部失败时不弹确认，取消或未完成确认不会发起专辑请求。
- [x] 定向专题测试、Renderer 类型检查、定向 lint 和 Renderer 生产构建通过。
- [ ] 真实 Electron 统一确认尚未人工核对“刘雨昕XIN LIU”的 Provider 原名和正确 ID。

## 修复与验证记录

- `classifyWyArtistNameMatch` 对名称执行 NFKC、trim、空白折叠和拉丁字母小写归一；只接受完整展示名 `exact` 或严格汉字/拉丁双脚本完整名称段 `alias_exact`，不使用任意包含或近似匹配。
- 网易 adapter 以一次 `searchResult.artists.find(artist => classifyWyArtistNameMatch(...) != null)` 保留 Provider 原始稳定顺序，不再用全局 `exact` 优先遮蔽前置别名结果；canonical `/api/artist/{id}` 返回后再次执行同一严格身份校验。
- 网易 adapter 与 mapper 完整定向回归共 33 项通过；core batch 25 项通过，覆盖所选来源 all-settled、失败来源保留、成功身份非空子集单次确认和零成功不弹确认。
- 最终关联定向共 5 个测试文件、62 项测试全部通过；Renderer TypeScript、core + Tools + 网易定向 ESLint 和 `npm run build:renderer` 均通过。
- 临时只读 Vitest 直接 POST 网易搜索“刘雨昕”：Provider 首项为 `{ id: 12217134, name: '刘雨昕XIN LIU', albumCount: 24 }`，第二项为 `{ id: 60333962, name: '刘雨昕', albumCount: 2 }`；按稳定顺序选择首个合法结果得到 ID `12217134`，随后 GET canonical 详情仍为“刘雨昕XIN LIU”，1/1 通过。临时测试文件已删除。

## 当前状态

严格双脚本名称段和 Provider 稳定顺序修复已取得固定样例、批次回归、Renderer 静态/构建及真实网易身份只读冒烟证据，状态更新为 `verified`。真实冒烟只验证身份搜索与 canonical 详情，没有抓取专辑、创建歌单或执行真实 Electron UI；这些边界继续由 `REQ-20260809-01` 验收。
