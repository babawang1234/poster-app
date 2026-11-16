import crypto from 'node:crypto'
import { db } from './db.js'

/**
 * LLM 响应缓存
 *
 * 目的：同样的输入不再重复调用模型，直接复用上次结果，节省 token 与费用。
 * 只缓存「输入确定 → 输出确定」的场景（如图片风格分析）。
 * 生成类请求（需要用户点「换一换」得到不同结果）默认不缓存，
 * 由调用方显式传入 cache: false 关闭。
 */

// 不同场景的缓存有效期（毫秒）
const TTL_BY_SCOPE = {
  analyze: 30 * 24 * 60 * 60 * 1000, // 图片风格分析：30 天（同一张图结果稳定）
  text: 7 * 24 * 60 * 60 * 1000,     // 文本类：7 天
}

export function makeKey({ model = '', scope = 'text', system = '', prompt = '', imageHash = '' }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ model, scope, system, prompt, imageHash }))
    .digest('hex')
}

export function hashImage(buffer) {
  if (!buffer) return ''
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)
}

export function getCached(key, scope = 'text') {
  if (!key) return null
  const row = db
    .prepare('SELECT content, created_at FROM llm_cache WHERE key = ?')
    .get(key)
  if (!row) return null

  const ttl = TTL_BY_SCOPE[scope] ?? TTL_BY_SCOPE.text
  const age = Date.now() - new Date(row.created_at + 'Z').getTime()
  if (Number.isFinite(age) && age > ttl) {
    db.prepare('DELETE FROM llm_cache WHERE key = ?').run(key)
    return null
  }

  db.prepare(
    "UPDATE llm_cache SET hits = hits + 1, last_hit_at = datetime('now') WHERE key = ?"
  ).run(key)

  return row.content
}

export function setCached({ key, model = '', scope = 'text', content = '' }) {
  if (!key || !content) return
  db.prepare(
    `INSERT INTO llm_cache (key, model, scope, content)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET content = excluded.content, model = excluded.model`
  ).run(key, model, scope, content)
}

/** 缓存命中统计，用于观察节省效果 */
export function cacheStats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM llm_cache').get().c
  const hits = db.prepare('SELECT COALESCE(SUM(hits), 0) AS h FROM llm_cache').get().h
  return { entries: total, hits }
}

/** 清理过期条目，可在启动或定时任务中调用 */
export function pruneCache() {
  let removed = 0
  for (const [scope, ttl] of Object.entries(TTL_BY_SCOPE)) {
    const days = Math.floor(ttl / 86400000)
    const res = db
      .prepare(
        "DELETE FROM llm_cache WHERE scope = ? AND created_at < datetime('now', ?)"
      )
      .run(scope, `-${days} days`)
    removed += res.changes
  }
  return removed
}
