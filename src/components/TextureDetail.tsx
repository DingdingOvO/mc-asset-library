import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DownloadIcon } from './icons'
import { Button, Dialog } from '@/ui'
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
 * @why 主视图永远是这张贴图本身。之前会自动反查方块并直接渲染成立体方块——
 *      从「界面」点进来却看到一个完全不相干的方块模型，等于把主体换掉了。
 *      关联方块现在只作为可跳转的线索，放在右侧信息栏里。
 *
 * @constraint 必须走 Dialog 基座：这一版之前自己写遮罩与 Esc，没有滚动锁、
 *      没有焦点圈定，和 ModelModal 的行为对不上（一个能按 Esc 关、一个不能）。
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
    <Dialog open onClose={onClose} label={texture.n} className="modal--narrow">
      <div className="modal__view">
        <div className="modal__stage modal__stage--checker">
          <img
            className="modal__flat"
            src={src}
            alt={texture.n}
            onError={(event) => {
              event.currentTarget.style.visibility = 'hidden'
            }}
          />
        </div>
        <div className="modal__footer">
          <span className="badge">
            {texture.w && texture.h ? `${texture.w} × ${texture.h}` : '原始贴图'}
          </span>
          <span className="modal__hint">透明区域按棋盘格显示</span>
        </div>
      </div>

      <div className="modal__side">
        <div className="modal__head">
          <div className="modal__title">{texture.n}</div>
          {texture.e && <div className="modal__subtitle">{texture.e}</div>}
        </div>

        <div className="modal__body">
          <div className="kv-list">
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
          </div>

          {blocks && blocks.length > 0 && (
            <div className="section">
              <div className="section__head">
                <span className="section__title">使用此贴图的方块</span>
                <span className="section__note">
                  {blocks.length} 个{blocks.length > 8 ? '（显示前 8 个）' : ''}
                </span>
              </div>
              <div className="ref-list">
                {blocks.slice(0, 8).map((block) => (
                  <Link key={block} to={`/blocks?q=${encodeURIComponent(block)}`} className="chip">
                    {block}
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="page-actions">
            <a className="btn btn--primary" href={src} download={`${texture.p.split('/').join('_')}.png`}>
              <span className="btn__icon">
                <DownloadIcon />
              </span>
              下载 PNG
            </a>
            <Button onClick={() => void copy(id)}>{copied ? '已复制' : '复制 ID'}</Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
