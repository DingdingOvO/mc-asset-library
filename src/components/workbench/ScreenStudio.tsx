import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { loadFont, type GlyphFont } from '@/lib/font'
import { textureSrc } from '@/lib/mc'
import { prepare } from '@/lib/mcui/surface'
import {
  BOOK_GUI,
  MAP_GUI,
  SIGN_GUI,
  drawBook,
  drawMap,
  drawSign,
  type MapMarker,
} from '@/lib/mcui/screens'
import { saveBlob, stamp } from '@/lib/export/types'

/**
 * 非容器界面工作室：告示牌 / 书与笔 / 地图。
 *
 * @why 这三种界面没有槽位、没有物品，塞不进「容器 + 格子」的工作台数据模型。
 *      但它们共用同一套字体、同一套 GUI 像素缩放、同一套导出，所以做成一个
 *      组件按 kind 切换，而不是三个页面各抄一遍加载与导出逻辑。
 *
 * @constraint 预览与导出必须走同一个 `draw()`：以前模型页的预览和导出各写一遍
 *      构图，导出的图比屏幕上偏一点，用户只能反复试。这里传不同 guiScale
 *      重画同一份内容，构图天然一致。
 */

type ScreenKind = 'sign' | 'book' | 'map'

/** 告示牌木种：与 `textures/gui/signs/*.png` 一一对应 */
const WOODS: { id: string; zh: string }[] = [
  { id: 'oak', zh: '橡木' },
  { id: 'spruce', zh: '云杉' },
  { id: 'birch', zh: '白桦' },
  { id: 'jungle', zh: '丛林' },
  { id: 'acacia', zh: '金合欢' },
  { id: 'cherry', zh: '樱花' },
  { id: 'dark_oak', zh: '深色橡木' },
  { id: 'mangrove', zh: '红树' },
  { id: 'bamboo', zh: '竹' },
  { id: 'crimson', zh: '绯红' },
  { id: 'warped', zh: '诡异' },
  { id: 'pale_oak', zh: '苍白橡木' },
  { id: 'poplar', zh: '白杨' },
]

/** 染料 16 色，取原版染料物品的颜色 */
const DYES: { value: string; zh: string }[] = [
  { value: '#1e1e1e', zh: '黑' },
  { value: '#3f3f3f', zh: '灰' },
  { value: '#7f7f7f', zh: '淡灰' },
  { value: '#d8d8d8', zh: '白' },
  { value: '#a02b2b', zh: '红' },
  { value: '#c06a2b', zh: '橙' },
  { value: '#d8c02b', zh: '黄' },
  { value: '#5c8a2b', zh: '黄绿' },
  { value: '#2b8a3f', zh: '绿' },
  { value: '#2b8a8a', zh: '青' },
  { value: '#2b5c8a', zh: '淡蓝' },
  { value: '#2b2b8a', zh: '蓝' },
  { value: '#5c2b8a', zh: '紫' },
  { value: '#8a2b8a', zh: '品红' },
  { value: '#8a2b5c', zh: '粉红' },
  { value: '#5c3a1e', zh: '棕' },
]

const MAP_ICONS: { id: string; zh: string }[] = [
  { id: 'player', zh: '玩家箭头' },
  { id: 'target_point', zh: '目标点' },
  { id: 'target_x', zh: '目标叉' },
  { id: 'red_x', zh: '红叉' },
  { id: 'frame', zh: '物品展示框' },
  { id: 'red_marker', zh: '红色标记' },
  { id: 'blue_marker', zh: '蓝色标记' },
  { id: 'plains_village', zh: '平原村庄' },
  { id: 'desert_village', zh: '沙漠村庄' },
  { id: 'snowy_village', zh: '雪原村庄' },
  { id: 'jungle_temple', zh: '丛林神庙' },
  { id: 'desert_pyramid', zh: '沙漠神殿' },
  { id: 'ocean_monument', zh: '海底神殿' },
  { id: 'woodland_mansion', zh: '林地府邸' },
  { id: 'ancient_city', zh: '远古城市' },
  { id: 'trial_chambers', zh: '试炼密室' },
  { id: 'abandoned_camp', zh: '废弃营地' },
]

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
}

export function ScreenStudio({ version, kind }: { version: string; kind: ScreenKind }) {
  const [font, setFont] = useState<GlyphFont | null>(null)
  const [images, setImages] = useState<Map<string, HTMLImageElement>>(new Map())

  const [wood, setWood] = useState('oak')
  const [lines, setLines] = useState(['欢迎来到', 'Minecraft', '', ''])
  const [dye, setDye] = useState(DYES[0]!.value)
  const [glow, setGlow] = useState(false)

  const [text, setText] = useState(
    '这是一段可以被拍进视频的文字。\n折行位置由字宽算出来，中文和英文混排都不会溢出版心。',
  )
  const [title, setTitle] = useState('我的第一本书')
  const [author, setAuthor] = useState('Steve')

  const [markers, setMarkers] = useState<MapMarker[]>([
    { icon: 'player', x: 64, y: 64 },
    { icon: 'target_point', x: 96, y: 40 },
  ])
  const [mapZoom, setMapZoom] = useState(1)

  const [scale, setScale] = useState(4)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    void loadFont(version).then((loaded) => {
      if (alive) setFont(loaded)
    })
    return () => {
      alive = false
    }
  }, [version])

  /** 当前界面要用到的贴图（带 `textures/` 之后的路径，直接拼 URL） */
  const needed = useMemo(() => {
    if (kind === 'sign') return [`gui/signs/${wood}`]
    if (kind === 'book') return ['gui/book']
    return ['map/map_background', ...markers.map((marker) => `map/decorations/${marker.icon}`)]
  }, [kind, wood, markers])

  useEffect(() => {
    let alive = true
    const missing = needed.filter((id) => !images.has(id))
    if (missing.length === 0) return
    void Promise.all(missing.map(async (id) => [id, await loadImage(textureSrc(version, id))] as const)).then(
      (pairs) => {
        if (!alive) return
        setImages((prev) => {
          const next = new Map(prev)
          for (const [id, image] of pairs) if (image) next.set(id, image)
          return next
        })
      },
    )
    return () => {
      alive = false
    }
  }, [needed, version, images])

  const gui = kind === 'sign' ? SIGN_GUI : kind === 'book' ? BOOK_GUI : MAP_GUI

  /** 把当前参数画进任意一块画布；预览和导出共用 */
  const draw = useCallback(
    (canvas: HTMLCanvasElement, guiScale: number): boolean => {
      if (!font) return false
      const surface = prepare(canvas, gui.width, gui.height, guiScale)
      if (!surface) return false
      const { ctx } = surface

      if (kind === 'sign') {
        const board = images.get(`gui/signs/${wood}`)
        if (!board) return false
        drawSign(ctx, font, board, { lines, color: dye, glow })
        return true
      }

      if (kind === 'book') {
        const page = images.get('gui/book')
        if (!page) return false
        drawBook(ctx, font, page, { text, title, author })
        return true
      }

      const background = images.get('map/map_background')
      if (!background) return false
      const icons = new Map<string, CanvasImageSource>()
      for (const marker of markers) {
        const image = images.get(`map/decorations/${marker.icon}`)
        if (image) icons.set(marker.icon, image)
      }
      drawMap(ctx, background, { markers, scale: mapZoom }, icons)
      return true
    },
    [font, gui.width, gui.height, kind, images, wood, lines, dye, glow, text, title, author, markers, mapZoom],
  )

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    /**
     * @constraint 预览密度按界面尺寸定：告示牌板面只有 96×104 GUI 像素，
     *      2 倍下只有 192 CSS 宽，摆在整块舞台里像张邮票；书页 192 宽用 2 倍正好。
     */
    draw(canvas, kind === 'book' ? 2 : 3)
  }, [draw, kind])

  const exportPng = async () => {
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      if (!draw(canvas, scale)) return
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) return
      const base = kind === 'sign' ? 'sign' : kind === 'book' ? 'book' : 'map'
      saveBlob(blob, `mc-${base}-${scale}x-${stamp()}.png`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="studio">
      <aside className="studio__panel">
        {kind === 'sign' && (
          <>
            <h2 className="workbench__section">木种</h2>
            <select className="studio__select" value={wood} onChange={(event) => setWood(event.target.value)}>
              {WOODS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.zh}
                </option>
              ))}
            </select>

            <h2 className="workbench__section">四行文字</h2>
            {lines.map((line, index) => (
              <input
                key={index}
                className="studio__input"
                value={line}
                maxLength={15}
                placeholder={`第 ${index + 1} 行`}
                onChange={(event) =>
                  setLines((prev) => prev.map((item, at) => (at === index ? event.target.value : item)))
                }
              />
            ))}
            <p className="workbench__hint">每行最多 15 字，与原版一致；留空的行不绘制</p>

            <h2 className="workbench__section">染色</h2>
            <div className="studio__swatches">
              {DYES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`studio__swatch${dye === item.value ? ' studio__swatch--on' : ''}`}
                  style={{ background: item.value }}
                  title={item.zh}
                  aria-label={item.zh}
                  onClick={() => setDye(item.value)}
                />
              ))}
            </div>

            <label className="studio__check">
              <input type="checkbox" checked={glow} onChange={(event) => setGlow(event.target.checked)} />
              发光文字
              <span>原版用荧光墨袋染出的效果：去掉阴影、整体提亮</span>
            </label>
          </>
        )}

        {kind === 'book' && (
          <>
            <h2 className="workbench__section">正文</h2>
            <textarea
              className="studio__textarea"
              value={text}
              rows={10}
              onChange={(event) => setText(event.target.value)}
            />
            <p className="workbench__hint">一页最多 13 行，超出会被截掉；换行按字宽计算</p>

            <h2 className="workbench__section">署名</h2>
            <input className="studio__input" value={title} maxLength={32} onChange={(event) => setTitle(event.target.value)} placeholder="标题" />
            <input className="studio__input" value={author} maxLength={16} onChange={(event) => setAuthor(event.target.value)} placeholder="作者" />
          </>
        )}

        {kind === 'map' && (
          <>
            <h2 className="workbench__section">标记</h2>
            <p className="workbench__hint">
              站上没有地形生成，这里给的是原版空地图底图 + 标记布局：位置按 0–128 的地图格子算。
            </p>
            {markers.map((marker, index) => (
              <div className="studio__marker" key={index}>
                <select
                  className="studio__select"
                  value={marker.icon}
                  onChange={(event) =>
                    setMarkers((prev) =>
                      prev.map((item, at) => (at === index ? { ...item, icon: event.target.value } : item)),
                    )
                  }
                >
                  {MAP_ICONS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.zh}
                    </option>
                  ))}
                </select>
                <label className="studio__axis">
                  X
                  <input
                    type="range"
                    min={0}
                    max={MAP_GUI.width}
                    value={marker.x}
                    onChange={(event) =>
                      setMarkers((prev) =>
                        prev.map((item, at) => (at === index ? { ...item, x: Number(event.target.value) } : item)),
                      )
                    }
                  />
                </label>
                <label className="studio__axis">
                  Y
                  <input
                    type="range"
                    min={0}
                    max={MAP_GUI.height}
                    value={marker.y}
                    onChange={(event) =>
                      setMarkers((prev) =>
                        prev.map((item, at) => (at === index ? { ...item, y: Number(event.target.value) } : item)),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="chip chip--ghost"
                  onClick={() => setMarkers((prev) => prev.filter((_, at) => at !== index))}
                >
                  删除
                </button>
              </div>
            ))}
            <button
              type="button"
              className="chip chip--ghost"
              onClick={() =>
                setMarkers((prev) => [...prev, { icon: 'target_point', x: MAP_GUI.width / 2, y: MAP_GUI.height / 2 }])
              }
            >
              加一个标记
            </button>

            <h2 className="workbench__section">缩放等级</h2>
            <select
              className="studio__select"
              value={mapZoom}
              onChange={(event) => setMapZoom(Number(event.target.value))}
            >
              {[0, 1, 2, 3, 4].map((value) => (
                <option key={value} value={value}>
                  {value} 级
                </option>
              ))}
            </select>
          </>
        )}

        <h2 className="workbench__section">导出</h2>
        <div className="studio__export">
          <select className="studio__select" value={scale} onChange={(event) => setScale(Number(event.target.value))}>
            {[2, 4, 8].map((value) => (
              <option key={value} value={value}>
                {value}× （{(gui.width * value).toFixed(0)}px 宽）
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void exportPng()}>
            {busy ? '导出中…' : '导出 PNG'}
          </button>
        </div>
      </aside>

      <div className="studio__stage">
        <canvas ref={canvasRef} className="studio__canvas" />
      </div>
    </div>
  )
}
