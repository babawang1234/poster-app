# 项目长期约定（幻象工坊 · AI 海报设计工作台）

## 技术栈与端口（不可变）
- 前端 React18+Vite+Tailwind :5173 / 后端 Express+better-sqlite3+@napi-rs/canvas :4000
- 数据库 SQLite（server/data/app.db，seed 重建）；品牌占位名「幻象工坊」

## 核心机制
- 文字独立图层渲染 renderer.js；版式 layouts.js；模板 template-cases.js+render-templates.js
- 模板检索 GET /api/templates/discover（花瓣式，seed 换一换）
- 模型层全走后端；额度账本预扣/退款幂等

## 演示账号
- demo@example.com/demo123456 ；admin@example.com/admin123456

## 用户偏好
- 深色科技感 + 紫蓝渐变；重视真实可用 vs 演示明确标注；不虚构数据/评价
- 参照花瓣网检索交互（关键词直出大量可编辑模板 + 换一换）
- 产品面向大众（非自用），免费API需配合缓存复用扛并发

## 素材/AI生图架构（2026-10 确定）
- AI生图三层：gen-cache落盘缓存 → 智谱CogView-3-Flash(免费,中文,真多图) → Pollinations兜底(像素变体)
- 素材图：Pixabay(免费可商用,中文) + Pexels/Unsplash + 本地图库池(239张)
- 设计底图：searchDesignAssets(Pixabay abstract/pattern) 优先，generateDesignBackdrops程序化兜底
- Key 全空时自动降级；Key 填在 server/.env（ZHIPU_API_KEY / PIXABAY_API_KEY）
- 注册教程见 server/API_KEYS.md
- 重要教训：花瓣/站酷无开放API且不可商用，不要硬扒；免费额度扛不住公共并发，必须缓存复用

## 启动避坑（2026-11 遇到，务必按此启动）
- WorkBuddy 宿主注入 `NODE_OPTIONS=--require=<旧版shim路径>`，新版目录已改为
  `resources/app.asar.unpacked/cli/vendor/sandbox-center-runtime-kit/shim`，
  旧路径 `cli/vendor/shim/node-language-shim.cjs` 不存在 → node 报 EPERM/ENOENT。
  **启动前必须 `NODE_OPTIONS= node src/index.js`（bash）或 `$env:NODE_OPTIONS=""`（PowerShell）**
- 根目录 `npm run dev`（concurrently）在 Git Bash 下报 `spawn cmd.exe ENOENT`，不要用；
  改为分别启动：`cd server && node src/index.js`、`cd client && node ../node_modules/vite/bin/vite.js --host`
- 系统 `http_proxy/https_proxy` 指向 127.0.0.1:2266 常失效，会让 curl 连本地服务也失败；
  本地请求改用 node fetch 或 `env -u http_proxy -u https_proxy`；`git push/pull` 也要清代理
- 一键启动脚本：`bash scripts/start-dev.sh` 或 `powershell scripts/start-dev.ps1`（已封装以上修复）
