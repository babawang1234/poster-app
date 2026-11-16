import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

/**
 * 部署平台会排除 .env 文件，导致云端所有 API Key 为空（表现为 AI 生图不可用、图库全部 key_required）。
 * 因此额外读取 server/secrets.json 作为密钥来源：该文件不进 Git（已写入 .git/info/exclude），
 * 但会随部署目录一起上传。优先级：真实环境变量 > secrets.json > 默认值。
 */
let secrets = {}
try {
  secrets = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../secrets.json'), 'utf8'))
} catch {
  secrets = {}
}

/** 取配置值：空字符串视为未配置，继续往下一级找 */
function pick(key, fallback = '') {
  const fromEnv = process.env[key]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const fromSecrets = secrets[key]
  if (fromSecrets !== undefined && fromSecrets !== '') return fromSecrets
  return fallback
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  jwt: {
    secret: pick('JWT_SECRET', 'dev-secret-change-me'),
    // 注意：jsonwebtoken 对字符串会按 ms() 解析，'604800' 会被当成 604800 毫秒（约 10 分钟）。
    // 这里统一转成数字，单位明确为「秒」，默认 7 天。
    expiresIn: (() => {
      const n = parseInt(process.env.JWT_EXPIRES_IN || '', 10)
      return Number.isFinite(n) && n > 0 ? n : 604800
    })(),
  },
  dbPath: path.resolve(__dirname, '../../', process.env.DB_PATH || './data/app.db'),
  uploadDir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || './uploads'),
  exportDir: path.resolve(__dirname, '../../', process.env.EXPORT_DIR || './exports'),
  admin: {
    email: pick('ADMIN_EMAIL', 'admin@example.com'),
    password: pick('ADMIN_PASSWORD', 'admin123456'),
  },
  providers: {
    unsplash: { accessKey: pick('UNSPLASH_ACCESS_KEY') },
    pexels: { apiKey: pick('PEXELS_API_KEY') },
    deepseek: {
      apiKey: pick('DEEPSEEK_API_KEY'),
      baseUrl: pick('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    },
    openai: {
      apiKey: pick('OPENAI_API_KEY'),
      baseUrl: pick('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    },
    dashscope: {
      apiKey: pick('DASHSCOPE_API_KEY'),
      baseUrl: pick('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/api/v1'),
    },
    zhipu: {
      // 智谱 AI（免费文生图 CogView-3-Flash，中文友好）
      apiKey: pick('ZHIPU_API_KEY'),
      baseUrl: pick('ZHIPU_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4'),
    },
    pixabay: {
      // Pixabay 免费可商用图库（含中文素材），解决「都是外国图」问题
      apiKey: pick('PIXABAY_API_KEY'),
    },
    pollinations: {
      // 免 Key 免费生图服务，作为无万相 Key 时的真实 AI 生图兜底
      enabled: process.env.POLLINATIONS_ENABLED !== 'false',
      baseUrl: process.env.POLLINATIONS_BASE_URL || 'https://image.pollinations.ai',
    },
  },
  defaults: {
    textModel: process.env.DEFAULT_TEXT_MODEL || 'deepseek-chat',
    visionModel: process.env.DEFAULT_VISION_MODEL || 'deepseek-vl',
    imageModel: process.env.DEFAULT_IMAGE_MODEL || 'mock-image-gen',
  },
}
