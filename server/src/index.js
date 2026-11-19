import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { config } from './config/index.js'
import { migrate } from './lib/db.js'
import { handleImageProxy } from './lib/image-proxy.js'
import { errorHandler, notFound } from './middleware/error.js'

import authRoutes from './routes/auth.js'
import accountRoutes from './routes/account.js'
import projectRoutes from './routes/projects.js'
import generationRoutes from './routes/generation.js'
import templateRoutes from './routes/templates.js'
import uploadRoutes from './routes/upload.js'
import adminRoutes from './routes/admin.js'
import assetRoutes from './routes/assets.js'
import inspireRoutes from './routes/inspire.js'
import systemRoutes from './routes/system.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 初始化数据库
migrate()
fs.mkdirSync(config.uploadDir, { recursive: true })
fs.mkdirSync(config.exportDir, { recursive: true })

const app = express()

app.use(cors({ origin: config.clientOrigin, credentials: true }))
app.use(express.json({ limit: '10mb' }))

// 静态文件：上传与导出
app.use('/uploads', express.static(config.uploadDir))
app.use('/exports', express.static(config.exportDir))
app.use('/templates', express.static(path.resolve(__dirname, '../public/templates')))
app.use('/generated', express.static(path.resolve(__dirname, '../public/generated')))
app.use('/design-backdrops', express.static(path.resolve(__dirname, '../public/design-backdrops')))
app.use('/vector-backdrops', express.static(path.resolve(__dirname, '../public/vector-backdrops')))
app.use('/ai-images', express.static(path.resolve(__dirname, '../public/ai-images')))

app.get('/api/health', (req, res) => res.json({ ok: true, env: config.env }))

// 图片代理：外部素材站有 Referer 防盗链，浏览器直连会被 403。
// 统一由服务端带源站 Referer 取图 + 磁盘缓存，前端一律加载 /api/img?u=...
app.get('/api/img', handleImageProxy)

app.use('/api/auth', authRoutes)
app.use('/api/account', accountRoutes)
app.use('/api/projects', projectRoutes)
app.use('/api/generate', generationRoutes)
app.use('/api/templates', templateRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/assets', assetRoutes)
app.use('/api/inspire', inspireRoutes)
app.use('/api/system', systemRoutes)

// 生产/云端部署：托管前端构建产物，实现「单端口」运行。
// 产物放在 server/public/app（而非 client/dist）：云端发布工具会忽略 dist/build 目录，
// 放在普通静态资源目录下才能随源码上传，避免重新发布后线上仍是旧前端。
// 本地开发时该目录尚未构建，这段自动跳过，仍走 Vite 开发服务器。
const clientDist = path.resolve(__dirname, '../public/app')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  // SPA 回退：非 API、非静态资源的路径统一返回 index.html
  app.get(/^\/(?!api\/|uploads\/|exports\/|templates\/|generated\/|design-backdrops\/|vector-backdrops\/|ai-images\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

app.use(notFound)
app.use(errorHandler)

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[server] AI 海报工作台已启动：http://localhost:${config.port}`)
  console.log(`[server] 环境：${config.env}`)
  if (fs.existsSync(clientDist)) console.log('[server] 已托管前端静态资源（单端口模式）')
})

export default app
