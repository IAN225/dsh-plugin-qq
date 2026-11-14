/** Media reference lifecycle: stable refs, bounded eager download, retry and eviction. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { extForMime, fileUrlToPath, isFileUrl, isHttpUrl, mimeForName, safeFilename } from './util.js'

function asArray(value) { return Array.isArray(value) ? value : (value == null ? [] : [value]) }

export class MediaManager {
  constructor(store, client, options = {}) {
    this.store = store
    this.client = client
    this.options = { autoImageMaxBytes: 64 * 1024 * 1024, autoMediaMaxBytes: 20 * 1024 * 1024, ...options }
    this.queue = []
    this.active = 0
    this.onLog = options.onLog || (() => {})
  }

  enqueue(work) {
    this.queue.push(work)
    this.pump()
  }

  pump() {
    while (this.active < 2 && this.queue.length > 0) {
      const work = this.queue.shift()
      this.active += 1
      Promise.resolve().then(work).catch(error => this.onLog({ level: 'warn', message: `media task failed: ${error.message}` }))
        .finally(() => { this.active -= 1; this.pump() })
    }
  }

  segmentSource(seg) {
    const d = seg?.data ?? {}
    const kind = seg?.type === 'mface' || seg?.type === 'marketface' ? 'sticker' : String(seg?.type || 'file')
    const name = String(d.name || d.file_name || d.filename || d.summary || '').trim()
    const candidates = [d.url, d.file_url, d.download_url, d.path, d.file_path, d.local_path, d.file]
    const remote = candidates.find(value => isHttpUrl(value) || isFileUrl(value) || (typeof value === 'string' && value.startsWith('base64://')))
    return { kind, data: d, name, remote, fileKey: String(d.file_id || d.id || d.file || '') }
  }

  /** Register a media segment and eagerly fetch small content. */
  register(messageRowId, seg, { auto = true } = {}) {
    const source = this.segmentSource(seg)
    let remoteUrl = source.remote || ''
    if (!remoteUrl && isHttpUrl(source.data?.url)) remoteUrl = source.data.url
    const mime = source.data?.mime || source.data?.mime_type || mimeForName(source.name || source.data?.file || remoteUrl)
    const initialSize = Number(source.data?.file_size || source.data?.size || 0)
    const media = this.store.insertMedia({
      messageRowId, kind: source.kind, source: source.data, remoteUrl,
      name: source.name || undefined, mime, size: Number.isFinite(initialSize) ? initialSize : 0, status: 'pending',
    })
    const limit = ['image', 'sticker'].includes(source.kind) ? this.options.autoImageMaxBytes : this.options.autoMediaMaxBytes
    if (auto && (!initialSize || initialSize <= limit)) this.enqueue(() => this.ensure(media.ref))
    return media
  }

  async resolveRemote(media) {
    if (media.remote_url && (isHttpUrl(media.remote_url) || isFileUrl(media.remote_url) || media.remote_url.startsWith('base64://'))) return media.remote_url
    const source = media.source || {}
    try {
      let info = null
      if (media.kind === 'image' || media.kind === 'sticker') {
        const key = source.file || source.file_id || source.id || source.emoji_id || source.resId || source.md5 || ''
        try { info = await this.client.action('get_image', { file: key }) } catch {}
        if (!info && media.kind === 'sticker' && (source.emoji_id || source.resId || source.md5)) {
          try {
            const list = await this.client.action('fetch_custom_face_detail', { count: 48 })
            const wanted = [source.emoji_id, source.resId, source.md5].filter(Boolean).map(String)
            info = asArray(list).find(item => wanted.includes(String(item.emoji_id)) || wanted.includes(String(item.resId)) || wanted.includes(String(item.md5))) || null
          } catch {}
        }
      } else if (media.kind === 'record') {
        info = await this.client.action('get_record', { file: source.file || source.file_id || source.id || '' })
      } else if (source.file_id || source.id) {
        if (media.kind === 'file' && source.group_id && this.client.action) {
          try {
            info = await this.client.action('get_group_file_url', {
              group_id: Number(source.group_id), file_id: source.file_id || source.id, busid: Number(source.busid || 102),
            })
          } catch {}
        }
        if (!info) info = await this.client.action('get_file', { file_id: source.file_id || source.id })
      }
      const candidate = [info?.url, info?.file_url, info?.download_url, info?.file].find(value => isHttpUrl(value) || isFileUrl(value) || (typeof value === 'string' && value.startsWith('base64://')))
      if (candidate) {
        if (Number(info?.file_size || 0) > 0) this.store.updateMedia(media.ref, { size: Number(info.file_size), mime: info.mime_type || media.mime || mimeForName(info.file) })
        return candidate
      }
      if (typeof info?.base64 === 'string' && info.base64) return `base64://${info.base64}`
    } catch (error) {
      this.store.updateMedia(media.ref, { status: 'failed', error: error.message })
    }
    return null
  }

  async ensure(ref) {
    let media = this.store.getMedia(ref)
    if (!media) return { status: 'missing', ref, error: '媒体引用不存在' }
    if (media.status === 'deleted') return { status: 'deleted', ref, error: '媒体已按容量策略清理' }
    if (media.local_path && fs.existsSync(media.local_path)) return { ...media, status: 'downloaded' }
    const remote = await this.resolveRemote(media)
    if (!remote) {
      const error = media.kind === 'sticker'
        ? '当前实现不支持该表情资源，或远端地址已过期；可在本地建立表情包路径并用本地文件发送'
        : '远端媒体地址不可用或已过期'
      media = this.store.updateMedia(ref, { status: 'missing', error })
      return media
    }
    try {
      const saved = await this.saveSource(remote, media)
      media = this.store.updateMedia(ref, {
        remote_url: remote, local_path: saved.path, size: saved.size, mime: saved.mime || media.mime,
        name: media.name || saved.name, status: 'downloaded', error: null,
      })
      return media
    } catch (error) {
      media = this.store.updateMedia(ref, { status: 'failed', error: error.message })
      return media
    }
  }

  async saveSource(source, media, destinationDir = null) {
    const dir = destinationDir || path.join(this.store.dir, 'media')
    await fsp.mkdir(dir, { recursive: true })
    let bytes
    let mime = media.mime
    let name = media.name || ''
    if (source.startsWith('base64://')) {
      bytes = Buffer.from(source.slice('base64://'.length), 'base64')
    } else if (source.startsWith('data:')) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/su.exec(source)
      if (!match) throw new Error('Invalid data URL')
      mime = match[1] || mime
      bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]))
    } else if (isHttpUrl(source)) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60000)
      timer.unref?.()
      try {
        const response = await fetch(source, { signal: controller.signal, redirect: 'follow' })
        if (!response.ok) throw new Error(`媒体下载失败 HTTP ${response.status}`)
        const length = Number(response.headers.get('content-length') || 0)
        if (length > 256 * 1024 * 1024) throw new Error(`媒体超过下载上限 (${length} bytes)`)
        mime = response.headers.get('content-type')?.split(';')[0] || mime
        const array = new Uint8Array(await response.arrayBuffer())
        if (array.byteLength > 256 * 1024 * 1024) throw new Error('媒体超过下载上限')
        bytes = Buffer.from(array)
        if (!name) {
          try { name = safeFilename(decodeURIComponent(new URL(source).pathname.split('/').pop() || ''), 'media') } catch {}
        }
      } finally { clearTimeout(timer) }
    } else {
      const local = isFileUrl(source) ? fileUrlToPath(source) : source
      if (!local || !fs.existsSync(local)) throw new Error('媒体源文件不存在')
      bytes = await fsp.readFile(local)
      name = name || path.basename(local)
    }
    const ext = path.extname(name) || extForMime(mime, '.bin')
    const base = safeFilename(path.basename(name || 'media', path.extname(name || '')), 'media')
    const outPath = path.join(dir, `${media.ref.replace(/^media:/u, '')}-${base}${path.extname(base) ? '' : ext}`)
    await fsp.writeFile(outPath, bytes)
    return { path: outPath, size: bytes.length, mime: mime || mimeForName(outPath), name: name || path.basename(outPath) }
  }

  async saveRemoteTo(source, desiredName, dir) {
    const fake = { ref: `media:${Math.random().toString(16).slice(2, 10)}`, mime: mimeForName(desiredName), name: desiredName }
    return this.saveSource(source, fake, dir)
  }

  async prune(retentionDays, maxMb) {
    const cutoff = Date.now() - Math.max(0, Number(retentionDays) || 0) * 24 * 3600 * 1000
    let removed = 0
    for (const row of this.store.mediaOlderThan(cutoff)) { this.store.deleteMedia(row.ref); removed += 1 }
    const maxBytes = Math.max(16, Number(maxMb) || 512) * 1024 * 1024
    let total = Number(this.store.counts().mediaBytes)
    if (total > maxBytes) {
      const rows = this.store.recentMedia(100000).filter(row => row.local_path && row.status === 'downloaded').reverse()
      for (const row of rows) {
        if (total <= maxBytes) break
        const size = Number(row.size || 0)
        this.store.deleteMedia(row.ref)
        total -= size
        removed += 1
      }
    }
    return removed
  }
}




