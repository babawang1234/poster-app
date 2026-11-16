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

## 云端登录 401 的真正根因（2026-11-16 已定位并修复，勿再误判）
- **根因：WorkBuddy 分享网关会向应用注入它自己的 `Authorization: Bearer <网关会话>`，
  覆盖前端发来的业务 token** → `jwt.verify` 报 `invalid signature` → 所有登录态接口 401。
  之前记的「不是密钥问题」结论方向对，但误以为是 DB 异常兜底；实际是 header 被劫持。
- **判别方法**：请求完全不带 header 时，服务端仍能读到 `Authorization`（长度 386，我们自己的 token 是 219）
  → 一定是网关注入。加临时 `/api/__diag` 端点打印 `authHeaderLen` / 验签结果即可确诊。
- **修复**：认证主通道改自定义头 `X-Auth-Token`（网关照抄不改写），头名在
  `server/src/middleware/auth.js pickToken()` 与 `client/src/lib/api.js` 两处，改一处必改另一处。
  `Authorization` 仅留作本地开发兼容回退。
- **附带修复**：`JWT_EXPIRES_IN='604800'` 字符串被 jsonwebtoken 按 ms() 解析 → token 只活 **10 分钟**
  （本想 7 天）。config 里已改为 parseInt 成数字秒。凡 `expiresIn` 一律传数字。
- 教训：`authRequired` 的 try/catch 只该包 `jwt.verify`，DB 异常必须冒泡成 500，
  否则 DB 故障会被伪装成「登录已过期」，浪费大量排查时间（已改）。

## 素材/生图链路（2026-11-16 大修，排查同类问题先看这里）
- **图片防盗链是「图不显示」的头号原因**：堆糖(dtstatic)/站酷等对 Referer 校验，
  浏览器从本站加载返回 403，页面表现为一片空白，容易被误判成「后端没返回数据」。
  判别：`curl 图URL` 返回 200 但 `<img>` 是破图 → 带 `Referer: 本站域名` 再试，403 即坐实。
  解法：`server/src/lib/image-proxy.js`（服务端带源站 Referer 取图 + 磁盘缓存 + 域名白名单 + 内网拦截），
  数据层用 `proxyUrl()` 统一改写，`renderer.js` 识别 `/api/img?u=` 并复用缓存（否则导出时图层会丢）。
- **智谱余额不足会伪装成「生成失败」**：`cogview-3-plus` 是付费档，无余额返回 HTTP 429 + code 1113，
  旧代码把它当 1302 限流静默跳过 → 一路降级到 pollinations（45s 限速）→ 最终只剩设计底图。
  **默认必须用 `cogview-3-flash`（免费，实测可用，约 7.5s/张）**；1113 要明确报错。
- 生图必须「落盘缓存 + 同 prompt 并发合并」，否则用户等不及连点就撞限速，观感就是「生成不了」。
- 一键成片底图重复的根因是 `searchLocalPool(q,{limit:1})` 永远取第一张；
  改用模块级轮转游标 `poolCursor`，连续多次必出不同图。AI 兜底要带随机 `seed`（pollinations 同 prompt 出同一张）。
- **中文切词 bug**：`tokenizeQuery` 遇到词典外的字会把后面整段当「未知词」吞掉，
  「新品咖啡上市」切不出「咖啡」→ 命中 0 张。已改为逐字前进。
- 抓取功能对主流设计站**注定失败且不应绕过**：站酷/Dribbble 的 robots.txt 明确禁止，Unsplash 直接 403。
  要补素材只能靠正版 API（Pixabay 免费 Key）或 AI 生图，不要试图对抗反爬。

## 部署打包规则（实测结论）
- 部署**会排除 `.env`**，因此云端拿不到 Key。解法：`server/secrets.json` + `config` 的 `pick()`
  （优先级：真实环境变量 > secrets.json > 默认值）。
- 部署**会包含未跟踪但存在于磁盘的文件**（secrets.json 上传后云端 `zhipu:true` 已验证），
  但 `.gitignore` 里的 `.env` 仍被排除。所以密钥走 secrets.json 是可行的。
- **仓库是 PUBLIC**（babawang1234/poster-app），密钥绝不能 git add。
  `secrets.json` 已写入 `.git/info/exclude`（仅本地生效，换电脑要重新加）。
- 运维自检：`GET /api/system/net`（需 admin）返回各 provider 配置布尔值 + 主要外部服务连通性，线上排障先用它。

## 素材生成融合改造（2026-11-16）——取消独立「AI 生图」
- 背景：AI 生图（智谱/万相）无法保证多张背景风格一致，用户放弃把它作为独立功能。
- 新形态：Studio 第 0 步只有一个「素材生成」入口，输入一句描述，一次给齐三类候选，不再有 Tab：
  - **矢量背景**（新）：`server/src/lib/vector-backdrop.js`，纯 SVG，8 种风格
    （mesh/blobs/concentric/waves/memphis/grid/stripe/aurora），配色复用 design-backdrop 的
    `pickTheme()`，同关键词+变体 → 确定性出图，成组统一。落盘到 `server/public/vector-backdrops/*.svg`。
  - **图库实拍**：`/assets/search?skipAi=1&skipVector=1`
  - **AI 生成**：`/inspire/ai-background`，独立异步，慢也不阻塞前两类
- 接口：新增 `GET /api/assets/vector?q=&orientation=&count=`（**8ms 返回**，前端第一个上屏）；
  `/assets/search` 新增 `skipAi` / `skipVector` / `withDesign` 参数，默认不再生成旧「设计底图」（canvas 栅格化太浪费）。
- 前端：`AssetThumb` 组件统一三类卡片外观；三个独立 loading（vectorLoading / generatingAssets / aiLoading）。
- 坑：① `layouts.js` 原本按 `stockAsset.photographer` 就给海报加 "Photo: …" 底栏，
  矢量背景/AI 图必须排除，改为按 provider 白名单判断，否则版面被污染；
  ② vite dev 需代理 `/vector-backdrops/` 到后端，否则本地预览 404；
  ③ @napi-rs/canvas 可直接 `loadImage(SVG buffer)`，矢量背景能正常渲染进导出图（已验证）。
