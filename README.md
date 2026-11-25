# media-desk · 自媒体工作台

> `tianshu-media-desk` · 0.1.1 · MIT · 发布者 ID `b226234e-c3c8-4223-9e58-7e9fadbb5bea`
> 天枢 TPI 2.0 插件，移植自 [`woniuniuniu/dsh-media-desk`](https://github.com/woniuniuniu/dsh-media-desk)（MIT）。
> 复用了哪些文件、改了哪些、发行文案怎么写，见 PUBLISH.md。

一句话记灵感，然后做出脚本、标题、封面、配图和分镜。

插件只做三件事：**台账**（灵感、成稿、风格卡、排期、复盘）、**规范**（创作简报）、**落盘**（导出 Markdown 与图片）。文章和画面由天枢里的模型与生图工具产出，插件不内置第二套模型调用，也不需要用户另配密钥。

## 和上游最大的差别：谁来写

上游（dsh-media-desk 2.7.2）把整条生产线放在插件进程里：它通过 dsh 的 `ctx.get('llm').prepareCall()` 调宿主已注册的文字模型，也在插件内直接画封面配图（生图要么填图片 API Key，要么复用已注册的生图工具，配在插件自己的设置里）。本仓库把「写」交给天枢里的对话 agent：插件出规范（`media_brief`）、模型在对话里写、`media_save` 回写；只有 `media_write` 这一步经 `sidePathLLM` 间接调一次宿主模型。生图不再内置，交给天枢的生图工具。

| 事 | 谁做 | 工具 |
|---|---|---|
| 台账：灵感、成稿、风格卡、排期、复盘 | 插件 | `media_idea` `media_list` `media_item` `media_save` |
| 一键成稿：策划案 + 正文 | 插件调 `sidePathLLM`，用的是天枢的模型 | `media_write` |
| 规范：体裁写法、策划案字段、风格要求 | 插件出简报，模型照着写 | `media_brief` |
| 落盘：Markdown + 图片 | 插件 | `media_export` |

封面与配图的画面提示词由策划案给出，交给生图工具出图后用 `media_save kind:"image"` 写回槽位。

## 现在的状态

分三层看，别混在一起：

| 层 | 状态 | 依据 |
|---|---|---|
| 清单与实现 | 合法、可加载 | `node scripts/check-manifest.mjs` 退出码 0：判定为 v2 `true`、形状解析 `ok`、permissions 通过、7 个工具名都合法 |
| 本机安装位 | 已装，且与仓库一致 | `~/.rivet/plugins/media-desk/` 的 `tianshu.plugin.json` 与仓库版本逐字节相同（`diff -q` 无差异） |
| 宿主是否加载它 | **当前没有** | 本会话工具列表里没有任何 `media_*`；宿主插件中心（功能插件 / 社区插件 / 技能 / 连接器）里也没有本地插件条目 |

历史上成功过一次：`~/.rivet/plugin-data/media-desk/state.json`（697 字节）里存着两条 2026-11-19 的笔记，标题都是「Edge 真机验证：从输入框记下的一条」——说明那天插件在宿主里被加载过，面板渲染出来了、输入框写进去了。

现在为什么没加载，没有查清。可查的日志（`D:\Tianshu\TianshuData\.rivet\` 下的 `desktop-*.log` 与 `logs\sidecar-*.log`）最新一条是 2026-11-23，没有 2026-11-24 当日记录，也没有 media-desk 的加载或报错行。所以「11-19 之后为什么不再加载」仍是未验证项，不作猜测。

不依赖宿主就能用的一层见下节。

## 不装进天枢也能跑

仓库自带一套本地宿主，用的是**真的** `tianshu.plugin.json` 和 `index.js`，按 2.0 宿主形状注入 `storage` / `workspace` / `shell` / `ui` / `promptContext`，所以工具行为与宿主内一致：

```bash
node scripts/serve.mjs              # 界面 → http://127.0.0.1:8788/
node scripts/local-run.mjs demo     # 命令行跑完整链路：记灵感 → 简报 → 策划案 → 正文 → 导出
node scripts/local-run.mjs tools    # 列出七个工具
```

界面里能记灵感、按状态筛、改状态、排期、删除，也能点「让模型成稿」。想让成稿真的写，给一个 OpenAI 兼容端点：

```bash
MEDIA_DESK_LLM_BASE_URL=https://api.example.com/v1 \
MEDIA_DESK_LLM_KEY=sk-... \
MEDIA_DESK_LLM_MODEL=deepseek-v4-pro \
node scripts/serve.mjs
```

不设这三个变量时 `media_write` 会明确报错并指回 `media_brief` + 手写那条路——它不假装自己有模型。

本地宿主与宿主的差异只在传输：界面走 `POST /rpc`（`scripts/serve.mjs`），宿主里走 iframe 的 `postMessage`；`views/` 是同一份文件。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `MEDIA_DESK_DATA` | 数据目录 | `~/.rivet/plugin-data/media-desk`（`scripts/host.mjs:15`） |
| `MEDIA_DESK_PORT` | 界面端口 | `8788` |
| `MEDIA_DESK_LLM_BASE_URL` / `_KEY` / `_MODEL` | 本地宿主的一键成稿端点 | 不设则只用简报 + 手写 |

## 七个工具

| 工具 | 用途 |
|---|---|
| `media_idea` | 记一句话灵感、链接或图片；返回 id |
| `media_list` | 按状态/平台/关键词列表，每条一行（id · 状态 · 标题 · 平台 · 排期） |
| `media_item` | 看详情（大纲、成稿、画面槽位），或改字段、改状态、排期、删除 |
| `media_brief` | 创作简报：体裁规范、策划案 JSON 字段、风格卡与写作规则、已有成稿 |
| `media_save` | 回写：策划案 `plan`、正文 `article`/`script`、草稿 `draft`、画面 `image`、风格卡 `style`、数据 `metric`、规则 `rule` |
| `media_write` | 一键成稿：先出策划案再出正文，直接落库 |
| `media_export` | 导出 Markdown（正文、图注、分镜表）+ `assets/` 图片 |

`id` 允许写唯一前缀——从列表里复制半截也能命中。工具超时：导出 60 秒，其余 20 秒。

## 面板与每轮上下文块

**面板**：`contributes.ui` 声明 `views/desk.html`（标题「自媒体工作台」）与 label 为「工作台」的面板，另有命令 `refresh` 与状态项 `job`。面板内容是一个输入框（「一句话灵感，回车记下」）、状态筛选条、卡片列表，以及详情里的状态选择、排期、保存、让模型成稿、删除。

**上下文块**：`lifecycle: ["turnStart"]` 钩子把台账压成 `<media-desk>` 块写进每轮对话，模型不用被问就知道有什么在等它。块里只放模型不看就会问的东西：

- 待写（`idea`/`outline`）几条、各自的标题与 id
- 写了一半（`draft`）几条
- 待发布（`ready`）几条，带排期时间或「未排期」
- 已过排期的几条
- 当前风格卡、已发布几条

空台账不推块。`promptContext.setBlock` 只在 turnStart 窗口能过宿主的 phase 门，工具调用期间推无效——所以别指望 `media_save` 之后立刻有新块。

## 数据在哪、会发给谁

`~/.rivet/plugin-data/media-desk/` 下：

- `state.json` — 明文 JSON，不加密。字段：`items`（灵感与成稿）、`styles`（风格卡）、`skills`（写作规则）、`metrics`（复盘数据）、`people`、`angles`、`accounts`、`chat`、`activeStyleId`、`draftFormat`。首次读取自动建空台账。
- `files/` — 预留给素材的目录，插件自己不往里写。
- `llm.json` — 只有本地运行版（`scripts/serve.mjs`）在面板里填过模型配置时才出现，明文保存 `baseUrl` / `key` / `model`。

边界：

- **会发给模型吗**：台账不主动外发。每轮对话推的上下文块只有标题、id、状态、排期与风格卡名，不含正文。正文只在你调用 `media_write`（或点「让模型成稿」）时，作为提示词的一部分交给宿主已配置的模型。插件自身没有网络能力——`capabilities` 不含网络项，`permissions` 只有 `workspace` 与 `shell`。
- **写工作区吗**：只在你主动 `media_export`（或点面板「导出 Markdown」）时，按你给的目录写 Markdown 与 `assets/` 图片。导出会读取你指定的图片文件，但只放行 http(s)、插件自己的 media 引用，以及落在工作区或插件数据目录内的本地路径。
- **怎么删**：删 `~/.rivet/plugin-data/media-desk/` 整个目录即全量清除；单条用 `media_item` 的 `delete` 动作。卸载插件不会自动删数据。

## 代码结构

```
tianshu.plugin.json   清单：$tpi 2.0 / capabilities / permissions / contributes（tools、ui、lifecycle）
index.js              入口：七个工具、turnStart 钩子、面板消息（state / ops / write）
tpi.js                SDK 握手：宿主把 SDK 装到 globalThis，宿主外 import 直接抛错
lib/state.js          持久化（dataDir + 跨进程 mtime 重读）
lib/brief.js          创作简报（phase: plan / article / style）
lib/context.js        <media-desk> 上下文块
lib/llm.js            sidePathLLM 调用与 JSON 抽取
lib/render.js         列表 / 详情 / 回执的文本渲染
lib/schema.js         参数表 → JSON Schema
lib/export-worker.mjs 沙箱里由宿主进程执行的写盘 worker
src/ops.js            状态与操作集，唯一写入口 applyOps（白名单字段校验）
src/export.js         纯函数导出（Markdown + 图片拷贝）
src/style.js          风格卡转写作要求
src/i18n.js           语言适配：上游的中英双语收成单一中文（保留 tr / currentLang / byLang / platformName 四个符号）
views/                desk.html / desk.css / desk.js（原生 HTML/JS，进发行包）
scripts/              host.mjs / serve.mjs / local-run.mjs / check-manifest.mjs / check-real-load.mjs / pack-release.mjs / make-release.py / make-zip.py / push-via-api.py
test/                 plugin.test.js + unit.test.js
dist/                 发行包产物（22 个文件）
```

几条设计上的硬约束：

- **单一写入口**：工具和面板都只能经 `src/ops.js` 的 `applyOps` 改状态，字段白名单在那一层校验一次，下面直接信任。
- **沙箱导出**：2.0 插件跑在隔离沙箱里写不了工作区，`media_export` 用 `host.shell.run` 起 `lib/export-worker.mjs` 在宿主进程写盘；宿主没给 `shell`（本地宿主 / 测试直调）时插件自己写，行为一致。
- **边界校验在宿主**：`media_export` 声明 `pathParams: { dir: 'write' }`，越界路径由宿主 `wrapTpiTool` 的 `validatePathSafe` 拒绝；插件内部只按 `cwd` 解析相对路径。
- **跨进程共用一份 state.json**：界面服务与命令行是两个进程，靠 `mtime` 判断「别人写过没有」，不做三方合并。

## 开发与自检

```bash
node --test                        # 38 个测试（plugin.test.js 22 + unit.test.js 16）
node scripts/check-manifest.mjs    # 清单语义：版本判定 / permissions 严格校验 / 工具名长度
node scripts/check-real-load.mjs   # 宿主读不读得懂：用宿主自己的 readTpiManifest 读安装位
```

`check-manifest` 有一处已知盲区：`capabilities` 枚举值它不查（用坏清单做过对照实验，照样 `ok:true`），只在真实加载时暴露。

`check-real-load` 读的是 `~/.rivet/plugins/` 下每个目录，输出 `ok=` / `$tpi=` / `id=` / `caps=`。当前 media-desk 一行是 `ok=true | $tpi=2.0`——清单能被宿主读懂，只是没被加载。

打包发行包（ZIP，含 `xiaosi.release.json` 与 `xiaosi.contents.json`）：

```bash
node scripts/pack-release.mjs
python scripts/make-release.py <完整 40 位 commit>
cd D:/Februus/.tmp-devkit && node cli.mjs validate <zip> --lane official_reviewed
```

现成的产物有两个：`tianshu-media-desk-0.1.1.zip`（运行包，TPI 2.0，53176 字节）与 `tianshu-media-desk-0.1.1-tpi1.0.zip`（入库包，TPI 1.0，101831 字节），都挂在 GitHub Release `v0.1.1`。校验结果与 sha256 记在 PUBLISH.md。

## 装进天枢与发行通道

清单是 **TPI 2.0**：`capabilities: [tools, storage, workspace, shell, ui, promptContext, sidePathLLM]`、`permissions: {workspace: {read, write}, shell: {run}}`、`engines.tianshu >=4.1.0`、`lifecycle: ["turnStart"]`。没声明 `embeddings`（不做语义检索）、`account`（不要账号）、`transcripts`（不读会话原文）。

**发行通道的限制**：插件库现在的准入 schema（devkit `validate --lane official_reviewed` / `paid_unreviewed`）只收 `$tpi: "1.0"`，2.0 清单会被拒（实测首条报 `Invalid input: expected "1.0"`，见 PUBLISH.md）。所以这份 2.0 包只用于本机安装；要发插件库得把清单退回 1.0 形状，而 1.0 没有 `contributes.ui` 与 `permissions.workspace`——面板和沙箱导出会一起丢掉，两者不可兼得。

按此前记录，正式版宿主只加载经过认证的插件，未认证目录不构成入场（启动日志里标 `[tpi] legacy-unverified`）。这一条本轮没有独立复验；能确认的只有 `check-real-load` 的 `ok=true` 与「当前未加载」两个事实。

## 移植面

原样复用（MIT，上游版权见 `LICENSE`）：`src/ops.js`（状态与操作集，另加 `save_plan` / `save_production` / `attach_asset` 三个回写 handler）、`src/style.js`、`lib/schema.js`（来自同作者的 `tianshu-video-storyboard`），以及灵感墙 → 策划案 → 正文 → 封面/配图/分镜的产品概念。

重写：`index.js`、`lib/**`、`src/export.js`、`views/**`、`scripts/**`、`test/**`。逐文件说明与「未移植什么」（`monid.js`、`images.js`、`image-tool.js`、`seed.js`、`learn.js`）写在 PUBLISH.md。

## 许可

上游 MIT（`LICENSE`，Copyright (c) 2026 woniuniuniu / 蜗牛的科技笔记），全文随本仓库分发；本移植同样 MIT。
