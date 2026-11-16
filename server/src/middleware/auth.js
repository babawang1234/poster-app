import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { HttpError } from '../lib/http.js'
import { getUserById } from '../services/auth.js'

/**
 * 取出客户端 token。
 *
 * 为什么优先用自定义头 X-Auth-Token：
 * 云端分享网关（*.app.workbuddy.host）会向应用注入它自己的 `Authorization: Bearer <网关会话>`,
 * 把前端真正发来的业务 token 覆盖掉，导致 jwt.verify 报 invalid signature，
 * 表现为「登录看似成功，但一调接口就提示登录已过期」。
 * 自定义头不会被网关改写，所以主通道走 X-Auth-Token，Authorization 仅作本地/兼容回退。
 */
function pickToken(req) {
  const custom = req.headers['x-auth-token'] || req.headers['x-poster-token']
  const raw = Array.isArray(custom) ? custom[0] : custom
  if (raw) return String(raw).replace(/^Bearer\s+/i, '').trim()

  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export function authRequired(req, res, next) {
  const token = pickToken(req)
  if (!token) return next(new HttpError(401, '未登录'))
  let payload
  try {
    payload = jwt.verify(token, config.jwt.secret)
  } catch {
    return next(new HttpError(401, '登录已过期，请重新登录'))
  }
  try {
    req.user = getUserById(payload.sub)
    if (!req.user) return next(new HttpError(401, '用户不存在'))
    next()
  } catch (err) {
    next(err)
  }
}

export function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return next(new HttpError(403, '需要管理员权限'))
  }
  next()
}
