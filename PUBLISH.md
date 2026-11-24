# 发布信息

| 项 | 值 |
|---|---|
| 插件 id | `media-desk` |
| 包名 | `tianshu-media-desk` |
| 版本 | 0.1.1 |
| 发布者 ID | `b226234e-c3c8-4223-9e58-7e9fadbb5bea` |
| 许可证 | MIT |
| 目标 TPI | 1.0（`$tpi: "1.0"`，`engines.tianshu >=4.0.2 <5.0.0`） |

## 借鉴了什么

本仓库是 [`woniuniuniu/dsh-media-desk`](https://github.com/woniuniuniu/dsh-media-desk) v2.7.2 的**移植**，不是从零实现。上游同样以 MIT 发布（`Copyright (c) 2026 woniuniuniu（蜗牛的科技笔记）`），全文随本仓库 `LICENSE` 一同分发。

原样复用（MIT，保留上游版权）：

- `src/ops.js` —— 状态与操作集、白名单字段校验。本移植新增 `save_plan` / `save_production` / `attach_asset` 三个回写 handler（内容由模型产出，需要落库通道），归一化规则照搬上游 `produce.js` 的 `normalizePlan`。
- `src/style.js` —— 风格卡转写作要求。
- `lib/schema.js` —— 参数表 → JSON Schema（来自同作者的 `tianshu-video-storyboard`，同一份 TPI 约定）。
- 产品概念与交互：灵感墙、策划案 → 正文 → 封面/配图/分镜的流水线、风格卡、排期、复盘。

重写（本仓库）：

- `index.js`、`lib/brief.js`、`lib/context.js`、`lib/llm.js`、`lib/render.js`、`lib/state.js`、`lib/export-worker.mjs`、`src/export.js`、`views/**`、`scripts/**`、`test/**`。

发行包只纳入入口 import 闭包 + 四份根文件（共 18 个文件）；`views/`、`scripts/`、`test/`、`lib/export-worker.mjs` 留在仓库，不进包。

未移植：

- `monid.js`（第三方账号抓取，需要付费服务）、`images.js` / `image-tool.js`（插件内生图，天枢里交给生图工具）、`seed.js` 的示例数据、`learn.js` 的规则自动提炼（改由模型写）。

## 打发行包

插件库收的是 **ZIP**，用官方 devkit 校验通过才算数。本机路径：`D:\Februus\.tmp-devkit`（`tianshu-developer-kit`）。

```bash
# 1) 生成 dist/：入口 import 闭包 + 根清单与文档 + 精简 package.json
node scripts/pack-release.mjs

# 2) 补根元数据并打 ZIP：xiaosi.release.json + xiaosi.contents.json（逐文件 sha256）
python scripts/make-release.py <完整 40 位 commit>

# 3) 官方校验（等价于入库那套规则）
cd D:/Februus/.tmp-devkit
node cli.mjs validate <zip> --lane official_reviewed
```

当前状态（以最近一次 `validate` 输出为准）：

```
valid: true
artifact_sha256 : 15ed4e65b6ce0c7b57dab7e7e635b6113e71fcd518013b5e67ceb6165a470231
manifest_sha256 : f0abfe1cff16e127690b022ebb322567943822eefc93b1d45d69e7d73b274ae2
artifact_bytes  : 41357
compatibility   : tpi 1.0 / core >=4.0.2 <5.0.0 / win32-x64
source_commit   : 791fbe785fe66ade22eb9648fc1f888ad9419d15
```

四条来自校验器的硬约束（踩过的）：

1. **`$tpi` 只接受 `"1.0"`**。插件库当前的准入 schema 是 TPI 1.0，`2.0` 会被 `expected "1.0"` 拒掉；因此 `capabilities` 也只能取 `tools|storage|account|embeddings|sidePathLLM|promptContext|transcripts|log`，`contributes.ui` 与 `permissions.workspace` 都不存在。
2. **ZIP 根必须有 `xiaosi.contents.json`**——逐文件 sha256 清单，`{"files":{...},"schema":"xiaosi.contents/1"}`，不含它自己。缺了会报 `required ZIP root metadata is missing`。
3. **`dist/package.json` 不能带 `scripts` / `dependencies`**，否则 `validateFile` 直接拒。
4. **ZIP 条目必须 `/` 分隔**。Windows 的 .NET `CreateFromDirectory` 会写成 `\`。

0.1.1 起不再做双宿主分支，只按 1.0 宿主实现：导出直接用 `fs` 写（1.0 插件有完整 Node 权限），不再走 `shell.run` 沙箱 worker；面板只在本地宿主（`scripts/serve.mjs`）里挂。状态注入改由 `lifecycle: ["turnStart"]` 钩子触发——`promptContext.setBlock` 只在 preTurn 窗口能过宿主的 phase 门，工具调用期间推无效。`media_export` 的 `dir` 用工具上声明的 `pathParams: { dir: 'write' }` 交给宿主 `wrapTpiTool` 做越界校验。

## 提交文案（插件库）

### 数据用途

本插件只在**本机**保存你自己写的内容：灵感、成稿、草稿、风格卡、写作规则、排期与复盘数据。

- **存在哪**：`<数据根>/plugin-data/media-desk/state.json`（Windows 上是 `%LOCALAPPDATA%\.rivet\plugin-data\media-desk\`），一个明文 JSON 文件，不加密。图片等素材在同目录 `files/`。
- **谁能读**：只有本插件。宿主按插件隔离数据目录，其他插件拿不到。
- **会上传吗**：不会。插件没有遥测、没有账号体系、没有远程日志、不检查更新。
- **写工作区**：只有你主动点导出（`media_export`）时，才按你给的目录写 Markdown 与 `assets/` 图片。
- **和模型的关系**：只有你主动点「让模型成稿」时，该条目的标题、正文与风格卡才会作为提示词的一部分交给模型；模型由天枢宿主提供，插件不直接联网、不自建通道、不保存模型返回以外的数据。

### 外部服务与费用

- **插件本体**：免费，MIT，无内购、无订阅、无试用期、无按次计费、无账号绑定。
- **必需的外部服务**：没有。不配模型也能记灵感、看板、排期、手动回写正文、导出 Markdown。
- **可选的外部服务**：一键成稿走天枢宿主的 `sidePathLLM`（你已配置的模型）。**费用由你向模型服务商支付，本插件不代收、不加价、不抽成**；不点这个按钮就不产生调用。
- **本地运行版**（`scripts/serve.mjs`，不经宿主）：只有你自己设置 `MEDIA_DESK_LLM_BASE_URL` / `MEDIA_DESK_LLM_KEY` / `MEDIA_DESK_LLM_MODEL` 三个环境变量后才会访问你指定的那个端点；不设就完全不联网。它起的是绑定 `127.0.0.1` 的本地页面服务。
- **第三方依赖**：零。`package.json` 没有 `dependencies` 也没有 `devDependencies`，插件主体（`index.js` / `lib/` / `src/`）里没有任何 `fetch` 或 HTTP 调用。
- **不接触的端点**：无更新检查、无遥测上报、无许可校验服务器、无第三方统计。

### 版本变更说明（v0.1.1）

- 入口收敛到 TPI 1.0 单宿主：`media_export` 删掉 `host.shell` 沙箱 worker 分支，直接用 `fs` 写工作区。
- 状态上下文改由 `turnStart` 生命周期钩子推送（此前在激活时推一次，会被宿主的 phase 门拦掉）。
- `media_export` 增加 `pathParams: { dir: 'write' }`，越界路径由宿主在边界拒绝。
- 发行包收敛到运行所需：18 个文件，不含 `views/**`、`scripts/**`、`lib/export-worker.mjs`。

### 版本变更说明（v0.1.0）

首个公开版本。

- 移植自 [`woniuniuniu/dsh-media-desk`](https://github.com/woniuniuniu/dsh-media-desk) v2.7.2（MIT），上游 HTTP + React 工作台改为 TPI 2.0 的工具 + iframe 面板。
- 七个工具：`media_idea` / `media_list` / `media_item` / `media_brief` / `media_save` / `media_write` / `media_export`。
- 新增（上游没有）：工作台状态经 `promptContext` 写进每轮对话；一键成稿改走宿主的 `sidePathLLM`，不需要另配模型密钥；自带本地宿主（`scripts/serve.mjs` 出界面、`scripts/local-run.mjs` 出命令行），不装进天枢也能用。
- 未移植：第三方账号抓取、插件内生图、示例数据、规则自动提炼。
- 已知限制：正式版天枢只加载经过认证的插件，未认证的目录不构成入场；未配置模型时「让模型成稿」会明确报错并指回手写路线，不会静默失败。

## 装到天枢

正式版天枢只加载经过认证的插件；未认证插件放进去也不会被加载（启动日志里是 `[tpi] legacy-unverified`）。可用的两种方式：

1. **插件库安装**（需要认证流程）——发布到 XiaoSi 插件库后从天枢内安装。
2. **本地直接跑**——不装宿主也能用：
   ```bash
   npm i                 # 无运行时依赖，可跳过
   node scripts/serve.mjs      # 界面 → http://127.0.0.1:8788/
   node scripts/local-run.mjs demo
   ```

## 发 npm（可选）

当前 `package.json` 里 `private: true`，防止误发布。要发到 npm 时去掉该字段并 `npm publish`；天枢插件库若按 npm 源安装则需要这一步。
