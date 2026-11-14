/** Shared low-level helpers for the QQ plugin. */
import path from 'node:path'

export const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

export function randomHex(bytes = 4) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('')
}

export function jsonText(value) {
  try { return JSON.stringify(value) } catch { return '"[unserializable]"' }
}

export function jsonLength(value) {
  return jsonText(value).length
}

export function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string' || text.length === 0) return fallback
  try { return JSON.parse(text) } catch { return fallback }
}

/** Detach a JSON value. Tool outputs cross a lossless-JSON boundary. */
export function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function truncateText(text, maxChars, suffix = '…') {
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  return value.slice(0, Math.max(0, maxChars - suffix.length)) + suffix
}

/** Header-safe display name. Structural brackets become full-width; controls are spaces. */
export function headerName(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/gu, '\\n')
    .replace(CONTROL_RE, ' ')
    .replace(/\(/gu, '（').replace(/\)/gu, '）')
    .replace(/\[/gu, '［').replace(/\]/gu, '］')
    .trim()
}

/** JSON-safe display name; brackets are harmless inside JSON but controls are not. */
export function cleanName(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function displayName(person, fallbackId) {
  return cleanName(person?.card || person?.nickname || '') || String(fallbackId ?? '')
}

export function numericId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
  if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) return value.trim()
  return ''
}

export function parseTarget(value) {
  if (typeof value !== 'string') return null
  const match = /^(group|private):([1-9]\d{0,19})$/u.exec(value.trim())
  return match ? { kind: match[1], id: match[2], key: `${match[1]}:${match[2]}` } : null
}

export function parseReceiptRef(value) {
  if (typeof value !== 'string') return null
  const match = /^([0-9a-f]{8})(?:#([1-9]\d*))?$/u.exec(value.trim())
  return match ? { receipt: match[1], pos: match[2] ? Number(match[2]) : undefined } : null
}

export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//iu.test(value)
}

export function isFileUrl(value) {
  return typeof value === 'string' && /^file:\/\//iu.test(value)
}

/** Convert a OneBot/local file spelling to a Windows/UNC path when possible. */
export function fileUrlToPath(value) {
  if (typeof value !== 'string') return undefined
  if (!isFileUrl(value)) return value
  try { return decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:)/u, '$1') } catch { return undefined }
}

export function toFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/gu, '/')
  return `file:///${resolved.replace(/^\/+/u, '')}`
}

export function formatClock(ms, withDate = false) {
  const d = new Date(Number(ms))
  if (!Number.isFinite(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (!withDate) return `${hh}:${mm}`
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${mo}-${da} ${hh}:${mm}`
}

export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`
}

export function mimeForName(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase()
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.amr': 'audio/amr', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.silk': 'audio/silk',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.7z': 'application/x-7z-compressed',
    '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown',
  })[ext] || 'application/octet-stream'
}

export function extForMime(mime, fallback = '.bin') {
  return ({
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'audio/amr': '.amr', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'audio/mp4': '.m4a', 'audio/silk': '.silk', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
    'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json', 'text/plain': '.txt',
  })[String(mime ?? '').split(';')[0].trim().toLowerCase()] || fallback
}

export function safeFilename(name, fallback = 'file') {
  const base = path.basename(String(name ?? '').replace(/\\/gu, '/'))
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_').replace(/[. ]+$/gu, '').trim()
  return (cleaned || fallback).slice(0, 160)
}

export function sameJson(a, b) {
  return jsonText(a) === jsonText(b)
}
