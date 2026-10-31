# 布局清单(靠 mod 逆向得到的部分,无需游戏本体)

> 这份清单是把 GameBanana 上 Deadlock(游戏 ID 20948)的 UI / QoL / 翻译类 mod 下载下来、
> 用自研 VPK 解析器(`tools/vpk_list.js`)读目录、再用 Source2Viewer-CLI 20.1(Linux)
> 反编译得到的。目的是回答:**出装相关界面到底由哪些布局文件组成,我们覆盖了几个。**

## 结论速览

| 布局文件 | 作用 | 本 mod 是否覆盖 |
|---|---|---|
| `citadel_ui_build_selector` | 出装浏览器主体(列表 + 右侧 `<CitadelBuildDetails>`) | ✅ |
| `citadel_ui_build_details` | 右侧详情(独立布局,被嵌进 selector) | ✅ |
| `citadel_shop_mods_build` | 商店页的出装内容容器 | ✅ |
| `citadel_shop_mods_build_category` | **分类名 + 作者写的分类说明(概述区文字)** | ✅(v1.7.5 补上) |
| `tooltips/citadel_tooltip_mod_details` | 装备悬停提示(含作者注释) | ✅ |
| `tooltips/citadel_tooltip_build_details` | 出装悬停提示 | ✅ |
| `popups/citadel_popup_build_browser` | **从 HUD/商店弹出的出装浏览器弹窗** | ❌ 未覆盖(它内部就是 `<CitadelHeroBuildsSelector>`,内容靠上面的 selector 覆盖生效;只有弹窗标题是英文) |
| `citadel_hud_hero_builds` | HUD 上显示当前出装名 | ❌(本 mod 无需翻译,游戏自带中文) |
| `citadel_hud_active_player_stats` / `citadel_hud_modifier_message` / `hud_data_feed` / `unit_status_overlay_v2` / `citadel_dashboard_footer_bar` / `base_hud` / `popups/popup_settings` / `profile_card` / `citadel_db_page_profile` / `switchboard_panel` | 其它界面(与本 mod 无关) | — |

**所以出装相关界面共 7 个布局,我们覆盖了 6 个**;剩 `popups/citadel_popup_build_browser` 只有标题需要翻,
而且它内容依赖的 selector 已被覆盖。

## 各布局的来源 mod(可用于复核/取样本)

| 布局 | 提供它的 mod |
|---|---|
| `citadel_shop_mods_build_category` | Shop Category Overflow Fix (698925) |
| `popups/citadel_popup_build_browser` | Better Builds (725437) |
| `citadel_hud_hero_builds` | Show Your Selected Build ID / Name On HUD (661830) |
| `citadel_hud_active_player_stats` | Active Stats (718536) |
| `citadel_hud_modifier_message` | Occult Ledger (728438) |
| `chat` / `hudchat` | Babel Tower (700107) |
| `base_hud` | Anita-UI (648899) |
| `profile_card` / `popups/citadel_popup_global_leaderboard` | Statlocker Integration (675877) |

## 重要限制

- **mod 只打包它改过的文件**,拿不到原生布局。上表里"未覆盖"的那一个,以及任何我们还没发现的
  新布局,都只能从游戏 `game/citadel/pak01_dir.vpk` 里枚举 —— 这个文件是唯一权威来源。
- `citadel_shop_mods_build_category` 的覆盖文件是从 mod 的副本里恢复的(删掉了那个 mod 自己的
  样式引用),**建议拿到游戏本体后用 `tools/get_layouts.ps1` 重新生成一次**,以保证与最新补丁一致。
- GameBanana 有速率限制(连续请求会 403),批量扫描要放慢;本仓库只保存扫描结论,不保存 mod 内容。

## 怎么自己再扫一遍(可选)

```powershell
# 1) 把可疑 mod 下载下来,确认它带了哪些 VPK
node tools\vpk_list.js "<mod>.vpk" --filter panorama/layout

# 2) 反编译某个 vxml_c(需要 Source2Viewer-CLI)
Source2Viewer-CLI -i "<mod>.vpk" -f "panorama/layout" -o out -d

# 3) 反编译结果里搜 token,判断它与出装界面有没有关系
node tools\find_layouts.js out --token Citadel_HeroBuilds
```

Linux / WSL 运行 CLI 时若报 ICU 错误:`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` 即可。
