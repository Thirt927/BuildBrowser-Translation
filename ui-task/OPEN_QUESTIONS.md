# OPEN_QUESTIONS — 出装浏览器翻译交互改造循环

> P0 不阻塞主线（选不动代码的保守方案继续，记「待人工确认」）；P1/P2 可留到终态。

## P0

- [x] **Q1 REA 逆向的输入源** [自批]：已按仓库内 S2V 反编译布局（`mod/panorama/layout/*.xml`）+ REA 对布局 XML/JS 的静态检查完成逆向（`docs/build-browser-logic.md` 110 函数语义图 + 六问证据）；原生 `pak01_dir.vpk` 本机在位（`E:\Steam\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk`）但引擎隐藏布局不入文件系统，逆向不受影响。
- [x] **Q2 详情页分类框的运行时生成时机** [自批]：实机取证证实——详情页 boot 行 root=`ShopModsBuild<BuildDetails_Overview<BuildDetails`，即分类/出装实例由引擎在详情页打开时**按需生成**（boot 计数随开/关页增减，11-06 17:35 段 12 条 CitadelShopModsBuild boot = 12 个实例）；R2 采用「增量观察」保守实现（tick 轮询 + 新面板 burst），与实测时序一致。
- [ ] **Q5 游戏启动可行性（um win 前置检查）[保守]**（2026-11-03 已查明大半，剩项按保守兜底）：`um` CLI = `F:/agents/universal-modder/bin/um.cmd`（已验证 `um win ps` 可用）；Steam appid = **1422450**（`steam://rungameid/1422450` + `appmanifest_1422450.acf`）；exe = `E:\Steam\steamapps\common\Deadlock\game\bin\win64\deadlock.exe`；游戏本体在位（AGENTS.md「无本体」注记已过期，首轮实测后更新文档）；部署走 `build.ps1 -Deploy`（会拷进 addons）；用户惯例 = 部署前先 `pak13_dir.vpk.bak-<ts>`。剩余未决（2026-11-06 收口）：实机点击级验证需人工执行（模型无读图，见 in-game-verification.md 的 IN_GAME BLOCKED(保守) 行与 `docs/buildui-report.md` 验证步骤）；启动不了 → 全部 `IN_GAME: BLOCKED(原因)` + 本条打 [保守]，离线证据照常收口。

## P0 追加（v1.9.27 收口，2026-11-06）

- [ ] **实机点击级验证（三 bug 终验）[保守]**：模型无读图/OCR + 盲驱动无法稳定打开出装浏览器详情页（B 键/Tab/坐标点击均不触发 CitadelHeroBuildsSelector boot）→ R1 按钮几何终验、R2 点击翻转全页翻/回原文、R4 作者说明翻中 三条记 BLOCKED(保守)，人工按 `docs/buildui-report.md` §实机验证步骤 执行；日志级代理证据已在 `ui-task/in-game-verification.md`（干净版 0 CSS 警告/0 探针行/双态 ver 行）。

- [ ] Q3 按钮三态（翻译/原文/中英对照）是否三态全要，还是只要「翻译/原文」两态（用户原话只提两态；默认两态，多态留开关）。
- [ ] Q4 作者注释漏翻的 key 集合：`collect_new_texts.js` 跑一次看 `extra_texts.json` 实际漏多少，决定走 TM 准入还是单独兜底。
