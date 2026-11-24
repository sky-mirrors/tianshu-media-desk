# media-desk

> `tianshu-media-desk` · 0.1.1 · MIT · 发布者 ID `b226234e-c3c8-4223-9e58-7e9fadbb5bea`
> 天枢 TPI 插件。移植自 [`woniuniuniu/dsh-media-desk`](https://github.com/woniuniuniu/dsh-media-desk)（MIT）——复用了什么、改了什么见 PUBLISH.md。

一句话记灵感，然后做出脚本、标题、封面、配图和黑白线稿分镜。

## 和上游最大的差别：谁来写

上游把「一键成稿」做在插件里——插件自己调文字模型写文章、调生图接口画封面，用户得在设置里填模型和密钥。

天枢给插件提供了 `sidePathLLM`：旁路调用**宿主已配置的模型**。所以那句话不用丢，也不用逼用户另配 key。

| 事 | 谁做 | 工具 |
|---|---|---|
| 台账：灵感、成稿、风格卡、排期、复盘 | 插件 | `media_idea` `media_list` `media_item` `media_save` |
| 一键成稿：策划案 + 正文 | 插件调 `sidePathLLM`，用的是天枢的模型 | `media_write` |
| 规范：体裁写法、策划案字段、风格要求 | 插件出简报，模型照着写 | `media_brief` |
| 落盘：Markdown + 图片 | 插件 | `media_export` |

封面与配图的画面提示词由策划案给出，交给生图工具出图后用 `media_save kind:"image"` 写回槽位。

## 现在就能用

正式版天枢只加载认证过的插件（启动日志里未认证的会被标 `[tpi] legacy-unverified`），光把目录放进 `plugins/` 不构成入场。所以这个仓库自带一套本地宿主，装不装进天枢都能跑：

```bash
node scripts/serve.mjs              # 界面 → http://127.0.0.1:8788/
node scripts/local-run.mjs demo     # 命令行跑完整链路：记灵感 → 简报 → 策划案 → 正文 → 导出
node scripts/local-run.mjs tools    # 列出七个工具
```

界面里能记灵感、筛状态、改状态、排期、删除，也能点「让模型成稿」。想让成稿真的写，给一个 OpenAI 兼容端点：

```bash
MEDIA_DESK_LLM_BASE_URL=https://api.example.com/v1 \
MEDIA_DESK_LLM_KEY=sk-... \
MEDIA_DESK_LLM_MODEL=deepseek-v4-pro \
node scripts/serve.mjs
```

不设这三个变量时 `media_write` 会明确报错并指回 `media_brief` + 手写那条路——它不假装自己有模型。

它用的是**真的** `tianshu.plugin.json` 和 `index.js`，按宿主形状注入 `storage` / `workspace` / `shell` / `ui` / `promptContext`（这是 2.0 形状的本地宿主，面板靠它才挂得上），所以工具行为与宿主内一致。数据落在 `~/.rivet/plugin-data/media-desk/state.json`（同真机 `pluginDataDir(id)` 的规则，`MEDIA_DESK_DATA` 可覆盖），工程目录因此永远干净。

## 七个工具

| 工具 | 用途 |
|---|---|
| `media_idea` | 记一句话灵感、链接或图片；返回 id |
| `media_list` | 按状态/平台/关键词列表，每条一行 |
| `media_item` | 看详情（大纲、成稿、画面槽位），或改字段、改状态、排期、删除 |
| `media_brief` | 创作简报：体裁规范、策划案 JSON 字段、风格卡与写作规则、已有成稿 |
| `media_save` | 回写：策划案 `plan`、正文 `article`/`script`、草稿 `draft`、画面 `image`、风格卡 `style`、数据 `metric`、规则 `rule` |
| `media_write` | 一键成稿：先出策划案再出正文，直接落库 |
| `media_export` | 导出 Markdown（正文、图注、分镜表）+ `assets/` 图片 |

## 天枢特色（上游没有的）

1. **工作台状态自动进上下文**——用 `promptContext` 把「待写 N 条、待发布（含排期）、当前风格卡」压成一个 `<media-desk>` 块写进每轮对话。模型不用被问就知道有什么在等它；空台账不推块。
2. **零配置成稿**——`sidePathLLM` 用的是天枢里已经配好的模型，不引入第二套密钥与设置界面。
3. **能力按需声明**——清单只声明真正用到的四项：`tools` / `storage` / `promptContext` / `sidePathLLM`。没声明 `embeddings`（不做语义检索）、`account`（不要账号）、`transcripts`（不读会话原文）。
4. **单清单装进 1.0 宿主**——清单按插件库准入的 1.0 形状写：`capabilities` 只取 `tools` / `storage` / `promptContext` / `sidePathLLM` 四项，`permissions` 只有 `fs` / `net` / `shell` 三个开关，没有 `contributes.ui`。

## 装进天枢

提交插件库用的是 **TPI 1.0** 清单（准入 schema 只收 `"1.0"` 的能力与 `permissions` 形状）：`capabilities: [tools, storage, promptContext, sidePathLLM]`、`permissions: {fs, net, shell}`。

发行包只装 1.0 宿主跑得起来的东西：

| 事 | 这一版怎么做 |
|---|---|
| 面板（`contributes.ui`） | 1.0 没有 ui 扩展点，发行包里没有 `views/`；面板只在本地宿主里跑 |
| 导出 | 插件有完整 Node 权限，`src/export.js` 直接用 `fs` 写；沙箱 `shell.run` + `lib/export-worker.mjs` 那条分支已删 |
| `promptContext` | 经 `lifecycle: ["turnStart"]` 钩子推上下文块——`setBlock` 只在 turnStart 窗口里通过宿主的 phase 门 |
| `sidePathLLM` | 1.0 能力枚举里有，一键成稿照常可用 |

工具参数里的路径靠 `pathParams: { dir: 'write' }` 交给宿主 `wrapTpiTool` 做越界校验，插件内部不再重复守一遍。

```
~/.rivet/plugins/media-desk/
  ├── tianshu.plugin.json   清单（$tpi 1.0 / capabilities / permissions）
  ├── index.js              入口：注册工具、turnStart 钩子
  ├── tpi.js                SDK 握手（只在宿主内可用）
  ├── lib/                  参数表编译、存储、简报、上下文块、渲染
  ├── src/                  移植自上游的纯函数数据层 + 导出
  └── views/                面板（HTML + CSS + 原生 JS，仅本地宿主加载，不进发行包）
```

数据落在 `~/.rivet/plugin-data/media-desk/state.json`：`items`（灵感与成稿）、`styles`、`skills`（写作规则）、`metrics`、`people`、`angles`、`accounts`、`activeStyleId`、`draftFormat`。首次读取自动建空台账。

- **会不会发往模型**：台账不主动外发；每轮对话会推一份摘要上下文块（待写/排期/风格卡，只有标题与 id，不含正文）。正文只在成稿时按你调用的工具（`media_write`）发给宿主已配置的模型。插件自身不联网（`permissions.net: false`）。
- **保留多久**：无自动清理、无过期；`state.json` 一直在，直到你删。
- **怎么删**：直接删 `~/.rivet/plugin-data/media-desk/` 整个目录即全量清除；单条用 `media_item` 的 `delete` 动作。卸载插件不会自动删数据。

## 开发与自检

```bash
node --test                        # 38 个测试
node scripts/check-manifest.mjs    # 清单语义：版本判定 / permissions 严格校验 / 工具名长度
node scripts/check-real-load.mjs   # 宿主读不读得懂：走的是宿主自己的 readTpiManifest
```

`check-manifest` 有一处已知盲区：`capabilities` 枚举值它不查（用坏清单做过对照实验，照样 `ok:true`），只在真实加载时暴露。

打包发行包（ZIP，含 `xiaosi.release.json` 与 `xiaosi.contents.json`）：

```bash
node scripts/pack-release.mjs
python scripts/make-release.py <完整 40 位 commit>
cd D:/Februus/.tmp-devkit && node cli.mjs validate <zip> --lane official_reviewed
```

## 移植面与改动

原样复用（MIT，上游版权见 `LICENSE`）：

- `src/ops.js` — 状态与操作集，唯一写入口、白名单字段校验。**新增**三个回写 handler：`save_plan`、`save_production`、`attach_asset`（天枢里内容由模型产出，需要一条落库通道；归一化规则照上游 `produce.js` 的 `normalizePlan`）。
- `src/style.js` — 风格卡转写作要求。
- `lib/schema.js` — 参数表 → JSON Schema（来自同作者的 `tianshu-video-storyboard`，同一份 TPI 约定）。

重写：

- `index.js` — 1.0 入口、七个工具、turnStart 钩子与面板消息处理。
- `lib/state.js` — 上游 `store.js` 的去 DSH 依赖版：`dataDir` 换掉 `$DSH_HOME`，去掉三方合并撤销；补了跨进程 `mtime` 重读（界面与命令行是两个进程共用一份 `state.json`）。
- `lib/brief.js` — 上游 `ai.js` 里 `planPrompts` / `articlePrompts` 的规范，从「发给模型的系统提示词」改成「给模型的简报回执」；`phase:'article'` 是正文专用版。
- `lib/llm.js` — `extractJson` 移植自上游；`sidePathLLM.complete` 的返回结构宿主侧没取到明文，所以 `textOf` 接受几种常见形状，都不是就报错。
- `lib/context.js` — 新增，`<media-desk>` 上下文块的渲染。
- `src/export.js` — 上游把保存逻辑写死在对话框尾部，这里拆成可测试的纯函数。`lib/export-worker.mjs` 是 2.0 沙箱分支的遗物，留在仓库但不被引用、不进发行包。
- `views/` — 上游是 React + `@deepseek-ai/dsh-client-runtime`，iframe 里跑不了，改用原生 HTML/JS 按 TPI 的 view 协议重写。

没有移植：`monid.js`（第三方账号抓取，需付费服务）、`images.js` / `image-tool.js`（插件内生图，天枢里交给生图工具）、`seed.js` 的示例数据（空台账起步）、`learn.js` 的规则自动提炼（改由模型用 `media_save kind:"rule"` 写）。

## 许可

上游 MIT（`LICENSE`，Copyright (c) 2026 woniuniuniu / 蜗牛的科技笔记），全文随本仓库分发；本移植同样 MIT。
