/**
 * 按需取面数据分片（方块页 / 物品页共用）。
 *
 * @why 这两页的加载逻辑此前各抄了一份，约 90 行：可见项 → 需要哪一片 →
 *      并发取回 → 记账 → 统一触发一次重渲染。两份代码里连着三条注释
 *      （为什么用 ref 记账、为什么不能用 effect 清理标志、为什么必须在
 *      setup 里把 mounted 置回 true）也一模一样。任何一条将来只在一边改，
 *      另一边就会退化成「滚动时卡片永远停在占位」——那是个只在 Pages 上
 *      才复现的 bug，本地开发环境根本看不出来。
 *
 * @constraint 面数据落地用 ref 而不是 state：一帧可能同时回来三片、每片两百条，
 *      逐片 setState 会让整页在滚动时重排三次。全部落地后统一 +1 一次 revision。
 */
import { useEffect, useRef, useState } from 'react'
import { loadBakeShard, type BakedFace } from './blockmodels'

/** 面数据分片所属的目录名 */
export type ShardKind = 'blocks' | 'items'

export interface ShardFaces {
  /** id → 面数据。原地修改，读取方必须以 revision 为依赖 */
  faces: Record<string, BakedFace[]>
  /** 每当有新的一批分片落地就自增 */
  revision: number
}

export function useShardFaces(
  version: string,
  kind: ShardKind,
  /** 条目 id → 分片下标 */
  shardOf: Map<string, number>,
  /** 当前视口内的条目 */
  visible: readonly { id: string }[],
  /** 详情页当前打开的条目 id，null 表示没打开 */
  selectedId: string | null,
): ShardFaces {
  const facesRef = useRef<Record<string, BakedFace[]>>({})
  const doneShards = useRef(new Set<number>())
  const loadingShards = useRef(new Set<number>())
  const [revision, setRevision] = useState(0)

  /**
   * 组件是否还挂载。
   * @why 不能用取数据 effect 的清理标志判断：分片回来前，注册表/语言数据到达
   *      会触发重渲染，effect 随之被清理重建。用清理标志就会把已经到手的
   *      数据当垃圾丢掉，而 doneShards 没标记、revision 没自增，依赖也不再
   *      变化——卡片永远停在占位（Pages 上分片要 1.3 秒，必现）。
   */
  const mounted = useRef(true)
  useEffect(() => {
    // @constraint 必须在 setup 里置回 true。StrictMode 下 effect 会走
    //      setup → cleanup → setup 一轮，只在 cleanup 里置 false 的话，
    //      开发环境整页永远停在占位。
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // 换版本等于换一整套数据，旧分片的下标全部失效
  useEffect(() => {
    facesRef.current = {}
    doneShards.current = new Set()
    loadingShards.current = new Set()
    setRevision((value) => value + 1)
  }, [version])

  /**
   * 滚动到哪一片就取哪一片。
   * @constraint 依赖必须是 visible 而不是「所有条目」：拖动滚动条会瞬间跳过
   *      几十行，按可见项算才能只请求真正要画的那几片。
   */
  useEffect(() => {
    const want: number[] = []
    for (const entry of visible) {
      const shard = shardOf.get(entry.id)
      if (shard === undefined) continue
      if (doneShards.current.has(shard) || loadingShards.current.has(shard)) continue
      loadingShards.current.add(shard)
      want.push(shard)
    }
    if (want.length === 0) return

    void Promise.all(
      want.map(async (shard) => {
        try {
          const part = await loadBakeShard(version, kind, shard)
          Object.assign(facesRef.current, part)
          doneShards.current.add(shard)
        } catch {
          // 失败的片允许下次滚动时重试，不要标记成已完成
        } finally {
          loadingShards.current.delete(shard)
        }
      }),
    ).then(() => {
      if (mounted.current) setRevision((value) => value + 1)
    })
  }, [visible, shardOf, version, kind])

  /**
   * 点开了还没取回面数据的条目。
   * @why 可见性判定与点击之间有几帧的窗口，没有这一步，用户在分片还在路上时
   *      点开头一张卡片，弹窗会显示「没有可用的立体模型」。
   */
  useEffect(() => {
    if (!selectedId) return
    if (facesRef.current[selectedId]) return
    const shard = shardOf.get(selectedId)
    if (shard === undefined) return
    void loadBakeShard(version, kind, shard).then((part) => {
      Object.assign(facesRef.current, part)
      doneShards.current.add(shard)
      setRevision((value) => value + 1)
    })
  }, [selectedId, shardOf, version, kind])

  return { faces: facesRef.current, revision }
}
