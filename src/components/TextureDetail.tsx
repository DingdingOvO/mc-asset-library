import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CloseIcon, DownloadIcon } from './icons'
import { resolveBlocks } from '@/lib/blocks'
import { namespacePath, textureSrc, type Texture } from '@/lib/mc'

interface TextureDetailProps {
  texture: Texture
  version: string
  onClose: () => void
  /** 额外信息行 */
  extraRows?: { key: string; value: string }[]
}

/**
 * 贴图详情。
 *
 * @why 主视图永远是这张贴图本身。
 *      之前会自动反查方块并直接渲染成立体方块——从「界面」点进来却看到一个
 *      完全不相干的方块模型，等于把主体换掉了。关联方块现在只作为可跳转的线索，
 *      放在右侧信息栏里，不接管主视图。
 */
export function TextureDetail({ texture, version, onClose, extraRows }: TextureDetailProps) {
  const [blocks, setBlocks] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)

  const src = textureSrc(version, texture.p)
  const id = namespacePath('textures', texture.p, 'png')

  useEffect(() => {
    let alive = true
    setBlocks(null)
    void resolveBlocks(version, texture.p).then((list) => {
      if (alive) setBlocks(list)
    })
    return () => {
      alive = false
    }
  }, [version, texture.p])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal--texture"
        role="dialog"
        aria-modal="true"
        aria-label={texture.n}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="modal__close" onClick={onClose} aria-label="关闭">
          <CloseIcon />
        </button>

        <div className="modal__view">
          <img
            className="modal__flat"
            src={src}
            alt={texture.n}
            onError={(event) => {
              event.currentTarget.style.visibility = 'hidden'
            }}
          />
          <span className="modal__hint">
            {texture.w && texture.h ? `${texture.w} × ${texture.h} 原始尺寸` : '原始贴图'}
          </span>
        </div>

        <div className="modal__side">
          <div className="modal__head">
            <div className="detail__name">{texture.n}</div>
            {texture.e && <div className="detail__en">{texture.e}</div>}
          </div>

          <div className="modal__body">
            {extraRows?.map((row) => (
              <div className="kv" key={row.key}>
                <span className="kv__key">{row.key}</span>
                <span className="kv__val">{row.value}</span>
              </div>
            ))}

            <div className="kv">
              <span className="kv__key">文件</span>
              <span className="kv__val">textures/{texture.p}.png</span>
            </div>

            <div className="kv">
              <span className="kv__key">资源包引用</span>
              <span className="kv__val">{id}</span>
            </div>

            {blocks && blocks.length > 0 && (
              <div className="kv">
                <span className="kv__key">
                  使用此贴图的方块 · {blocks.length}
                  {blocks.length > 8 ? '（显示前 8 个）' : ''}
                </span>
                <div className="ref-list">
                  {blocks.slice(0, 8).map((block) => (
                    <Link key={block} to={`/blocks?q=${encodeURIComponent(block)}`} className="ref-chip">
                      {block}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div className="detail__actions">
              <a className="btn btn--primary" href={src} download={`${texture.p.split('/').join('_')}.png`}>
                <DownloadIcon />
                下载 PNG
              </a>
              <button type="button" className="btn" onClick={() => void copy(id)}>
                {copied ? '已复制' : '复制 ID'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
