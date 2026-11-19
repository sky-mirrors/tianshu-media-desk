# media-desk（天枢插件：提交版 TPI 1.0，兼容 2.0 能力）

> 包名 `tianshu-media-desk` · 版本 0.1.0 · MIT · 发布者 ID `b226234e-c3c8-4223-9e58-7e9fadbb5bea`
> 移植自 [`woniuniuniu/dsh-media-desk`](https://github.com/woniuniuniu/dsh-media-desk)（MIT）。发布了什么、借鉴了什么见 PUBLISH.md。

一句话记灵感，然后做出脚本、标题、封面、配图和黑白线稿分镜。天枢版是
[`woniuniuniu/dsh-media-desk`](https://github.com/woniuniuniu/dsh-media-desk)（MIT）的移植。

## 和上游最大的差别：谁来写

上游把「一键成稿」做在插件内部——插件自己调文字模型写文章、调生图接口画封面，用户要在设置里填模型与密钥。

天枢给插件提供了 `sidePathLLM`——旁路调用**宿主已配置的模型**。所以上游那句「一键成稿」不用丢，也不用逼用户另配 key：

| 事 | 谁做 | 对应工具 |
|---|---|---|
| 台账：灵感、成稿、风格卡、排期、数据 | 插件 | `media_idea` / `media_list` / `media_item` / `media_save` |
| 一键成稿：策划案 + 正文 | 插件调 `sidePathLLM`（天枢的模型） | `media_write`，面板上「让模型成稿」同一条路 |
| 规范：体裁写法、策划案字段、风格要求 | 插件出简报，模型照着写 | `media_brief`（想在对话里手写时用） |
| 落盘：Markdown + 图片 | 插件 | `media_export` |

封面和配图的画面提示词由策划案给出，交给生图工具出图后用 `media_save kind:"image"` 写回槽位。

## 天枢特色（dsh 版没有的部分）

1. **工作台状态自动进上下文**——用 `promptContext`，把「待写 3 条、待发布 2 条（含排期）、当前风格卡」压成一个 `<media-desk>` 块写进每一轮对话。模型不用被问就知道有什么在等它。空台账不推块。
2. **零配置成稿**——`sidePathLLM` 用的是天枢里已经配好的模型，不引入第二套密钥与设置界面。
3. **面板即入口**——面板里点「让模型成稿」直接调插件进程里的旁路模型。面板本身没有模型，它只是把活交给插件。
4. **能力按需声明**——`capabilities` 只声明真正用到的：`tools` / `storage` / `workspace` / `shell` / `ui` / `promptContext` / `sidePathLLM`。没声明 `embeddings`（暂不需要语义检索）、`secrets`（没有密钥）、`transcripts`（不读会话原文）。

## 工具

| 工具 | 用途 |
|---|---|
| `media_idea` | 记一句话灵感、链接或图片；返回 id |
| `media_list` | 按状态/平台/关键词列表，每条一行 |
| `media_item` | 看详情（大纲、成稿、画面槽位），或改字段、改状态、排期、删除 |
| `media_brief` | 创作简报：体裁规范、策划案 JSON 字段、风格卡与写作规则、已有成稿 |
| `media_save` | 回写策划案（plan）、正文（article/script）、草稿（draft）、画面（image）、风格卡（style）、数据（metric）、规则（rule） |
| `media_write` | 一键成稿：调天枢的模型，先出策划案再出正文，直接落库 |
| `media_export` | 导出 Markdown（正文、图注、分镜表）+ `assets/` 图片 |

面板（`views/desk.html`）是台账视图：筛选、看详情、改状态、排期、删除。面板里不做生成——写作与出图在对话里完成，面板只告诉你该说什么。

## 改清单先自检

```bash
node scripts/check-manifest.mjs
```

它直接 import 天枢运行时的校验器跑：TPI 版本判定、清单形状解析、`permissions` 严格校验（类型错会被拒）、工具名长度。**注意它验不到什么**：`capabilities` 枚举值、`contributes.ui` 是否配了 `"ui"` 能力——这两个 `parseTpiManifest` 不查（用坏清单做过对照实验，照样 `ok:true`），只在真实加载时暴露。

## 现在就能用：本地工作台

正式版天枢只加载认证过的插件（启动时那行 `[tpi] legacy-unverified`），光把目录放进 `plugins/` 不构成入场。所以这个插件自带一套本地宿主，两条入口都共用同一份 `scripts/host.mjs`：

```bash
# 界面（推荐）：浏览器里就是完整工作台
node scripts/serve.mjs                 # → http://127.0.0.1:8788/
node scripts/serve.mjs --port 9000     # 换端口

# 命令行：单次调用
node scripts/local-run.mjs tools
node scripts/local-run.mjs call media_idea '{"text":"一句话灵感"}'
node scripts/local-run.mjs demo        # 记灵感 → 简报 → 策划案 → 正文 → 导出
```

界面里能筛状态、改状态、排期、删除，以及点「让模型成稿」。想让一键成稿真的写，给它一个 OpenAI 兼容端点：

```bash
MEDIA_DESK_LLM_BASE_URL=https://api.example.com/v1 MEDIA_DESK_LLM_KEY=sk-... MEDIA_DESK_LLM_MODEL=deepseek-v4-pro node scripts/serve.mjs
```

不设这三个变量时 `media_write` 会如实报错并指回 `media_brief` + 手写那条路——它不假装自己有模型。

数据落在 `~/.rivet/plugin-data/media-desk/state.json`（与真机宿主 `pluginDataDir(id)` 的规则一致，`MEDIA_DESK_DATA` 可覆盖），所以工程目录永远是干净的，`cp` 到安装位也不会带上运行时数据。

它用**真的** `tianshu.plugin.json` 和 `index.js`，按 host 形状注入最小宿主（`storage` / `workspace` / `shell` / `ui` / `promptContext`），所以工具行为与宿主内一致；数据落在 `.local-data/`（可用 `MEDIA_DESK_DATA` 覆盖），不碰天枢的 `plugin-data`。`sidePathLLM` 不注入——本机没有模型凭据时，`media_write` 会如实报错并指回 `media_brief` + 手写那条路。

## 真机入场自查

插件在**会话启动时**加载，所以放到目录后必须新开一个会话（或重启天枢）才生效。装好后按这个顺序确认：

```bash
# 1. 宿主读得懂清单吗（走的是宿主加载时的同一个函数 readTpiManifest）
node scripts/check-real-load.mjs
#    期望：✔ media-desk | ok=true | $tpi=1.0 | id=media-desk | caps=[...]

# 2. 清单语义（版本判定 / permissions 严格校验 / 工具名长度）
node scripts/check-manifest.mjs
```

3. 新会话里看三处：
   - 工具列表出现 `media_idea` `media_list` `media_item` `media_brief` `media_save` `media_write` `media_export`
   - 面板里出现「工作台」（清单 `contributes.ui.panels`）
   - 有一两条数据后，对话上下文里出现 `<media-desk>…</media-desk>` 块

4. 数据落在 `~/.rivet/plugin-data/media-desk/state.json`（宿主按 `pluginDataDir(id)` 分配；目录由宿主在 `storage.dataDir()` 里自动创建）。**这个目录出现，就等于插件真的被激活过**。

## 安装

提交插件库用的是 TPI 1.0 清单（准入 schema 只收 1.0）。把本目录放进插件目录后重启会话：

```
~/.rivet/plugins/media-desk/
  ├── tianshu.plugin.json   清单（$tpi 2.0 / capabilities / contributes）
  ├── index.js              入口：注册工具与面板
  ├── tpi.js                SDK 握手（只在宿主内可用）
  ├── lib/                  参数表编译、存储、简报、渲染、导出 worker
  ├── src/                  移植自上游的纯函数数据层
  └── views/                面板（HTML + CSS + 原生 JS）
```

声明了七项能力：`tools`、`storage`（数据落 `<插件数据目录>/state.json`）、`workspace`、`shell`（导出走宿主进程跑 `lib/export-worker.mjs`）、`ui`、`promptContext`（工作台状态进对话）、`sidePathLLM`（一键成稿）。

`promptContext` 与 `sidePathLLM` 由宿主按能力下发：没声明就拿不到 `host.promptContext` / `host.sidePathLLM`，插件会自动降级——不推上下文、`media_write` 报错并指回 `media_brief` + 手写这条路。

## 为什么导出要绕 worker

TPI 2.0 插件跑在隔离沙箱里，只写得了插件数据目录，写不了工作区。导出要写 Markdown 又要复制图片到 `assets/`，所以：插件把 job 写到数据目录 → `shell.run` 在宿主进程跑 worker → worker 落盘并写 result → 插件读回来。和 `video-storyboard` 同一套做法。

## 移植面与改动

原样复用（MIT，上游版权声明见 LICENSE）：

- `src/ops.js` — 状态与操作集，唯一写入口，白名单字段校验。**新增**三个回写 handler：`save_plan`、`save_production`、`attach_asset`（天枢里内容由模型产出，需要一条落库通道；归一化规则照上游 `produce.js` 的 `normalizePlan`）。
- `src/style.js` — 风格卡转写作要求。
- `lib/schema.js` — 参数表 → JSON Schema（来自 `video-storyboard`，同一份 TPI 约定）。

重写：

- `index.js` — TPI 2.0 入口、六个工具、面板消息处理。
- `lib/state.js` — 上游 `store.js` 的去 DSH 依赖版：`dataDir` 换掉 `$DSH_HOME`，去掉三方合并撤销（面板不提供撤销，改错了在对话里改回来）。
- `lib/brief.js` — 上游 `ai.js` 里 `planPrompts` / `articlePrompts` 的规范，从「发给模型的系统提示词」改成「给模型的简报回执」；`phase:'article'` 是正文专用版（策划案已锁定，只写正文）。
- `lib/llm.js` — 上游 `extractJson` / `callModel` 的天枢版：`extractJson` 原样移植，`sidePathLLM.complete` 的返回结构宿主侧没取到明文，所以 `textOf` 接受 string / `{text|content|output}` / `{message:{content}}` 几种形状，都不是就报错。
- `lib/context.js` — 新增，`<media-desk>` 上下文块的渲染。
- `src/export.js`、`lib/export-worker.mjs` — 上游把保存逻辑写死在对话框尾部，这里拆成可测试的纯函数 + worker。
- `views/` — 上游是 React + `@deepseek-ai/dsh-client-runtime`，iframe 里跑不了，改用原生 HTML/JS 按 TPI 的 view 协议重写。

没有移植：`monid.js`（第三方账号抓取，要付费服务与抓取）、`images.js` / `image-tool.js`（插件内生图，天枢里由生图工具承担）、`seed.js` 的示例数据（装插件是为了写自己的东西，空台账起步）、`learn.js` 的规则自动提炼（规则改由模型用 `media_save kind:"rule"` 写）。

## 数据

`<插件数据目录>/state.json`：`items`（灵感与成稿）、`styles`、`skills`（写作规则）、`metrics`（数据）、`people`、`angles`、`accounts`、`activeStyleId`、`draftFormat`。首次读取时自动建空台账。

## 许可

上游 MIT（`LICENSE`，Copyright (c) 2026 woniuniuniu / 蜗牛的科技笔记），全文随本目录一同分发；本移植同样 MIT。
