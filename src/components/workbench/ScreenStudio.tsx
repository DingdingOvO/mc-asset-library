import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { loadFont, type GlyphFont } from '@/lib/font'
import { textureSrc } from '@/lib/mc'
import { prepare } from '@/lib/mcui/surface'
import {
  BOOK_GUI,
  MAP_GUI,
  MAP_PALETTE,
  SIGN_GUI,
  drawBook,
  drawMap,
  drawSign,
  type MapMarker,
} from '@/lib/mcui/screens'
import { useMapPaint, type MapTool } from '@/lib/useMapPaint'
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

const MAP_TOOLS: { id: MapTool; zh: string; key: string; tip: string }[] = [
  { id: 'brush', zh: '画笔', key: 'B', tip: '按住拖动，一格一像素' },
  { id: 'eraser', zh: '橡皮', key: 'E', tip: '擦回底图（快捷键 E）' },
  { id: 'fill', zh: '填充', key: 'G', tip: '同一片同色的区域一次铺满（快捷键 G）' },
  { id: 'picker', zh: '吸管', key: 'I', tip: '取图上已有颜色（快捷键 I）' },
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
  const board = useMapPaint()
  const [tool, setTool] = useState<MapTool>('brush')
  /** 当前色号，与 `MAP_PALETTE` 的下标 + 1 对应 */
  /** 默认给草地绿：最常见的构图是地表，开局就在灰石色上画会让人以为色板坏了 */
  const [color, setColor] = useState(5)

  const [scale, setScale] = useState(4)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  /** 悬停格高亮。直接改 DOM style，不进 React 状态——见 paintMove 的注释 */
  const caretRef = useRef<HTMLDivElement>(null)
  /** 预览密度：按舞台可用面积算出的**整数**倍率 */
  const [previewScale, setPreviewScale] = useState(3)

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
      drawMap(ctx, background, { markers, scale: mapZoom }, icons, board.raster)
      return true
    },
    [
      font,
      gui.width,
      gui.height,
      kind,
      images,
      wood,
      lines,
      dye,
      glow,
      text,
      title,
      author,
      markers,
      mapZoom,
      board.raster,
      board.version,
    ],
  )

  /**
   * 画板快捷键。
   * @why 画地图是高频切换工具的动作，鼠标从画布挪到左上角工具条再挪回来，
   *      一次就是 300px 的路程，画十笔要走十遍。键盘留在左手、笔尖不离画布，
   *      才是绘图工具该有的手感。
   * @constraint 输入框聚焦时一律不接管：告示牌那四个格子天天在打字。
   */
  useEffect(() => {
    if (kind !== 'map') return
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        board.undo()
        event.preventDefault()
        return
      }
      const keys: Record<string, MapTool> = { b: 'brush', e: 'eraser', g: 'fill', i: 'picker' }
      const next = keys[event.key.toLowerCase()]
      if (next) {
        setTool(next)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // @constraint 依赖 board.undo 而不是 board：board 每次渲染都是新对象，
    // 而地图拖动时每帧都会重渲染，整条监听会被反复拆装。
  }, [kind, board.undo])

  /**
   * 预览倍率按舞台实测面积算，而不是按界面种类写死。
   *
   * @why 原来写死「书 2 倍、其余 3 倍」：1440 宽的屏幕上地图只有 384 CSS，
   *      四周全是棋盘格，而手机上 3 倍又刚好超出可视宽度被 CSS 夹成 2.9 倍——
   *      非整数倍正是把 1px 边框糊成 2px 的元凶。算出来的倍数一定落得下，
   *      CSS 那两道 max-width/max-height 就只是兜底，不再是常态。
   * @constraint 上限 8：再大只是白烧显存，人眼在 8 倍点阵上已经看不到更多细节。
   */
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const style = getComputedStyle(stage)
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const width = stage.clientWidth - padX
      const height = stage.clientHeight - padY
      if (width <= 0 || height <= 0) return
      const fit = Math.floor(Math.min(width / gui.width, height / gui.height))
      setPreviewScale(Math.max(1, Math.min(fit, 8)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [gui.width, gui.height])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    draw(canvas, previewScale)
  }, [draw, previewScale])

  /**
   * 地图笔刷的指针入口。
   * @why 换算用 `getBoundingClientRect()` 而不是 canvas 的 width/属性：画布的
   *      设备像素是 GUI 尺寸 × ratio × dpr，CSS 尺寸又被 CSS 夹过（max-width），
   *      两套数字对不上，按属性换算会让笔尖偏出去几十格。
   */
  const atPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return board.locate(rect, event.clientX, event.clientY)
  }

  /**
   * 悬停格子高亮。
   *
   * @why 8 倍预览下一格 8px，落笔到底压在哪一格肉眼分不出来，画细节全靠试。
   *      一个跟着指针走的方框把这个判断变成「看得见」，和绘图软件的光标同义。
   * @constraint 必须直接写 DOM style，不能 setState：指针每秒移动上百次，
   *      走 React 会把整棵树重渲染上百次，反而拖慢落笔。
   */
  const moveCaret = (canvas: HTMLCanvasElement, at: { x: number; y: number } | null) => {
    const caret = caretRef.current
    const stage = stageRef.current
    if (!caret || !stage) return
    if (!at) {
      caret.style.opacity = '0'
      return
    }
    const rect = canvas.getBoundingClientRect()
    const box = stage.getBoundingClientRect()
    const size = rect.width / MAP_GUI.width
    caret.style.width = `${size}px`
    caret.style.height = `${size}px`
    caret.style.transform = `translate(${rect.left - box.left + at.x * size}px, ${
      rect.top - box.top + at.y * size
    }px)`
    caret.style.opacity = '1'
  }

  const paintDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (kind !== 'map') return
    const at = atPointer(event)
    moveCaret(event.currentTarget, at)
    if (!at) return
    if (tool === 'picker') {
      const value = board.sample(at.x, at.y)
      if (value > 0) setColor(value)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    board.begin(at.x, at.y, tool, tool === 'eraser' ? 0 : color)
  }

  const paintMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (kind !== 'map') return
    const at = atPointer(event)
    moveCaret(event.currentTarget, at)
    if (tool === 'picker' || tool === 'fill') return
    if (at) board.move(at.x, at.y)
  }

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
            <h2 className="workbench__section">画板</h2>
            <p className="workbench__hint">
              128×128 的地图格子，一格一像素。左边预览图上按住直接画。
            </p>

            <div className="board__tools" role="group" aria-label="笔刷工具">
              {MAP_TOOLS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`board__tool${tool === item.id ? ' board__tool--on' : ''}`}
                  title={item.tip}
                  onClick={() => setTool(item.id)}
                >
                  {item.zh}
                  <em>{item.key}</em>
                </button>
              ))}
              <button
                type="button"
                className="board__tool"
                onClick={() => board.undo()}
                disabled={!board.canUndo}
                title="退回上一笔（Ctrl/⌘ + Z）"
              >
                撤销
              </button>
              <button type="button" className="board__tool" onClick={() => board.clear()} title="整张清空">
                清空
              </button>
            </div>

            {/* @why 按基色分行排四档明暗：14 组 × 4 挤成 56 个色块，比一串
                单行色板好找得多——同一行里比较明暗，比在 56 个里找"浅一点的那个绿"快。 */}
            <div className="board__palette">
              {MAP_PALETTE.map((group, groupIndex) => (
                <div className="board__row" key={groupIndex}>
                  {group.map((hex, level) => {
                    const index = groupIndex * 4 + level + 1
                    return (
                      <button
                        key={index}
                        type="button"
                        className={`board__swatch${color === index ? ' board__swatch--on' : ''}`}
                        style={{ background: hex }}
                        aria-label={`色号 ${index}`}
                        title={`色号 ${index} · ${hex}`}
                        onClick={() => {
                          setColor(index)
                          if (tool === 'eraser') setTool('brush')
                        }}
                      />
                    )
                  })}
                </div>
              ))}
            </div>

            <h2 className="workbench__section">标记</h2>
            <p className="workbench__hint">位置按 0–128 的地图格子算，叠在画好的底图上。</p>
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
            {/* @why 上限按宽度卡而不是写死三档：告示牌 96 宽能出 16 倍（1536px），
                书页 192 宽到 16 倍就是 3072，投视频也用不上这么大的单页。 */}
            {[2, 4, 8, 16]
              .filter((value) => gui.width * value <= 2048)
              .map((value) => (
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

      <div className="studio__stage" ref={stageRef}>
        <canvas
          key={kind}
          ref={canvasRef}
          className={`studio__canvas${kind === 'map' ? ' studio__canvas--draw' : ''}`}
          onPointerDown={paintDown}
          onPointerMove={paintMove}
          onPointerUp={() => board.end()}
          onPointerCancel={() => board.end()}
          onPointerLeave={(event) => {
            board.end()
            moveCaret(event.currentTarget, null)
          }}
        />
        {kind === 'map' && <div className="studio__caret" ref={caretRef} aria-hidden="true" />}
        {kind === 'map' && (
          <p className="studio__status">
            {MAP_GUI.width}×{MAP_GUI.height} · 工具 {MAP_TOOLS.find((item) => item.id === tool)?.zh}
            {tool === 'picker' ? '' : ` · 第 ${
              MAP_PALETTE.findIndex((group, groupIndex) =>
                group.some((_, level) => groupIndex * 4 + level + 1 === color),
              ) + 1
            } 组色`}
          </p>
        )}
      </div>
    </div>
  )
}
