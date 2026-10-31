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

> **首次安装 / 找不到生效时检查 `gameinfo.gi`**:`game/citadel/gameinfo.gi` 的
> `SearchPaths` 里必须有 `Mod citadel` 和 `Game citadel/addons`(该文件偶尔随游戏更新被重置,
> 需要重新编辑)。参考 [Deadlock Modding Notes](https://deadlockmodding.pages.dev/installing-mods)。
>
> **pak 编号决定优先级**:addons 里所有 `pak##_dir.vpk` 中**编号小者优先**。本 mod 是
> `pak13_dir.vpk`;如果你还装了别的 mod 且它也覆盖了同样的布局,编号比 13 小的那个会
> 压住本 mod(这常表现为"部分位置不翻译")。用 VPKEdit 看各 pak 的文件树即可定位。

## 工作原理

1. **布局覆盖**:`mod/panorama/layout/` 里覆盖了游戏原版的五个布局(结构由 Source 2 Viewer 从
   官方 `*.vxml_c` 反编译后原样保留,只增加了 `<scripts>` 引用):
   - `citadel_ui_build_selector.xml`(出装浏览器主体:列表 + 右侧详情的宿主)
   - `citadel_ui_build_details.xml`(右侧详情面板本体:`.BuildName` / `.BuildDescription`;
     引擎可能把它挂到选择器之外,所以必须单独覆盖)
   - `citadel_shop_mods_build.xml`(商城出装页 / 详情里的装备区)
   - `tooltips/citadel_tooltip_build_details.xml`(出装悬浮详情)
   - `tooltips/citadel_tooltip_mod_details.xml`(装备悬停提示)
2. **文本识别**:`bba_translate.js` 每 150ms 扫描当前布局子树,读取每个 Label 的文本;
   跳过 `#本地化token`、已含中文的文本和文本输入框。
3. **查表替换**:把文本规范化后做双 32 位哈希,在 `bba_tm.js`(打包时生成的翻译记忆)里查找中文译文,
   写回 Label。副本名称会先去掉 `的副本` / `(Copy)` 后缀再查。
4. **兜底**:查不到时,长度 ≤160 的短句会用 `bba_glossary.js`(游戏官方中英对照的英雄 / 装备 / 段位名)
   做一次术语替换,例如 `For bullet heavy opponents like Haze, Venator` → `... like 岚梦, 诛邪者`。

> **关于"游戏内不能联网"**:`$.AsyncWebRequest` 确实被移除了,但 `<HTML>` 面板里的浏览器
> 仍然能联网——前提是页面走 **HTTPS 且证书被引擎信任**(参考 Deadlock Modding 的 BabelTower
> 桥,本仓库独立实现)。利用这点,本 mod 支持一条**可选的实时通道**:详情见下节。
> 默认仍是离线译文库:不装任何额外程序也能用。

## 可选:实时翻译通道(bridge)

离线译文库只能覆盖抓取过的出装。想连新出装也立刻出中文,可以让一个**本机 bridge 进程**接住
译文库里没有的文本。原理与 BabelTower 的 `btipc-https` 一致:

```
Panorama 隐藏 <HTML id="BBTBridgePanel">
   → 导航 https://localhost:8793/bridge?id=..&text=..
   → 页面内同源 fetch /api/v1/translate → bridge 用 Bing(免 Key)翻译
   → 结果写进 document.title("BBT<id>{...}") → 游戏侧 0.1s 轮询读回 → 写入 Label
```

**已经装了 Babel Tower / DeadlockLingua?那你什么都不用做。**
mod 启动时会先探 8792(你的 BabelTower 桥),探通就直接用它翻译,证书也是它那份 ——
不用再装第二张证书、也不用再起第二个进程。只有在你没有那个桥时,才需要下面这套一次性准备:

```powershell
# 1) 生成并信任本机自签证书(装进 CurrentUser\Root,无需管理员)
powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Trust
#    (脚本会先检查是否已有可复用的 BabelTower 证书;有就跳过生成)
# 2) 完全退出 Steam(含托盘图标)再启动 —— 引擎只在启动时读取信任库
# 3) 启动 bridge,并可选设为开机自启(无控制台窗口)
node tools\bridge\bridge.js
powershell -ExecutionPolicy Bypass -File scripts\install_bridge_autostart.bat
```

探测顺序:先 **8792(DeadlockLingua 的桥)**,再 **8793(本仓库 bridge)**,都不通就永久回到离线模式。

### 连到 DeadlockLingua 时,复用的是"它"的哪些东西

我们的请求是 `/bridge?id=..&op=translate&d={"operation":"translate","text":..,"targetLanguage":"zh-Hans"}`
—— **不带 `provider` 字段**,所以 lingua 的 `runTranslate` 会用它自己的配置
(`payload.provider || cfg.provider`)。也就是说下面这些全部沿用它的设置:

| 复用的东西 | 说明 |
|---|---|
| **翻译服务商**(provider) | 在 lingua 的 `config/config.json` 的 `provider` 里配(如 `bing`/`openai`/`deepl`/`google`/`microsoft`),我们不改 |
| **API Key** | 用 lingua 配好的 key(如果它用的是付费 provider,消耗的是那份额度) |
| **回退链**(fallbackProviders) | 主服务商失败时由 lingua 自己回退,我们只等结果 |
| **词典**(dictionary) | 命中词典直接返回,术语更稳定;它还会把我们翻过的文本记入自适应词典 |
| **缓存** | 同文本直接命中它的缓存,零延迟 |
| **目标语言** | 我们显式发 `zh-Hans`(本 mod 只带中文译文库);其余场景 lingua 用它自己的 `defaults.targetLanguage` |

连接成功后 console 会打印实际使用的服务商:

```
[BBT] live bridge: connected to DeadlockLingua Bridge (localhost:8792, provider=bing), offline memory + live fallback
```

想临时关掉实时通道(不改包、不重启游戏):控制台执行 `BBT_LIVE = "off"`;
恢复自动探测:`BBT_LIVE = "auto"`。当前使用的服务商可从 `BBT_STATS.liveProvider` 读到。

> 代价提醒:如果 lingua 里配的是**付费**服务商(OpenAI / DeepL),实时通道翻 UI 文本也会走它。
> 不想花额度就把 `BBT_LIVE` 设为 `"off"`,或把 lingua 的 provider 设为 `bing`(免 Key)。

**实时翻译会沉淀成离线数据**:bridge 把翻过的文本写进 `tools/cache/live_seen.json`(同时写入
`tools/cache/translations.json` 缓存),下次跑 `build_tm.js` 时自动并入 `bba_tm.js` ——
玩家实际看到的文本逐步变成"开箱即离线"。

特性与边界:

- **完全可选**:bridge 不在时,启动探针失败一次就永久关闭本会话的实时通道,行为与纯离线版一致
  (`tests/live_channel_simtest.js` 覆盖"桥死了不乱发请求")。
- **优先级**:离线译文库 → 整句兜底 → **实时通道** → 术语替换。也就是已收录的文本永远不会
  触发网络请求。
- **升级**:离线阶段只做了术语替换的文本,在 bridge 连上后会自动用原文重新翻一遍。
- **限流**:同一时刻只有一个请求在飞(`document.title` 是单通道),结果在会话内缓存;
  连续 3 次硬失败即放弃本会话。
- **隐私**:只发送当前页面里"译文库中没有的英文文本",不发送账号/战绩;日志里不落原文。
- 卸载实时通道:停掉 bridge 进程即可,mod 自动退回离线模式;开机自启用
  `scripts\remove_bridge_autostart.bat` 移除。

## 译文库是怎么来的

厂商/玩家撰写的出装文本无法预知,所以 `tools/` 里有一套离线流水线:

一步到位(推荐):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\refresh_tm.ps1 -GameCitadel "<Deadlock>/game/citadel"
```

分步执行:

```powershell
# 1) 从本机游戏文件生成官方中英术语表(英雄/装备/段位/技能)
node tools/build_glossary.js --game-root "<Deadlock>/game/citadel"

# 2) 抓取 deadlock-api 上的公开出装,三个来源合起来才是"尽量全":
#    --weekly/--alltime  游戏内浏览器同样按"周/历史收藏"排名的那些
#    --recent            最近 45 天被更新过的(新出装没有收藏数,靠这个抓)
#    --author            你自己的出装(永远不上榜,靠这个抓)
#    --lang English      机翻方向是 英->中,只抓英文出装(中文出装本来不用翻)
node tools/fetch_builds.js --weekly 50 --alltime 30 --recent 40 --lang English

# 3) 提取所有玩家文本 -> 免费 Bing 翻译 -> 写入 mod/panorama/scripts/bba_tm.js
node tools/build_tm.js --seed samples/sample-build-code.txt
```

想把自己常用的某条出装也收进译文库,用它在游戏详情页可复制的 Build ID:

```powershell
node tools/fetch_builds.js --ids-only --ids "674881,722319"
node tools/build_tm.js
```

或者直接把**你自己的 Steam 账号 ID** 传进去(你的全部公开出装都会进译文库,
它们通常不在热门榜上,没有这一步很容易漏译):

```powershell
node tools/fetch_builds.js --author "你的SteamID64"   # 会同时抓热门榜
node tools/build_tm.js
```

- **译文库是累积的**:每次生成 `bba_tm.js` 都会先解析旧文件,把旧条目全部保留,
  再并入本次翻译的新条目。热门榜上掉下去的老出装、`tools/cache` 被清掉的机器
  都不会再丢失已有译文。
- 翻译时会先把装备名 / 英雄名 / 段位名替换成占位符,译完再还原成官方中文名,避免机翻把 `Spirit Snatch`
  翻成奇怪的东西。
- 结果按"规范化文本的双哈希"存储,同一段描述出现在不同副本/不同出装里都能命中。
- `--seed` 可传入你复制出来的出装码文件(一行一条可以传多条),让这些出装(尤其是你自己的出装)
  进入译文库;多个文件用逗号分隔。

### 游戏内自动收集未翻译文本

出装浏览器的公开列表按**每日收藏**排序,而 deadlock-api 只提供每周/历史收藏,所以总会有
"当天的冷门/新出装"不在离线译文库里。这些文本现在会在游戏内被记录下来,再自动补进译文库:

1. 给 Deadlock 加启动项 `-condebug`,正常浏览/切换出装(每个布局实例最多记 300 条,去重);
2. `game/citadel/console.log` 里会出现:
   `[BBT] MISS <key> <英文原文>`
3. 收集并翻译:

```powershell
node tools/collect_new_texts.js                    # 自动找 console.log,合并进 tools/cache/extra_texts.json
node tools/build_tm.js                             # 翻译新增文本并重建 bba_tm.js
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "<CSDK>" -Deploy
```

`build_tm.js` 会把 `extra_texts.json` 当作额外语料,和热门出装一起走术语保护 + 机翻,
并**累积合并**旧译文库,不会丢已有条目。

> 翻译缓存 `tools/cache/translations.json` 是断点续跑的依据:Bing 触发验证码/限流、
> 或手工中断后,重新执行 `node tools/build_tm.js` 会从已翻译的部分继续,不会重头再来。
> Release 页的 `tm-cache-v1.1.0.zip` 里带了 `builds.json` + `translations.json` 快照,
> 解压到 `tools/cache/` 后可直接增量重建,不必重新抓取 6,800 条出装、重跑全部机翻。

### 解析复制出来的出装码

```powershell
node tools/build_code.js samples/sample-build-code.txt          # 输出完整 JSON(名称/描述/分类/每件装备注释)
node tools/build_code.js -c "<code>"    # 直接传码
node tools/build_code.js --json build.json   # 把(改过文本的)JSON 重新编码成可粘贴的出装码
```

格式为 `base64(zstd(CMsgHeroBuild protobuf))`;也接受未压缩的裸 protobuf(按 zstd 魔数
`0x28b52ffd` 自动判别)。文件里一行一条码时,会逐条解析并在单个 JSON 数组中输出;
`encode()` 是无损往返(保留 `ability_order`、`development_build` 等全部已解码字段)。
字段定义见 `tools/build_code.js` 顶部注释,与 deadlock-api 的导出脚本一致。

## 构建

依赖:

- Node.js **≥ 22.15**(推荐 24;出装码是 base64(zstd),需要内置 zstd 解压)
- Reduced CSDK 12(提供 `resourcecompiler.exe`)
- `tools/vpkeditcli.exe`(已随仓库附带,来自 VPKEdit CLI;sha256 `DF354E59…5984B582A`,
  需要更新时用 [VPKEdit](https://github.com/ValveResourceFormat/VPKEdit) 的 `vpkeditcli` 覆盖)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "<Reduced_CSDK_12 根目录>"
```

产物:`dist/pak13_dir.vpk`。加 `-Deploy` 可直接复制到默认游戏目录,
`-GameCitadel <path>` 可指定其它安装位置。

## 测试

```powershell
node tests\translate_simtest.js
node tests\tools_simtest.js
node tests\scene_verify.js
node tests\perf_probe.js
node tests\refresh_verify.js
node tests\layout_dom_simtest.js --layouts "<反编译后的 layout 目录>"
```

- `translate_simtest.js`:离线模拟 Panorama 的 `$` API,验证 token 不被动、中文不被动、
  文本输入框不被动、未知文本保持原样、译文库命中后能写回、副本名的"的副本"标记保留。
- `tools_simtest.js`:纯离线,验证出装码 解码/编码 无损往返、裸 protobuf 解码、
  旧译文库可解析(累积合并)、术语保护与还原。
- `scene_verify.js`:针对"右侧详情 / 悬停提示 / 商城页"三个用户关心场景,在仓库自带的
  5 个覆盖布局上灌真实样本文本,验证译文命中(不依赖游戏文件)。
- `node tools\build_layout_tokens.js --check`:`bba_layout_tokens.js`(布局里 class/id →
  `text="#Token"` 的对照表)是否与覆盖布局同步。
- `perf_probe.js`:量测译文库启动成本与每 tick 扫描成本(变更检测 + 空闲退避是否生效)。
- `refresh_verify.js`:切换出装/装备后译文必须跟着刷新。覆盖:直接写 `label.text`、
  `text="#Token"` + `SetDialogVariable`(变量绑定)、tooltip 反复复用、以及"相对时间标签
  跳动不能引发重写风暴"四种情形。
- `layout_dom_simtest.js`:用游戏原版反编译布局搭出真实的嵌套面板树(列表 → 详情 →
  出装分类 → 装备注释 / 装备提示),灌入真实出装文本,验证各位置的文本都会被替换。
  需要先用 Source 2 Viewer 反编译 `panorama/layout`(见"排查"第 4 条),缺省时自动 SKIP。

## 已知限制

- **只翻译译文库收录过的文本**。新发布的出装、冷门出装可能仍是英文(有术语/整句兜底)。
  想让新出装也变中文,需要重新生成译文库并重打 VPK(见下节"出装更新了怎么办")。
- 译文质量来自机器翻译 + 官方术语保护,个别句子可能生硬。
- 游戏大版本更新后,布局可能变化:需要重新用 Source 2 Viewer 反编译对应 `*.vxml_c`,
  更新 `mod/panorama/layout/` 里的覆盖文件(保持原有结构,只加 `<scripts>`)。
- 构建链路目前只支持 Windows(resourcecompiler + vpkeditcli.exe);
  Linux/macOS 需要自行提供等价工具(见 TODO.md)。
- 修改的是纯 UI 显示,不读写游戏内存、不与服务器通信、不改动任何游戏数据。

## 界面上的按钮(翻译本页 / 语言切换)

出装浏览器头部右侧多了一个小工具条:

```
[ 翻译本页 ] [ ▾ ]
               ├ 显示中文          (默认)
               ├ 显示原文          (对照用)
               ├ 中英对照          (译文 + 空行 + 原文)
               ├ 把新译文存入本地库
               └ 查看本地库统计
```

- **翻译本页**:把屏幕上"译文库和本地库都没有"的文本一次性送去翻译(bridge 在线时)。
  按钮上会显示"翻译中… N"、"已翻译 N 条"、"未连接翻译桥"等状态。
  连 DeadlockLingua 的桥时它一次只收一条,连本仓库的 bridge 时一组 8 条打包成 1 个往返。
- **语言切换**:`zh` / `orig` / `both` 三态,存进 `$.PersistentStorage`,重启游戏后保留。
  切到"原文"时会把界面还原成原始英文(不是重新翻译),切回"中文"立刻恢复。
- **把新译文存入本地库 / 查看统计**:手动把当前页已翻译的内容写进本地库,并查看条目数。

## 本地翻译库为什么会自动变大,又怎么保证不变太大

译文库不再只有"打包在 VPK 里"这一份:bridge 侧维护一个**会自己长大的本地库**
`tools/cache/tm_table.jsonl`(+ 压缩后的 `tm_table.json`)。查表顺序是
**离线库 → 本地库(精确/模板/近似)→ 整句兜底 → 实时翻译**。

新文本太多会把库撑爆,所以每条文本都被压成最多三个键(`tools/tm_table.js`):

| 键 | 规则 | 效果 |
|---|---|---|
| **exact** | 规范化(空白/大小写/标点)后的双哈希 | 完全相同的文本只存一条 |
| **template** | 把数字/百分比换成 `«n»` 再哈希 | `+20% damage` 与 `+35% damage` 合成一条,查表时把数字填回去 |
| **shingle** | 模板文本的 64 位 SimHash,按前 16 位分桶;**汉明距离阈值随句子长度自适应**(短句严格 2,长句放宽到 5) | 少一个词/多一个词/语序小改不新增条目,短句又不会误合并 |

**容量控制(五道闸)**:

1. **准入**:只有"出现过 ≥2 次"或"长度 ≤120 字符"或"你点了按钮"的文本才入库,一次性的长句丢弃;
2. **别名折叠**:变体不新增条目,只挂成别名,**每个条目最多 8 个别名**,超出就不挂;
3. **译文去重**:同译文 + SimHash 相近 → 直接别名化,不新增;
4. **预算淘汰**:超过 `maxEntries`(默认 15 万)或 `maxBytes`(默认 32MB)时,按
   `用量^0.8 × 0.5^(天数/30) × 长度收益` 打分,**批量淘汰最低分 5%**(不是逐条淘汰,避免抖动);
5. **占位符校验**:译文里的数字个数和原文不一致时,该条**不做模板/近似匹配**(只保留精确匹配),
   防止"造成 20% 伤害"被错填成别的数字。

日志是 append-only 的(`add`/`alias`/`upd`/`del`),命中次数只在内存里累计、压缩时落盘,
所以文件增长跟着"内容"走而不是跟着"访问量"走;超过一定比例自动压缩。

## 多语言 / 增量包 / 覆盖优先级

**多语言**:菜单里的"目标语言"可选 简体中文 / 繁體中文 / 日本語 / 한국어 / English,存进
`$.PersistentStorage`。本地库按语言分表(namespace `lg`),同一句英文可以同时有中文和日文译文,
互不覆盖;**打包在 VPK 里的离线库只有简体中文**,其它语言靠本地库 + 实时通道。

**增量包(给别人用)**:

```powershell
node tools\tm_export.js                       # 导出自 bridge 产生的新译文 -> dist/tm_pack_<日期>.json
node tools\tm_export.js --since 2026-10-01 --lg zh-Hans
```

导出内容只包含**从公开数据(deadlock-api 出装 / 游戏内实际显示的文本)翻译来的条目**,
流水线来源(pipeline)默认不导出。把别人的包丢进 `tools/packs/`,再跑 `node tools\build_tm.js`,
这些译文就会被合并进随包发布的 `bba_tm.js` —— 贡献者不需要自己起 bridge。

**覆盖优先级(你的选择:本地优先)**:

1. 本地库中**与离线库不同**的条目 → 桥连上时一次性拉取(`/api/v1/tm/overrides`),
   直接覆盖 VPK 里的译文(纠正机翻不准的地方);
2. 离线库(简体中文);
3. 整句兜底 / 术语兜底;
4. 实时翻译,并且**自动存库**(不需要点按钮)。

自动存库现在默认开启:凡是游戏里出现、本地库又没有的文本,桥翻译完就写进表格
(`source: auto`),下次直接命中。按钮只用于"立刻把整页补齐",不是存库的前提。

## 出装更新了怎么办

译文库是**打包时的快照**,游戏内不联网。所以数据侧一定会随时间落后,当前的处理方式是三层:

| 手段 | 效果 | 代价 |
|---|---|---|
| **整句兜底**(已内置) | 新出装里凡是"以前出现过"的句子,直接命中译文,其余保持英文;整段覆盖率 ≥55% 才采用,避免中英混杂 | 游戏内零成本(查表) |
| **术语兜底**(已内置) | ≤160 字符的短句仍做英雄/装备/段位名替换 | 零成本 |
| **实时通道 + 本地库**(本仓库 v1.5) | 新文本立刻翻译,并沉淀进本地库,下次直接命中 | 需要 bridge,一次点击 |
| **重新生成译文库 + 重打 VPK** | 让**别人**也拿到这些译文(发布用) | 一条命令,几分钟(见下) |

```powershell
# 1) 抓最新数据(含最近 45 天更新的、以及你自己的出装)
node tools\fetch_builds.js --weekly 100 --alltime 60 --recent 40 --lang English --author "<你的SteamID64>"
# 2) 重新翻译并生成 bba_tm.js(断点续翻,只翻新增文本)
node tools\build_tm.js
# 3) 重打 VPK(约十几秒,不需要重启电脑)
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "<CSDK>"
# 或一步到位:
powershell -ExecutionPolicy Bypass -File scripts\refresh_tm.ps1 -Author "<你的SteamID64>" -Build -Csdk12Root "<CSDK>"
```

打完后把新的 `dist/pak13_dir.vpk` 覆盖到 `game\citadel\addons\`,**重启游戏**即可。
因为译文库是累积的(`build_tm.js` 会合并旧的 `bba_tm.js`),重跑不会丢已翻译的内容。

> 想更省事:把 `dist/pak13_dir.vpk` 作为 Release 附件发布,自己更新时别人只需下载覆盖;
> 仓库里的 CI(见 `.github/workflows/tests.yml`)会在流水线变更时校验生成物一致性。

## 某个位置没被翻译时怎么定位

布局覆盖是"一个文件一个文件"的,游戏更新或某个面板来自**独立布局文件**时,那个位置就扫不到。
两步定位:

```powershell
# 1) 在反编译目录里找:某个面板到底属于哪个布局文件(按本地化 token 或界面文字搜)
node tools\find_layouts.js "<S2V导出目录>" --token Citadel_HeroBuilds_BuildDescription
node tools\find_layouts.js "<S2V导出目录>" --text "Overview"

# 2) 一条命令给这些布局注入扫描脚本(支持逗号分隔多个;支持通配符 *build**)
powershell -ExecutionPolicy Bypass -File tools\get_layouts.ps1 -S2VDir "<S2V导出目录>" -Names "citadel_ui_build_details_overview" -NoTm
```

然后重打 VPK。游戏内用 `-condebug` 看 `console.log`:
- 启动时每个生效的布局都会打印 `[BBT] vX loaded (...) in layout: <面板名>`;
- 工具条绑定成功会打印 `[BBT] toolbar wired: N control(s)`(没有这行 = 该布局里没有工具条,或绑定失败);
- `BBT_STATS` 可看 `translated / dialogVar / rebinds / live` 等计数,`BBT_DEBUG = true` 看每次写入。

## 已知问题与待办

完整的问题列表 / 待解决项 / 计划中的新功能见 [TODO.md](TODO.md)。

## 排查

1. 确认 `addons` 里只有一份 `pak13_dir.vpk`,并且**完全重启**过游戏(不是退回主菜单)。
2. 别的 mod 如果也覆盖了这五个布局,文件名编号**更小**的 pak 会抢先(addons 里
   所有 `pak##_dir.vpk` 小编号优先,见"安装");用 VPKEdit 看一眼各 pak
   的文件树,冲突时把本 mod 改成更小的编号(改 `scripts/build.ps1` 的 `-PakName` 参数)。
3. 需要看日志时,给 Deadlock 加启动项 `-condebug`,打开一次商城/出装浏览器后,
   在 `game/citadel/console.log` 里搜 `[BBT]`,正常应看到
   `[BBT] v1.1.0 loaded (tm=..., glossary=1) in layout: <面板类型>`:
   这条日志会告诉你是**哪个布局**真正带上了扫描器(右侧详情应为 `CitadelBuildDetails`,
   装备提示应为 `CitadelTooltipModDetails`)。同一行之后的 `[BBT] MISS ...` 就是待补译文本。
4. 布局覆盖失效最常见的原因是游戏更新后布局结构变了:重跑一遍
   `Source 2 Viewer` 反编译 + 对比,再按 README 的构建步骤重新打包。
   反编译出的新布局(例如右侧详情布局 `citadel_ui_build_details.xml`)用
   `node tools\inject_scripts.js <反编译文件>` 一条命令生成覆盖,自动落到
   `mod/panorama/layout/`,再重跑 build.ps1。

## 目录结构

```
mod/panorama/layout/          覆盖的原版布局(4 个)
mod/panorama/scripts/
  bba_translate.js            游戏内扫描 + 查表 + 替换
  bba_glossary.js             官方术语表(生成)
  bba_tm.js                   翻译记忆(生成,累积合并)
tools/
  build_code.js               出装码 解析/编码(无损往返,支持裸 protobuf)
  build_glossary.js           从游戏本地化文件生成术语表
  fetch_builds.js             抓取热门出装
  build_tm.js                 生成翻译记忆(合并旧条目)
  providers/bing.js           免 Key Bing 翻译
scripts/build.ps1             编译 + 打包 + 部署
tests/translate_simtest.js    游戏内脚本离线模拟测试
tests/tools_simtest.js        工具链离线测试(出装码/术语保护/旧库合并)
```

## 致谢

- [Source 2 Viewer / ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat):`*.vxml_c` 反编译
- [VPKEdit](https://github.com/craftablescience/VPKEdit):VPK 打包
- [deadlock-api](https://deadlock-api.com):公开出装数据
- BabelTower:Panorama mod 工程与踩坑经验

