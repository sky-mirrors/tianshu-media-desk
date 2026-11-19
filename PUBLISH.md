# 发布信息

| 项 | 值 |
|---|---|
| 插件 id | `media-desk` |
| 包名 | `tianshu-media-desk` |
| 版本 | 0.1.0 |
| 发布者 ID | `b226234e-c3c8-4223-9e58-7e9fadbb5bea` |
| 许可证 | MIT |
| 目标 TPI | 2.0（`engines.tianshu >=4.1.0`） |

## 借鉴了什么

本仓库是 [`woniuniuniu/dsh-media-desk`](https://github.com/woniuniuniu/dsh-media-desk) v2.7.2 的**移植**，不是从零实现。上游同样以 MIT 发布（`Copyright (c) 2026 woniuniuniu（蜗牛的科技笔记）`），全文随本仓库 `LICENSE` 一同分发。

原样复用（MIT，保留上游版权）：

- `src/ops.js` —— 状态与操作集、白名单字段校验。本移植新增 `save_plan` / `save_production` / `attach_asset` 三个回写 handler（内容由模型产出，需要落库通道），归一化规则照搬上游 `produce.js` 的 `normalizePlan`。
- `src/style.js` —— 风格卡转写作要求。
- `lib/schema.js` —— 参数表 → JSON Schema（来自同作者的 `tianshu-video-storyboard`，同一份 TPI 约定）。
- 产品概念与交互：灵感墙、策划案 → 正文 → 封面/配图/分镜的流水线、风格卡、排期、复盘。

重写（本仓库）：

- `index.js`、`lib/brief.js`、`lib/context.js`、`lib/llm.js`、`lib/render.js`、`lib/state.js`、`lib/export-worker.mjs`、`src/export.js`、`views/**`、`scripts/**`、`test/**`。

未移植：

- `monid.js`（第三方账号抓取，需要付费服务）、`images.js` / `image-tool.js`（插件内生图，天枢里交给生图工具）、`seed.js` 的示例数据、`learn.js` 的规则自动提炼（改由模型写）。

## 打发行包

```bash
cd media-desk
npm pack                     # 产出 tianshu-media-desk-0.1.0.tgz
```

包内容由 `package.json` 的 `files` 决定：`index.js`、`tpi.js`、`lib/`、`src/`、`views/`、`scripts/`、`tianshu.plugin.json`、`README.md`、`LICENSE`。测试与本地运行产物不进包。

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
