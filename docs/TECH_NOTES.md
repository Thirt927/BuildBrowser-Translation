# 技术笔记：BuildBrowser Translation

> 本文是"为什么这样做、踩过什么坑、还剩什么问题"的技术底稿。面向接手维护的人和 AI 代理。
> 使用说明看 [README](../README.md)，版本流水与历史遗留看 [TODO.md](../TODO.md)。

当前版本 **v1.9.75**（可发布版）。

---

## 1. 定位与两条路线

Deadlock 的出装内容（出装名、概览正文、分类标题/描述、每件装备的作者注释）全是玩家撰写的英文，
游戏本身不提供中文。本项目用 **Source 2 Panorama 布局覆盖 + 注入脚本**，在 UI 层把这些文本换成中文。

两条翻译来源，可同时存在：

| 路线 | 依赖 | 延迟 | 覆盖面 | 默认 |
| --- | --- | --- | --- | --- |
| 离线译文库（TM） | 无（译文打包进 VPK，约 4 MB / 5.8 万条） | 0 | 只有抓过、翻过的出装 | 可用 |
| 本地实时桥（bridge） | 本机 Node 进程 + `<HTML>` 面板 + 受信证书 | 0.8–2 s/请求，批量更快 | 任何出装（模型直翻） | 需手动启动 |

关键约束：**游戏 JS 不能发 HTTP**（`$.AsyncWebRequest` 已被引擎移除）。
唯一联网通道是布局里的 `<HTML>` 面板——它加载一个 HTTPS 页面，页面内的 JS 去 fetch 本地桥，
再把结果写进 `document.title`，游戏侧轮询 `panel.title` 读回来。这条路的每一个前提都必须成立，
缺一个就表现为「点了没反应」。

---

## 2. 系统结构

```
mod/panorama/
  layout/                     6 个覆盖布局（S2V 反编译原样 + 注入 <scripts>）
    citadel_ui_build_selector.xml        浏览器列表 + 右侧详情宿主
    citadel_ui_build_details.xml         详情面板本体（.BuildName/.BuildDescription/.BuildID）
    citadel_shop_mods_build.xml          游戏内商城出装页（分类帧 + 装备格）
    citadel_shop_mods_build_category.xml 分类帧
    tooltips/citadel_tooltip_build_details.xml
    tooltips/citadel_tooltip_mod_details.xml
  scripts/
    bba_translate.js   4134 行，扫描器 + 写回模型 + 双态开关 + 桥轮询（手写，核心）
    bba_tm.js          生成物，离线译文库（4.1 MB，勿手改）
    bba_glossary.js    生成物，官方术语表（59 条 + 扩展类型词）
    bba_layout_tokens.js 生成物，布局 class/id → #Token 对照
  styles/bba.css       BBTSrc/BBTProbe/工具条样式
tools/                 离线流水线 + 桥
  fetch_builds.js      deadlock-api 抓公开出装（周榜/历史榜/最近 45 天/作者）
  build_tm.js          Bing 机翻 + 术语占位符保护 → bba_tm.js（累积合并）
  build_glossary.js    从游戏本地化文件生成术语表（--merge-extra 合入手工词表）
  build_layout_tokens.js 布局 → token 对照表（--check 用于 CI）
  inject_scripts.js    把 <scripts> 注入反编译布局（幂等）
  collect_new_texts.js 收集游戏内 [BBT] MISS 的原文
  bridge/bridge.js     本地实时桥（8793，HTTPS，批量翻译 + 按 ID 取整份出装）
scripts/
  build.ps1            调 resourcecompiler + vpkeditcli → dist/pak13_dir.vpk（-Deploy 复制到 addons）
  refresh_tm.ps1       fetch_builds → build_tm → build.ps1 一条命令
  gen_bridge_cert.ps1  自签证书（CN=BBT-localhost，SAN=localhost/127.0.0.1/::1）
tests/                 14 个离线套件（不需要游戏）
```

数据流（游戏内一次「点翻译」）：

```
点按钮 → translatePage(root)
   ├─ prefetchBuildAnnotations：拿 build_id → 桥 GET /api/v1/build?build_id=…
   │     → 出装名 + 概览 + 8 个分类(标题/描述) + 37 条注释，一次性批量送翻
   ├─ collectMisses：扫全树收集「非中文、无 token、未命中缓存」的文本
   ├─ 有桥：uiRequestBatch（分批，术语先换 ⟦N⟧ 占位符）→ 回包还原 → uiApplyResults 写回
   └─ 无桥：离线 TM 查表 → 整句兜底(≥55%) → 术语兜底(≤160 字符)
```

---

## 3. 引擎事实清单（每条都踩过）

1. **`$.AsyncWebRequest` 已被移除**——游戏 JS 无法直接发请求；`<HTML>` 面板是唯一出口。
2. **`<HTML>` 面板必须走 HTTPS 且证书被信任**，且引擎**只在启动时**读信任库——换证书后必须完全重启 Steam。
3. **证书需要 SAN**。只有 CN 的自签证书会被 Chromium 拒绝（`ERR_CERT_COMMON_NAME_INVALID`），
   表现为「面板加载了但没有内容」。本项目证书：`CN=BBT-localhost`，SAN `localhost/127.0.0.1/::1`（`scripts/gen_bridge_cert.ps1`）。
4. **`<HTML>` 面板必须真正渲染出尺寸**，WebView 才会创建。`actuallayoutwidth === 0` 时页面脚本根本不跑：
   探针会一直等到超时，日志 `live probe deferred: HTML panel not rendered yet`。
   反过来，`display:none` / `visibility:collapse` 也会让它永不加载（1px + `opacity:0.01` 可以，折叠不行）。
5. **`<HTML>` 面板不能是 `<root>` 的直接子节点**，否则 resourcecompiler 报
   `Found root panel with 'id' attribute, which is not permitted.`——要嵌进布局的根面板内部。
6. **`{}` 模板标签不能被写 `.text`**。布局里 `text="#Citadel_HeroBuilds_BuildName"` 的标签，
   本地化值是 `{s:selected_hero_build_name}`；引擎用 `SetDialogVariable` 灌值。一旦我们写 `.text`，
   模板被替换，引擎之后再也写不进去 → 标签永远停在最后一次我们写的文本。
7. **`$.Localize(token, panel)` 对模板 token 返回空串**（本项目实测：`localize-probe … 2arg="" 1arg=""`）。
   所以「用 Localize 回读引擎新值」这条路对模板标签无效。
8. **每个商店实例只有一份变量存储**：给一个分类帧 `SetDialogVariable` 的值，会出现在另一个分类帧上
   （用户："分类注释看起来是覆盖的"）。这是 v1.9.67 失败、v1.9.71 回滚的直接原因。
9. **`visibility: collapse` 的 Label 不渲染 → `{s:var}` 不解析**，`.text` 停在原始 `#Token`。
10. **共享根面板上写 dialog variable 会"串味"**：没有自己值的行标签会继承当前选中名。
11. **Label 会吞点击**：按钮内的 `<Label>` 必须 `hittest="false"`，控件面板 `hittest="true"`。
12. **`onactivate="GlobalFn()"` 不可靠**（IIFE + 严格模式下静默失败）——一律 `panel.SetPanelEvent("onactivate", cb)`。
13. **多 JS 上下文**：每个布局一份独立上下文，`bba_tm.js` 等共享库必须带"每上下文只构建一次"的早退守卫；
    跨布局共享状态（比如双态开关）必须通过**根面板 class** 或引擎变量传递，不能靠模块变量。
14. **addons 里 pak 编号小者优先**：别的 mod 用 `pak11` 提供同名布局会整份压住我们的 `pak13`
    → "某处永远英文"第一排查 `node tools/vpk_list.js --addons "<addons 目录>"`。
15. **Panorama 的 `transform` 只接受函数式**：两参数 `translate(x, y)` 会被**静默丢弃**（无报错、无日志）；
    单参数 `translatey()` / `translate3d()` 正常。这一条害我们反复改位置无效。
16. **`horizontal-align: right` 会把控件推到父容器右缘之外**（父容器比可视区宽），表现为"按钮消失"。
17. **面板没有 `actualx/actualy`**；坐标只能 `GetPositionWithinWindow()`，且开局为 NaN，要等排版完成后再取。
18. **作用域陷阱**：`boot()` 与 `tick()` 是同一 IIFE 内的兄弟函数，`boot` 里的局部变量在 `tick` 里
    会 ReferenceError，而外层 `try{}catch{}` 会把它吞掉——日志"一条不出"往往就是这个。
19. **游戏内商城布局树有上千面板**，从全局根 BFS 会烧完预算 → 找 `<HTML>` 面板要停在"布局根"
    （`isLayoutRootTag()`：ShopModsBuild / ShopModsBuildCategory / BuildDetails / HeroBuildsSelector）。
20. **性能铁律**：轮询空闲退避（有变化 150ms → 无事翻倍到 1s）、布局不可见停摆、跳过不可见子树、
    命中 memo 后面板每 tick 只读一次 `.text`。**任何**新增的周期性扫描都会掉帧。
    另外，往 `<HTML>` 面板重复 `SetURL` 会触发一次完整 CEF 导航（几百毫秒卡顿）——桥失败后必须有看门狗，
    不能每轮重置面板。

---

## 4. 写回模型（最容易被改坏的部分）

历史上有三种模型，**现行是第三种，不要退回前两种**：

| 模型 | 做法 | 结果 |
| --- | --- | --- |
| v1.8.0 影子标签 | 藏起原标签，在旁边放自己的 Label 显示译文 | 折叠/0×0 的标签不解析 `{s:var}`，名称和概览全空 |
| v1.9.1 就地写 | 直接写引擎标签 `.text` | 引擎驱动的标签被"冻住"（事实 6/7），换出装后永远显示上一条 |
| **v1.9.73+ 分级放行** | 普通 Label 就地写；**引擎驱动的模板标签不写**（标题 / 分类描述） | 标题永远正确（英文），不会错名；其余照常翻 |

判定"引擎驱动"的两条依据：
- 类名：`SelectedBuildName`（商城顶部下拉框的显示位）；
- token：`#Citadel_HeroBuilds_CategoryDescription`（分类描述，每个分类帧一份变量，写谁串谁）。

想彻底解决，唯一干净的路是 **per-header 探针**：布局里加一个同 token 的 1px 副本让引擎驱动，
我们只读它、写可见的那个。这条路没走完（见 §7）。

其他写回要点：
- `memo`（WeakMap，面板 → `{k, in, out}`）避免重复写；`k=0` 表示"原文/无需翻译"，`k=1` 表示"已写译文"。
- `mode === "orig"` 分支从不写；若之前写过，先按 memo 还原。
- 双态开关状态通过根面板 class 广播（`tsSet`/`tsMode`），不靠模块变量。
- 点击「翻译」会 `live.gen += 1` 并清空队列：新点击抢占旧请求，避免"点了没反应"的串行排队。

---

## 5. 桥协议（`tools/bridge/bridge.js`，端口 8793）

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/v1/health` | GET | `{"ok":true,"name":"bbt-bridge",...}`，游戏探针用它判定可达 |
| `/api/v1/translate` | POST/GET | `{text:[...], target}` → `{translations:[...]}`，批量优先 |
| `/api/v1/build` | GET | `?build_id=…` 代理 `api.deadlock-api.com/v1/builds`，返回出装名/概览/分类/注释 |
| `/api/v1/tm/*` | GET/POST | lookup / overrides / remember / stats / translate（本地表增删查） |

- 游戏侧用 `<HTML>` 面板加载 `https://localhost:8793/?op=…&api=…&text=…`，页面把结果写进 `document.title`，
  游戏轮询标题取回；批量请求走 `op=batch`，一次最多 8 条 / 2500 字符。
- **术语保护在送桥前完成**：术语表命中的词替换成 `⟦N⟧` 占位符，模型看不到原词，
  回包后 `restoreTerms()` 还原官方译名（例：`Haze` 不会变成"哈兹"）。
- 探针顺序：先 8793（本仓库，支持批量 + 按 ID 取整份出装），再 8792（BabelTower/DeadlockLingua 的桥，逐条）。
- 没有桥时纯离线；离线库当前默认**开启**（`BBT_TM` 可运行时开关）。

---

## 6. 版本演进与三次回退（教训）

| 版本 | 关键变化 | 结果 |
| --- | --- | --- |
| v1.9.1 | 从影子标签改回就地写 | 修好了"全空"，埋下了"标题冻结" |
| v1.9.28 / v1.9.57 | 用 `$.Localize` 回读 + 补 `SelectedBuildName` 类名 | 逻辑正确但**对模板标签无效**（事实 7），游戏里始终没生效 |
| v1.9.29–v1.9.35 | 桥通道打通：布局根定位、证书 SAN、面板真正渲染、看门狗 | 第一次"点翻译真的出中文" |
| v1.9.48–v1.9.53 | 离线命中不再挡住桥批量、术语保护、tooltip 跟双态 | 概览页首次整段出中文 |
| v1.9.66–v1.9.71 | 双态跨上下文、caption、变量渲染、整页预取、整词术语 | **变量渲染导致分类串台、预取带来"八百"/"[0]"脏文本 → 整段回退** |
| v1.9.73 | 只保留"标题交给引擎"这一条 | 标题不再错名（英文） |
| v1.9.74 | 重新收进整页预取（v1.9.69）+ 整词术语（v1.9.70），**不含**变量渲染 | 一次点击填满整页；分类头 `Core→核心`、`Slot Capped→插槽上限` |
| v1.9.75 | 分类描述也交给引擎（同类串台） | 分类描述保持英文，但不再显示别的出装的内容 |

教训：
- **一次只改一个机制**。v1.9.66–71 是六个改动捆在一起上线，坏掉之后只能整段回退，
  连带丢掉了两个真正有用的特性（预取、整词术语），后来又花一轮重新挑回来。
- **"代码里对"不等于"游戏里生效"**。模板标签、变量存储、WebView 渲染这三处，离线仿真永远测不出来。
- **回退要能一条命令完成**：保留 `pak13_dir.vpk.bak-<时间戳>` 与 `git checkout <sha> -- mod/` 两条路，
  每次部署前记 md5，出问题先换包再查代码。

---

## 7. 待优化问题

按价值排序：

1. **per-header 探针**（根治标题/分类描述）：给 `BuildName`、`CategoryName`、`CategoryDescription`
   各配一个同名 token 的 1px 副本，引擎驱动探针、我们读探针写可见标签。工作量大，但能同时解决
   标题英文、分类描述英文、以及"写谁串谁"。
2. **首屏延迟与预取吞吐**（v1.9.77 实测确认）：一次点击要等 0.8–2 s 才有第一批译文；
   按 ID 预取按 **5 条/请求**分页（`tools/bridge/bridge.js` 的 `size = 5`），40 多条注释要串行十几次请求，
   10–20 s 才全部落进 `live.cache`。方向：提高单请求文本数（标题上限 6 KB，现在只用到约 1/5）、
   桥内部并发 `translateOne`、用户可见文本排到队首。
3. **`busy` 撞车**：预取链占住唯一的在飞请求（`live.pending`），期间点按钮会报
   `翻译失败: busy` / `translate: skipped, batch already in flight`。方向：交互请求优先，
   预取可被抢占（v1.9.65 已实现"新点击丢弃上一轮队列"，但预取链本身仍占槽位）。
4. **术语表扩充**：现在 59 条（英雄/装备/段位）+ 47 条类型词。目标 1000–1500 条常用术语
   + 300 条短语表（`lane` 相关、装备合成口语、常见缩写）。
5. **离线库默认值的取舍**：离线优先（快、无网、但对新出装无效）vs 桥优先（全，但慢）。
   现在是离线可用 + 桥优先生效时整批覆盖，需要按用户实测再定。
6. **性能量化**：大厅帧率曾从 ~16 FPS 掉到个位数，根因是每 tick 重置 `<HTML>` 面板（已修 + 看门狗）。
   需要补一个 `BBT_DEBUG` 下的 `[BBT] PERF fps= scanMs=` 长期观测。
6. **UI**：工具条的三个按钮在窄分辨率下会挤（已用 `translate3d` 下移一行），图标化/折叠菜单未做。
7. **构建**：仅 Windows（resourcecompiler + vpkeditcli）；Linux/macOS 需要等价的 Source 2 工具链。

---

## 8. 排障手册

游戏启动加 `-condebug`，看 `game/citadel/console.log`：

```powershell
grep -a "\[BBT\]" "E:/Steam/steamapps/common/Deadlock/game/citadel/console.log" | tail -40
```

| 日志 | 含义 |
| --- | --- |
| `[BBT] v1.9.xx loaded (tm=…, glossary=1) in layout: <Tag>` | 脚本加载成功；**没有这一行 = 布局没被覆盖**（查 pak 冲突） |
| `live probe deferred: HTML panel not rendered yet (actuallayoutwidth=0)` | 面板没渲染，桥用不了（正常，等界面打开） |
| `live bridge: connected to …` | 桥通了 |
| `live bridge: not available on 8793/8792; offline only` | 两个桥都没起来 |
| `[BBT] MISS <key> <原文>` | 离线没命中，走兜底；用 `tools/collect_new_texts.js` 收集 |
| `translate: scanned=… wrote=… miss=… scope=…` | 一次点击的汇总；`wrote=0 miss>0` 说明回包没落地 |
| `build prefetch id=… categories=8 todo=…` | 预取命中，整页一次填满 |
| `live req kind=batch n=… ok=true ms=…` | 桥耗时（正常 0.8–2 s） |
| `resync-unresolved #<token> text="…"` | 模板标签回读失败（预期，不要试图修，见事实 7） |

运行时开关（游戏控制台，不用重打包）：`BBT_DEBUG=true`（详细日志）、`BBT_TM="off"`（关离线）、
`BBT_LIVE="off"`（关桥）、`BBT_STATS`（累计计数）。

---

## 9. 构建与测试

```powershell
# 打包（十几秒；-Deploy 需先关游戏，否则 pak13 被锁）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "E:\dealoc-mod\Reduced_CSDK_12" -Deploy

# 全量离线测试（CI 跑这套，Node ≥ 22.15）
node tests\translate_simtest.js && node tests\tools_simtest.js && node tests\scene_verify.js &&
node tests\refresh_verify.js && node tests\fragment_verify.js && node tests\live_channel_simtest.js &&
node tests\tm_table_simtest.js && node tests\ui_button_simtest.js && node tests\vpk_list_simtest.js &&
node tests\toolbar_cover_simtest.js
node tools\build_layout_tokens.js --check
```

离线测试能覆盖：扫描器分类规则、写回模型、双态开关、桥协议（含批量与术语占位符）、
布局 token 对照、VPK 清单、UI 几何（CSS 断言）。**测不到**：模板标签的真实解析、
`<HTML>` 面板的 WebView 行为、引擎变量存储的串台、真实帧率——这四件事只能在游戏里验。
