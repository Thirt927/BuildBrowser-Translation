# BuildBrowser Translation

Deadlock 出装浏览器(Build Browser)汉化 mod。把出装列表、出装详情、商城出装页和装备悬停提示里
**玩家撰写的英文说明**显示成中文,不需要 OCR、不需要本地翻译服务、不需要联网,装好即用。

> 技术路线参考了同目录的 BabelTower(Panorama 布局覆盖 + 本地桥)项目的经验,但本 mod **不依赖本地桥、不发起任何网络请求**:
> 译文在打包时就已写入 mod 内置的译文库(翻译记忆),游戏内只做哈希查表与文本替换。

## 翻译范围

| 位置 | 说明 |
| --- | --- |
| 出装浏览器列表 | 每条出装的名称(含 "的副本" 后缀的副本) |
| 浏览器右侧详情 | 出装名称、出装描述(`BuildDescription`) |
| 点击出装后的商城出装页 | 分类名称、分类描述、每件装备的注释(annotation) |
| 鼠标悬停装备 | 装备提示里的作者注释 |
| 悬停出装详情图标 | 出装名称 / 描述浮层 |

游戏自身的中文文本(装备名、装备描述、UI 文案、标签)不会被改动:mod 只处理"不是中文、也不以 `#` 开头"的
玩家内容,查不到译文的文本保持原样,短句会额外做一次"英雄/装备/段位名"术语替换。

## 安装

1. 把 `dist/pak13_dir.vpk` 复制到:
   `...\steamapps\common\Deadlock\game\citadel\addons\`
2. 完全退出并重启 Deadlock。
3. 打开出装浏览器(商城 → Browse / 出装)→ 列表与右侧描述应显示中文。

卸载:删除 `addons\pak13_dir.vpk` 即可。

## 工作原理

1. **布局覆盖**:`mod/panorama/layout/` 里覆盖了游戏原版的四个布局(结构由 Source 2 Viewer 从
   官方 `*.vxml_c` 反编译后原样保留,只增加了 `<scripts>` 引用):
   - `citadel_ui_build_selector.xml`(出装浏览器主体:列表 + 右侧详情)
   - `citadel_shop_mods_build.xml`(商城出装页 / 详情里的装备区)
   - `tooltips/citadel_tooltip_build_details.xml`(出装悬浮详情)
   - `tooltips/citadel_tooltip_mod_details.xml`(装备悬停提示)
2. **文本识别**:`bba_translate.js` 每 150ms 扫描当前布局子树,读取每个 Label 的文本;
   跳过 `#本地化token`、已含中文的文本和文本输入框。
3. **查表替换**:把文本规范化后做双 32 位哈希,在 `bba_tm.js`(打包时生成的翻译记忆)里查找中文译文,
   写回 Label。副本名称会先去掉 `的副本` / `(Copy)` 后缀再查。
4. **兜底**:查不到时,长度 ≤160 的短句会用 `bba_glossary.js`(游戏官方中英对照的英雄 / 装备 / 段位名)
   做一次术语替换,例如 `For bullet heavy opponents like Haze, Venator` → `... like 岚梦, 诛邪者`。

> Panorama 在 2026-10 的更新里移除了 `$.AsyncWebRequest`,游戏内 UI 无法发起 HTTP;
> 所以本 mod 采用"离线译文库"而不是实时机翻。这是能做到"零配置、秒出结果"的关键。

## 译文库是怎么来的

厂商/玩家撰写的出装文本无法预知,所以 `tools/` 里有一套离线流水线:

```powershell
# 1) 从本机游戏文件生成官方中英术语表(英雄/装备/段位/技能)
node tools/build_glossary.js --game-root "<Deadlock>/game/citadel"

# 2) 抓取 deadlock-api 上各英雄的热门公开出装(默认每英雄 50 条周热门 + 30 条历史热门)
node tools/fetch_builds.js --weekly 50 --alltime 30

# 3) 提取所有玩家文本 -> 免费 Bing 翻译 -> 写入 mod/panorama/scripts/bba_tm.js
node tools/build_tm.js --seed samples/sample-build-code.txt
```

想把自己常用的某条出装也收进译文库,用它在游戏详情页可复制的 Build ID:

```powershell
node tools/fetch_builds.js --ids-only --ids "674881,722319"
node tools/build_tm.js
```

- 翻译时会先把装备名 / 英雄名 / 段位名替换成占位符,译完再还原成官方中文名,避免机翻把 `Spirit Snatch`
  翻成奇怪的东西。
- 结果按"规范化文本的双哈希"存储,同一段描述出现在不同副本/不同出装里都能命中。
- `--seed` 可传入你复制出来的出装码文件(浏览器里的复制按钮给的就是这种 base64 码),
  让这条出装(尤其是你自己的出装)进入译文库。

### 解析复制出来的出装码

```powershell
node tools/build_code.js samples/sample-build-code.txt          # 输出完整 JSON(名称/描述/分类/每件装备注释)
node tools/build_code.js -c "<code>"    # 直接传码
```

格式为 `base64(zstd(CMsgHeroBuild protobuf))`,字段定义见 `tools/build_code.js` 顶部注释,
与 deadlock-api 的导出脚本一致。

## 构建

依赖:

- Reduced CSDK 12(提供 `resourcecompiler.exe`)
- `tools/vpkeditcli.exe`(已随仓库附带,来自 VPKEdit)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "<Reduced_CSDK_12 根目录>"
```

产物:`dist/pak13_dir.vpk`。加 `-Deploy` 可直接复制到默认游戏目录,
`-GameCitadel <path>` 可指定其它安装位置。

## 测试

```powershell
node tests\translate_simtest.js
```

离线模拟 Panorama 的 `$` API 与出装浏览器 DOM,验证:token 不被动、中文不被动、文本输入框不被动、
未知文本保持原样、译文库命中后能写回。

## 已知限制

- **只翻译译文库收录过的文本**。新发布的出装、冷门出装可能仍是英文(会有术语替换兜底)。
  跑一遍上面的流水线即可把最新热门出装补进译文库。
- 译文质量来自机器翻译 + 官方术语保护,个别句子可能生硬。
- 游戏大版本更新后,布局可能变化:需要重新用 Source 2 Viewer 反编译对应 `*.vxml_c`,
  更新 `mod/panorama/layout/` 里的覆盖文件(保持原有结构,只加 `<scripts>`)。
- 修改的是纯 UI 显示,不读写游戏内存、不与服务器通信、不改动任何游戏数据。

## 目录结构

```
mod/panorama/layout/          覆盖的原版布局(4 个)
mod/panorama/scripts/
  bba_translate.js            游戏内扫描 + 查表 + 替换
  bba_glossary.js             官方术语表(生成)
  bba_tm.js                   翻译记忆(生成)
tools/
  build_code.js               出装码 解析/编码
  build_glossary.js           从游戏本地化文件生成术语表
  fetch_builds.js             抓取热门出装
  build_tm.js                 生成翻译记忆
  providers/bing.js           免 Key Bing 翻译
scripts/build.ps1             编译 + 打包 + 部署
tests/translate_simtest.js    离线模拟测试
```

## 致谢

- [Source 2 Viewer / ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat):`*.vxml_c` 反编译
- [VPKEdit](https://github.com/craftablescience/VPKEdit):VPK 打包
- [deadlock-api](https://deadlock-api.com):公开出装数据
- BabelTower:Panorama mod 工程与踩坑经验

