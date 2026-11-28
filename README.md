# MC 素材库

**[dingdingovo.github.io/mc-asset-library](https://dingdingovo.github.io/mc-asset-library/)** — 直接打开就能用，不需要本地跑。

在浏览器里翻阅 Minecraft 的全部素材：方块、物品、生物模型、粒子、界面图、音效。做视频时不用开游戏对着看——模型在站内直接渲染、动画直接播放，需要成图时把界面摆出来导出。

三件事和常见的「贴图预览站」不一样：

- **渲染有两条路，按能力自动切**。有 WebGL2 时走 `render/` 里的 GPU 管线（着色器逐行照搬原版 core shader，顶点格式对齐 `DefaultVertexFormat.BLOCK`）；没有时退回 `raster.ts` 的软件光栅器，逐像素填充 + z-buffer + 超采样。所以"关了硬件加速的浏览器"也能看，而且每条路径都能逐像素控制、能离线导出。
- **生物模型不是猜的**。几何、UV、动画、渲染图层全部由 `scripts/extract-*.py` 从反编译的 Java 源码里提取，字段与 `ModelPart$Cube`、`setupAnim`、`addLayer` 一一对应。263 个烘焙模型全部有贴图，`for` 循环里建的部件（烈焰人的十二根棒子、末影龙的脖子）、静态数组常量（蠹虫的分段尺寸）、返回数值的静态方法（守护者的十二根尖刺）都按源码求值，不靠猜。
- **动作量也是**。步态不由"每秒转多少弧度"这类估算驱动，而是照 `LivingEntity.updateWalkAnimation` 实现：速度由位移 ×4 平滑而来、上限 1，位置是速度的逐 tick 累加，所以腿的相位与步幅天然一致（玩家稳定态是 0.864 而不是 1）。史莱姆的伸缩走 `AbstractCubeMob.tick` 的落地/离地双状态、鱿鱼触手走 `|sin(movement)|·π/4`，都是原样搬过来的。
- **状态能选**。品种、花纹、染色、职业都是下拉框：猫 11 种毛色、狼 27 张、马 7 色 × 5 花纹、村民 7 生态型 × 15 职业（僵尸村民同样）。
- **界面是可编辑的，不是贴图墙**。「界面」页是一张工作区：左边按「快捷栏/储存/工作站/玩家与交易」分组点一个容器放进来，右边填数量（直接输入 1–99）、点物品、点格子放下，最后按容器导出。容器尺寸、槽位坐标、背景切片、动态层坐标全部来自反编译源码——`AbstractContainerMenu` 子类里那串 `addSlot(new Slot(..., x, y))`、`AbstractContainerScreen` 的 `super(..., 176, 168)` 与 `extractBackground` 的 `blit` 切片，由 `scripts/extract-containers.py` 提取成 `containers.json`（24 个容器，含 HUD 快捷栏）。箱子是两段拼接（上盖 + 玩家背包，`v=126`）、大箱子的背包第一行在 `y=85` 不是 84，这些都不是估出来的。
- **容器有状态，不只是格子**。熔炉/烟熏炉/高炉的火焰与箭头、酿造台的燃料/进度/气泡、信标的等级与主副效果、附魔台的可用行数、铁砧的等级消耗、合成器的红石信号，都在数据层声明成 `controls` + `layers`，界面据此自动生成控件，选中容器时出现在画布上方的状态条里。层只有 `progress / sprite / effect-button / enchant-row / text / cost / select` 七种，每种一个 `switch` 分支——不用表达式求值器：`Mth.ceil(v * 24)` 这类式子交给 eval 在 0、负数、浮点边界上几乎必错且静默。气泡高度是 `BUBBLELENGTHS` 的离散表，所以层里给的是 `table` 而不是 `scale`。
- **标签不是每个界面都画**。基类画"标题 + 物品栏"两行，但 `InventoryScreen` 只画标题（背包标题本身就是"物品栏"）、`BeaconScreen` 一行都不画、`MerchantScreen` 标题居中带等级还要多画一个 "Trades"。照基类硬画会出现两个"物品栏"、信标标题压在效果按钮上。`labelSpec` 逐条登记，显示与导出共用。
- **文字是位图字体**。拉丁字母 `advance = 字形最右非透明列 + 1`，空格的 4 像素来自 `font/include/space.json` 的 space provider；中文不在 `ascii.png` 里，走原版 `font/unifont.zip` 的 hex 点阵，`scripts/extract-font-zh.py` 只抽语言文件和动态层里真正出现过的字（126 个字形、12KB），`advance = 字宽/2 + 1`、按 oversample=2 落到 8px 高，并对 2×2 像素做合并采样——最近邻会把笔画打碎成孤立点。
- **导出是分层的**。PNG 只是压平的结果，PSD 里每个容器拆成「背景 / 状态 / 物品 / 文字」四层——做视频的人拿到平面图之后想换个格子里的物品、关掉火焰、把标题改回英文，都只能自己抠；分层之后是关一个图层。
- **该动的都在动**。水、岩浆、火、海带这些 `.mcmeta` 动画贴图按游戏自己的节奏播放——`frametime` 是几就几 tick 换一帧，`frames` 里写了来回序列的（岩浆是 0..19 再 18..1）就按序列走，列表缩略图也一样动。音效列表挂的是官方字幕中文名（「方块：被破坏」），路径退到第二行方便复制。
- **素材不进仓库**。500MB 的纹理和音效由一条命令从 Mojang 官方端点拉回来，仓库里只放代码和那些**无法重建**的派生数据。

## 快速开始

```bash
pnpm install
pnpm run setup     # 下载官方素材到 mc-assets/，约 500MB（含音效）
pnpm run dev
```

国内网络拉 Mojang 慢的话：

```bash
pnpm run setup -- --cdn=https://bmclapi2.bangbang93.com/assets
```

只关心图片、不需要 4961 个音效：

```bash
pnpm run setup:lite   # 下载约 130MB，落盘 145MB；完整版再多半 GB 音效
```

## 前端结构

页面按功能切分在 `src/features/` 下，样式与控件按层收在 `src/ui/` 与 `src/styles/`。
一条规则：**页面只描述内容，不描述长相**——长相全部来自基元层，改一处全站生效。

```
src/
├── features/            一个目录 = 一个页面（含它自己的 .css）
│   ├── home/            首页：入口、统计
│   ├── blocks/          方块
│   ├── items/           物品（分类来自创造栏）
│   ├── entities/        生物
│   ├── particles/       粒子
│   ├── textures/        贴图文件
│   ├── sounds/          音效
│   ├── structures/      结构（窄列表 + 大画布）
│   ├── data/            数据总览 + 注册表详情
│   ├── workbench/       界面工作台（容器 / 告示牌 / 书 / 地图）
│   ├── text3d/          立体字
│   └── notfound/        404
├── ui/                  设计系统：不含业务知识
│   ├── Page.tsx         Page / PageHeader / Section / EmptyState / LoadingState / ErrorState
│   ├── Toolbar.tsx      粘性工具栏（搜索独占一行，分类在下一行）
│   ├── SearchField.tsx  搜索框（/ 聚焦、Esc 清空、清空按钮）
│   ├── FilterChips.tsx  分类筛选（链接或按钮两种模式）
│   ├── AssetGrid.tsx    网格容器（虚拟化由 useVirtualGrid 驱动）
│   ├── AssetTile.tsx    唯一的卡片：缩略区 + 单行名称 + 可选副标题
│   ├── Dialog.tsx       唯一的弹窗：portal / Esc / 滚动锁 / 焦点圈定 / 退场
│   ├── Button.tsx       按钮
│   └── Switch.tsx       开关
├── styles/
│   ├── tokens.css       颜色、间距、字号、圆角、阴影、层级（浅/深两套）
│   ├── base.css         重置、排版、焦点、滚动条
│   ├── layout.css       外壳、顶栏、页面容器、页头、页脚
│   ├── ui.css           基元：btn / input / chip / tile / grid / modal / table / state
│   ├── studio.css       工作室布局（立体字与告示牌/书/地图共用）
│   ├── workbench.css    工作台外壳（画布几何仍在 legacy 里）
│   └── legacy-workbench.css  旧画布与弹窗内部结构（迁移中，勿新增规则）
├── components/          跨页共享的渲染组件（ModelView / ModelModal / 各类面板）
├── lib/                 数据加载、几何、动画、导出
└── render/              WebGL2 管线与 CPU 光栅化
```

### 写新页面时照这个来

| 需要什么 | 用什么 | 不要 |
|---|---|---|
| 页面外边距 | `<Page>` / `<Page wide>` | 自己写 `max-width` + `padding` |
| 标题与面包屑 | `<PageHeader back title lead>` | 手写 `.page-head` |
| 搜索 + 筛选 | `<Toolbar>` + `<SearchField>` + `<FilterChips>` | 把搜索框和 chips 塞进同一个 flex 行 |
| 列表 | `<AssetGrid>` + `<useVirtualGrid>` + `<AssetTile>` | 新写一套 `.xxx-cell` |
| 详情 | `<Dialog>` + `.modal__view` / `.modal__side` | 自己写遮罩、Esc、滚动锁 |
| 查询参数 | `useQueryParam()` | 每页复制一份 `updateQuery` |
| 空 / 加载 / 出错 | `<EmptyState>` / `<LoadingState>` / `<ErrorState>` | 一行灰字 |

### 这次重构修掉的问题

- **物品分类**：`sync` 只把派生数据留在 `mc-derived/`，开发态读的 `items.json` 里 `groups`
  只有一项，物品页顶部只有「全部 / 未分类」。现在 `sync` 会把 `creativetabs.json`
  放进素材目录并重跑分组归一化，本地与线上一致（12 个分类）。
- **搜索框塌陷**：音效页 14 个分类 chips 把同行的搜索框挤成 30px 宽。工具栏改成两行，
  搜索框独占一行并设上限。
- **弹窗行为不一致**：`ModelModal` 没有 Esc、不锁背景滚动，`TextureDetail` 有；
  三个弹窗各写一套退场动画。统一到 `Dialog`。
- **弹窗信息被压扁**：右侧是滚动容器，flex 子项默认 `shrink:1`，键值表被压到 2px。
- **面板控件被压扁**：立体字页的 `textarea` 被压成一条、滑块溢出面板，同样原因。
- **虚拟网格错位**：行高写死 118/120 与 CSS 实际高度不符；过滤后视口停在旧位置。
  现在实测行高，并在筛选条件变化时回到网格顶部。
- **纹理缩略图过小**：`img` 按固有尺寸排，16×16 的贴图在 96px 格子里只有一个点。
- **粒子卡片参差**：名称两行、meta 换行把行高撑开。卡片高度固定，名称单行省略。
- **结构页脱节**：没有页面容器、搜索框是裸 `input`、列表与画布都没有卡片边界。
- **工作台手机端**：容器条竖排吃掉整屏、画布被压到 0；现在回到横排滚动。
- **顶部导航溢出**：最后一页被硬切，加渐隐提示。
- **首页音效 0 个**：`versions.json` 的音效数按磁盘上的 `.ogg` 统计，`--no-sounds`
  的素材里一条都没有，于是首页写「0 个」而音效页列着 4961 条。计数改为读实际
  分发的 `sounds.json`，并由 `sync` 与 `pack` 共用同一个函数写入。
- **开发态音效页空白**：派生清单 `mc-derived/sounds.json`（含官方字幕中文名）
  以前只在 `pack` 阶段覆盖进素材，本地 dev 读到的是空清单。现在 `sync` 也覆盖。
- **注册表旧路由**：`/registries/effects`、`/registries/particles` 统一到
  `/data/effects`、`/data/particles`，不再靠客户端重定向兜。
- **状态条样式串台**：工作台状态条与空状态块共用 `.state`，新基元层把状态条
  撑成 64px 内边距的居中空态。状态条改名 `.statebar`，两套语义彻底分开。
- **提示条被拆成竖列**：`.notice` 原本是 `display:flex`，里面的行内 `<span class="mono">`
  变成独立列，手机上整段提示碎成几条竖排文字。改为块级排版。
- **注册表卡片重复字符串**：粒子和部分效果没有中文名，`n` 就是注册 id，
  卡片上同一个字符串印两遍。名字与 id 相同时不再画副标题。
- **导出失败用 `alert`**：原生弹窗会截断长报错，关掉就没了。改成面板内的
  可关闭提示条。
- **首页统计折行错位**：`flex-wrap` 下第二行只有两项、宽度还跟着内容变，
  手机上六个数字歪成两截。改成网格，桌面 6 列、手机 3 列。
- **加载态各写一套**：路由懒加载用灰字、部分页面用 `state__hint` 拼空态、
  少数页面用 `<p className="empty">`。统一到 `LoadingState` / `EmptyState`。
- **404 的返回按钮**：从站外直接打开详情链接时 `history.back()` 无处可回，
  按钮点了没反应。改成显式 `Link`。

## 目录

| 路径 | 说明 | 入库 |
|---|---|---|
| `src/lib/raster.ts` | 软件光栅器：三角形填充、z-buffer、半透明 over 合成 | ✅ |
| `src/lib/scene.ts` | 正交投影、光照、描边、画布合成 | ✅ |
| `src/render/camera/projection.ts` | **相机与取景数学的唯一真相**：旋转、取景占比。CPU 光栅化与 GPU 管线都从这里取，不允许各写一份 | ✅ |
| `src/lib/useShardFaces.ts` | 面数据按分片按需加载（方块页 / 物品页共用） | ✅ |
| `scripts/items-group.mjs` | 用创造栏数据回填物品分类与顺序，打包时按需重算 | ✅ |
| `scripts/extract-tabs.py` | 读 client.jar 字节码还原创造栏分类与顺序（含颜色集合、铜系列变体展开） | ✅ |
| `src/lib/blockmodels.ts` | 方块模型 JSON → 面片，含 `elements`/`rotation`/`uvlock` | ✅ |
| `src/lib/entityRig.ts` | `ModelPart` 树 → 面片，逐盒 UV 展开 | ✅ |
| `src/lib/anim.ts` | `setupAnim` 的 JS 侧复刻：行走、坐、幼年、头部朝向 | ✅ |
| `mc-derived/26.3/*.json` | **从反编译源码提取、官方 jar 里没有的派生数据** | ✅ 1.3MB |
| `mc-assets/26.3/**` | 官方纹理、音效、模型、语言文件 | ❌ 由 `setup` 重建 |
| `scripts/fetch-assets.mjs` | 素材管线：piston-meta → client.jar → 解包 + 建索引 | ✅ |
| `scripts/assets.mjs` | 素材管线的统一入口（sync/ensure/verify/lock/stats） | ✅ |
| `scripts/extract-containers.py` | 从反编译源码提取容器槽位/尺寸/切片 → `containers.json` | ✅ |
| `src/lib/workspace.ts` | 工作区模型：容器节点、槽位物品、序列化 | ✅ |

## 渲染与数据口径对照

这一栏是"到底照没照原版"的答案——每一行都能在代码里找到对应实现，能自己核对：

| 站点实现 | 原版来源 |
|---|---|
| `render/shader/terrain.ts` | `assets/minecraft/shaders/core/terrain.vsh\|fsh`，含 `sampler2D Sampler2` 光照图、`sampleRGSS`、`ChunkVisibility` 淡入；只去掉 `MULTIDRAW_TERRAIN`/`OIT_*`/`FADE_IN` 三个用不到的分支 |
| `render/lighting/directions.ts` | `Lighting.Entry` 的四组方向（`level`/`nether`/`inventory`/`items_flat`/`items_3d`）与 `CardinalLighting.DEFAULT`（1.0 / 0.8 / 0.6 / **0.5**） |
| `render/camera/projection.ts` | JOML `Matrix4f.rotationXYZ` 语义（`Rx·Ry·Rz`），CPU 与 GPU 共用一份 |
| `render/core/buffer.ts` `BLOCK_LAYOUT` | `DefaultVertexFormat.BLOCK` 的字段顺序与归一化方式 |
| `render/world/mesher.ts` | 邻接剔除规则：只有「邻居是不透明满格」才丢面，玻璃/树叶之间保留 |
| `scripts/fetch-assets.mjs` `textureAlpha` | `RenderType` 的三档（solid / cutout / translucent）。位深 1/2/4/8/16、调色板 + `tRNS`、灰度 + 颜色键、真彩 + `tRNS` 全部按 PNG 规范解，贴在模型上的 `force_translucent` 优先于像素统计 |
| `lib/world/nbt.ts` · `structure.ts` | `NbtIo` 的位宽与 gzip 约定；`StructureTemplate` 的 palette 下标、`Rotation` 四档、`Mirror`；`jigsaw`/`structure_block`/`barrier`/`light`/`cave_air` 按"玩家看不见"跳过 |
| `lib/entityRig.ts` · `entityMesh.ts` | `ModelPart$Cube` 的逐盒 UV 展开，跨度 0 的面丢弃；父子关系按**下标**而不是名字（悦灵、青蛙、嘎枝都是 `root` 套 `root`，按名字查父会解析成自环） |
| `scripts/extract-entities.py` `match_texture` | `LayerDefinition.create(mesh, texW, texH)` 里的**网格尺寸**才是 UV 归一化的除数，贴图分辨率不参与（恶魂的 `ghast.png` 是 128×64、网格是 64×32，按贴图宽归一化会把右半边推到采样范围外） |
| `scripts/extract-entities.py` `retain_parts` | `PartDefinition.retainPartsAndChildren`：同一个 `MeshDefinition` 被多个图层复用时，各层要用 retain 把无关部件的 cube 清空（旋风人的头身层是 32×32 网格，里面还带着 128×128 的风涡盒子） |
| `scripts/extract-entities.py` `parse_cubes` | `addBox(id, x, y, z, w, h, d, texX, texY)` 与 `addBox(id, …, CubeDeformation, texX, texY)` 两种带 id 的重载，UV 在参数**末尾**（末影龙 65 个盒子全是这个写法） |
| `scripts/extract-layers.py` | `addLayer(new XxxLayer(...))` 的整条链，含 `RenderTypes.entityTranslucent` / `breezeWind` 这类需要混合的图层（按 cutout 抠像会把风涡抠成几条硬白边） |
| `scripts/extract-entities.py` `parse_pose` | `PartPose.ZERO.withScale(f)` / `.scaled(f)` / `.translated(x,y,z)` 的链式叠加（末地水晶三层玻璃是 1 / 0.875 / 0.765625，漏掉缩放三层就完全重合） |
| `lib/entityRig.ts` `flipY` · `scripts/extract-renderers.py` `flips_y` | 各渲染器自己翻不翻 y：`LivingEntityRenderer` 有 `scale(-1,-1,1)`，`EndCrystalRenderer` 没有；统一翻会让末地水晶倒过来 |
| `lib/anim.ts` `MC.qAxis/qmul` · `PartPose.q` | `ModelPart.rotateBy(Quaternionf)`：末地水晶绕 `(SIN45,0,SIN45)` 拧 60° 再叠 Y 轴自转，欧拉角表达不了斜轴 |
| `lib/shapeRig.ts` · `extract-renderers.py` `SHAPES` | 没有 `ModelPart` 树的实体按渲染器实际绘制的东西凑几何：`ThrownItemRenderer` 画物品模型、`TntRenderer` 画 TNT 方块、`ExperienceOrbRenderer` 画 4×4 图集里的单格 billboard |
| `lib/anim.ts` | `setupAnim` 与 `LivingEntity.updateWalkAnimation` 的逐步复刻 |
| `lib/mcui/*` | `TooltipRenderUtil`、`NineSlice`、`GuiGraphics.blitSprite`、`AbstractContainerScreen` 的槽位坐标 |
| `lib/font.ts` | `UnihexProvider.Glyph` 的 `unpackBitsToBytes`、字形 `advance` 规则 |
| `scripts/extract-tabs.py` | 直接读 `client.jar` 里 `CreativeModeTabs` 的字节码，配合 `BlockItemIds` / `ItemIds` 的 `create("...")` 还原真实 id |

### 界面页：容器与非容器分开

`/ui` 的三种界面共用字体、整数缩放与导出，但**数据模型不同**：

| 页签 | 做法 | 为什么不能合并 |
|---|---|---|
| 容器工作台 | `lib/workspace.ts` 的节点 + 槽位，容器几何来自 `containers.json` | 有槽位、有物品、有状态参数 |
| 告示牌 | `lib/mcui/screens.ts` 直接画 `gui/signs/<木种>.png`，四行文本居中落进板面 | 没有槽位，只有四行文字 |
| 书与笔 | `book.png` 左上 192×192，正文按 114px 折行 | 正文是流式排版 |
| 地图 | `map/map_background.png` + 128×128 笔刷层 `lib/useMapPaint.ts` + `map/decorations/*` 标记 | 内容是一张位图加一组坐标点 |

硬把后两种塞进容器工作台，会让 `Workspace` 里长出一半用不到的字段（`sign_lines`、`book_text`…），而它们之间没有任何共享逻辑。

立体字**不在这一页**，它是独立的一级页面 `/text3d`：前三页产出的是「游戏里真会出现的那个界面」，立体字产出的是模型文件和 PNG，是造素材的工具，不是界面预览。混在一起会让这个分类失去意义。

悬停提示也分成两套，界线是**游戏画面的边界**：

- 容器**内部**的槽位 → `McTooltip`，九宫格 + `ascii.png` 位图字，与原版一致
- 容器**外面**的物品栏 → `SiteTip`，站点自己的圆角卡片；给网页控件套像素边框不是「还原原版」，只是把浏览器装扮成游戏

### 工作台的三条可用性前提

摆容器、放物品是两个动作，界面必须同时对这两件事负责。有三处不是「美观」而是「能不能用」：

| 位置 | 做法 | 不这么做会怎样 |
|---|---|---|
| 手持状态 | 画布底部常驻一条 `held-bar`，显示图标 / 名字 / 数量 / 放下按钮 | 「点物品拿在手上、再点格子放下」的第二步没有反馈，用户不知道手上有没有东西 |
| 手机物品区 | 底部抽屉，收起 200px 露出两排，选中物品后**自动收起** | 固定分区时画布与物品栏各占一半，选完物品看不见要放的格子 |
| 空画布 | 铺满可视区，给三个起手容器 | 原来是个 168px 的虚线小框，周围还是同样的网格底，看起来像「画布之外还有画布」 |

手机上还有两处必须让位：

- `stage__tools`（容器上方的复制/删除浮条）**隐藏**，两个动作挪进状态面板头部——画布只有 220–440px 高，浮条挂在容器上方会顶出可视区
- 缩放从「1× 2× 3× 4× 四个按钮」收成一个循环按钮：四个并排要 130px 宽，会盖掉容器右上角一整格

`Stage` 的内容包围盒从 **0** 起算，不是 640×420。写死 640 会让画布至少有 1280 宽（2 倍缩放），桌面上放一个箱子就长出横向滚动条；真正的铺满交给 `.stage { min-width: 100% }`。

### 点阵字体只用在一处

站点是网页，正文、导航、按钮一律系统字体。唯一用 unifont 点阵（`--font-pixel`）的是**界面页里会变成游戏画面的那几行输入**：告示牌的四行、书页正文、署名。

理由不是风格统一，是排版判断：

- 你敲的字画到 canvas 上是 16×16 点阵，输入框却渲染成系统无衬线，同一个字两边宽度不同
- 「这行会不会折行」在编辑时看不出来，只能反复导出试
- 字号必须 16px——点阵按 16 像素网格设计，13/15px 会被重采样成半像素，笔画糊得比系统字体还难看

给整站换点阵字是另一回事：那只是把浏览器装扮成游戏，且 12px 的导航项在点阵下是一团黑。

**只有输入框**用点阵，面板标签、下拉、按钮一律系统字体。

这条边界是踩出来的：先给整个 `/ui` 换点阵，结果「木种」「四行文字」「染色」这些标签在 12px 下挤成一团黑——点阵字是 16 像素网格设计的，压到 12/13px 会被重采样成半像素，比系统字体难看得多。真正需要点阵的只有「会被画进游戏画面」的那几个输入框，因为那里要能预判折行；标签不进画面，用系统字体更清楚。

做这套字踩过两个必踩的坑，都是「看起来像字体坏了」而不是「少了个字」：

| 坑 | 现象 | 原因 |
|---|---|---|
| 半角字形整批丢失 | 输入框里英文数字比中文宽一倍、字距忽宽忽窄 | unifont 的 hex 里半角行是 **32 个十六进制字符**（8 列），全角才是 64。只认 64 等于丢掉 12582 个字形，英文全部 fallback 到系统无衬线 |
| 中文逗号变问号 | 书页里每个「，」都是 `?` | 中文输入法打的是 **U+FF0C**（全角区），只抽 U+3000–303F 收不到 |

还有一处不是 bug 但决定观感：汉字点阵是 16×16，GUI 里只占 8×8，缩小必须走**双线性**。用 nearest 等于每 2 行抽 1 行，笔画之间的半像素空隙被吃掉，整字粘成实心黑块；双线性给出四级灰阶，笔画细了、字与字重新分得开。方块纹理绝不能开插值，所以这一处是临时开、画完立刻关。

### 现代化 UI 参照的是哪个 mod

不是「圆角 + 阴影 + 描边」这种凭感觉的三件套，是照 [Modern UI](https://modrinth.com/mod/modern-ui)（BloCamLimb）Action Center 里真实的配置项排的：

| 参数 | 对应 mod 里的项 | 为什么是这个默认值 |
|---|---|---|
| `tipRadius` | 工具提示圆角半径 | 0 = 原版直角 |
| `tipShadowRadius` / `tipShadowAlpha` | 阴影半径 + 阴影强度（两个轴） | 0 = 无阴影；档位只在这两个数上取 4 个点 |
| `tipBorder` | 圆角平滑边框 / 原版九宫格边框 | `vanilla` |
| `tipTitleRule` | 标题分隔线 | 关 |
| `tipCenterTitle` | 标题行居中 | 关 |
| `tipOpacity` | 背景不透明度（3.8.0.3 新增） | 100%（= 原版） |
| `panelRadius` / `panelShadow` | —（这个 mod 不动物品栏底板） | 0 / 关 |

`enabled` 是总开关，对应「这个 mod 装没装」：关掉时整套参数原样保留、渲染退回原版，重新打开还是上次那一套。MUI 的配置本来就是写进 config 的，禁用后不清空；没有这一层，用户想看一眼原版长什么样，就得把七项逐一调回原版值再逐一调回去。

拨到「开」时如果参数还全是原版值，会先套一层 `MODERN_DEFAULT`（圆角 8 / 中档阴影 / 圆角边框 / 分隔线 / 标题居中 / 86% 底板，面板仍保持直角）。原版模组装上就立刻生效；开关打开却什么都没变，第一反应会是「这开关坏了」。

两个必须记住的结论：

- **主战场是 tooltip，不是容器面板。** 那个 mod 改的是提示框；物品栏底板它基本不动，它动的是「屏幕背景」（模糊、渐变、淡入）。把圆角投影挂在 `.mc-panel` 上，方向就是错的。
- **参数必须是数值不能是布尔。** 阴影是「半径 × 强度」两个连续轴，布尔只能表达有/没有。档位 UI 只是在数值上取几个离散点，导出侧拿到的仍是数值。

实现上有三处不是「照抄」而是必须自己解决的：

| 坑 | 现象 | 原因 |
|---|---|---|
| 圆角看起来没生效 | 参数、clip 路径、`drawImage` 坐标全对，底板四角依然是直角 | `tooltip/background` 这张图四边各有 9px **透明内缩**（边框由 `tooltip/frame` 单独提供），裁圆角只裁到那块透明边。圆角必须自绘一块圆角矩形填色，颜色从贴图中心采样 |
| 圆角被阴影糊成直角 | 圆角设了 8，看起来还是方的 | 阴影的同心层最内层只外扩 1px，把圆弧缺口填上了黑。挖洞要用**直角**矩形（even-odd），不能用带 radius 的 |
| 导出缺一块 | 屏幕上完整，导出的 PNG 里提示框右边被切掉 | 提示框从格子往右下摊开，容器贴边时必然伸出去。画布尺寸要把提示框的 bbox 并进去，必要时整体平移所有图层 |

边框色和底板色都是运行时从 `tooltip/frame`、`tooltip/background` **采样**的，不是写死的常量——这两张图随版本换过配色，写死的值在换版本之后就成了「自己发明的一种紫」。

屏幕（`McTooltip`，一块 canvas）和导出（`exportLayers`，分层 canvas）共用同一个 `drawTooltip` 和同一份 `tipStyleOf` 映射。任何一侧单独实现一次字段，都会出现「画布上是圆角、导出后是直角」。

### 地图是一张 128×128 的位图，但纸不是方的

原版地图不是「底图 + 几个图钉」，地形、建筑、标记全画在同一张 128×128 的像素图上，每格是 `MapColor` 的一个下标。所以这里也给它一块真画板（`lib/useMapPaint.ts`）：

| 决定 | 理由 |
|---|---|
| 色板取 14 组基色 × 4 档明暗 = 56 色 | 原版是 44 基色 × 4 = 236 项，找「浅一点的草绿」要滑半天 |
| 像素循环查预计算 RGB 表 | 16384 个像素每次拖动都解析 `#rrggbb` 字符串，帧率掉到个位数 |
| 落笔用 rAF 合并提交 | `pointermove` 高刷屏一秒 240 次，每次 setState 会让笔尖明显拖在手指后面 |
| 两点之间补 Bresenham | 不补就是一串断点，画斜线像虚线 |
| 撤销存整张快照（16KB × 40 步） | 差分要记「被覆盖的旧值」，两笔相交时回退顺序会错 |
| 悬停格高亮直接写 DOM style | 跟手的东西不能过 React，否则每帧重渲染整棵树 |

导出走同一条 `draw()`，预览用什么倍率、导出用什么倍率只差一个参数——以前模型页预览和导出各写一遍构图，导出的图总比屏幕上偏一点。

`map_background.png` 的边缘是「手撕纸」：64×64 里最外一圈的 alpha 时有时无，本意是在 16×16 的物品图标里做一点毛边。放到 128 的界面再整数放大 6 倍，那圈 1 texel 的缺口就变成 12 像素的锯齿洞——上边缘像被撕掉一条、角上是直角缺牙、描边一处宽一处窄。

所以地图界面**只取这张贴图的用色**：统计整张图里出现最多的颜色当纸面、第二多的当纸边，形状按规则矩形重建，纸边最后压在地图内容之上（内容铺满 128×128，靠最后一层把边盖回来）。配色仍然来自素材，形状不再跟着撕边抖动——换资源包换掉这张图，边框颜色会跟着变。

### 立体字参照的是哪个项目

形态照 [Cube 3D Text](https://github.com/EaseCation/cube-3d-text)（EaseCation，MIT）——同一件事的 React + three.js 实现。它的做法是：**取字形轮廓 → 三角化 → 挤出 → 沿轮廓外扩一圈薄壳当描边**，不是「一个像素长一个方块」。

| 决定 | 理由 |
|---|---|
| 轮廓挤出，不逐像素堆方块 | 逐方块堆，相邻方块之间留缝、描边围着每个方块长，「日」中间那道缝会被吃掉一半，放大就是一排积木 |
| 描边是位图差分的环带 | 「外轮廓 + 把每个笔画的外环塞进 holes」在 earcut 上不成立：十几个互不相邻的笔画会让孔洞消除丢掉一部分，那块区域整片填成描边色，字面上到处是黑斑 |
| 字内孔不描边 | 膨胀是各向同性的，两三格宽的小孔会被四边糊死，孔里变成一块描边色——白色字面上就是一个个红斑 |
| 厚度/描边按字号的百分比 | 参考项目里这两个参数也是相对 size 的。按格数写死，换成 56px 字号，4 格厚度就从「厚板」变成「一张纸」 |
| 轮廓做 Douglas–Peucker | 台阶折线按容差拟合成斜线，形状误差不超过一格，三角形数降一半；容差过 0.4 格会抹平汉字窄缝，轮廓自交、面缺一块 |
| 描边整体比主体低半格 | 环带内壁和主体外壁在 xy 上完全重合，同高度就共面闪烁 |
| 深色底改中灰 | 预览台背景换成中灰，白色字和黑描边同时能看清；纯黑底上黑描边直接融进背景 |
| 预览台高度显式设置 | `max-height: 100%` 夹不住 `width: auto` 的 canvas，1024×530 的方盒子会把舞台撑破，位图居中缩在框里，上下被裁——「字的下半截没了」就是这个 |

导出仍然是透明底 PNG：屏幕上垫的那层灰只属于预览，素材要能叠在用户自己的画面上。

### 字形表要覆盖 CJK

`scripts/extract-font-zh.py --full` 会把 CJK 统一表意文字（U+4E00–U+9FFF）与中日韩标点一起抽出来：告示牌、书页要能写任意中文，只抽语言文件里那几百个字的话，用户敲进去的第三句话就是一排问号。产物 2MB（gzip 后约 500KB），随仓库提交，CI 不重建。

### 结构也能导出

结构页的格式清单和模型页共用一张注册表（`lib/export/registry.ts`）：`GLB` / `glTF` / `OBJ` / `STL` / `单帧 PNG`。几何从 GPU 的顶点缓冲里还原（`lib/export/structure.ts`）：

| 步骤 | 注意点 |
|---|---|
| 解包顶点 | `BLOCK_LAYOUT` 步长 32：位置 f32×3、颜色 u8×4、UV f32×2 |
| 补法线 | 方块顶点没有法线（六档亮度烘焙在顶点色里），按三角形叉积现算，否则导进 Blender 是一坨平面 |
| 原点 | 底面贴 `y=0`、XZ 居中，与模型导出同规则 |
| 文件名 | 结构 id 是 `village/plains/houses/...`，写进 OBJ 的 `mtllib` 会让 Blender 去找一个不存在的子目录，材质静默丢失 |

静帧不复用屏幕 canvas：那是按窗口尺寸分配的，720p 窗口里截出来只有 700 多像素。按页面选的 `512/768/1024/2048` 重新跑一遍渲染。

### 转台交互

`lib/orbit.ts` 是唯一维护角度的状态机，预览与导出都从它取值：

| 做法 | 为什么 |
|---|---|
| 拖动期间角度 1:1 跟随，不做低通 | 40ms 平滑会让模型在手指停下后还在追，手感像被橡皮筋拖着 |
| 惯性按「度/秒」积分，`exp(-dt/τ)` 衰减 | 逐帧乘 0.9 在 60Hz 与 144Hz 上是两种手感，同一页面在两台机器上滑行距离差一倍 |
| 松手速度取最近 120ms 的窗口平均 | 逐帧差分会把「松手前最后一帧零位移」当成静止，甩出去的余韵全丢 |
| 拖动/滑行期间拒绝外部回灌的角度 | 上报是节流的，父组件的 view 滞后几十毫秒；不挡住会被误判成「跳到旧角度」，拖到一半被打断 |
| 枢轴 = 整个动画周期的包围盒并集中心 | 只量站立姿势时中心在腰，抬臂迈腿之后偏到另一侧，转起来会「甩偏」 |
| 取景以枢轴为画面中心（`frameAroundPivot`），带 `display.translation` 时补位移 | 用包围盒中心取景，非对称模型（楼梯、门、旗帜）会绕屏幕外的点转 |
| 水平角上报前归一化到 -180..180，回灌走 `nearestYaw` | 连续拖动会累加到 720°，滑块只有 -180..180；不归一化滑块顶在端点不动，不取最近同余角又会倒转一大圈 |
| 导出复用同一套取景与枢轴 | 预览调好的构图必须等于导出视频的构图 |

触摸端：`touch-action: none`，双指捏合缩放，双击复位机位。

两处**故意不做**，理由写在这里以免被当成漏做：

- **环境光遮蔽（AO）**。原版 `BlockModelLighter` 的顶点亮度是 `(该点光照 × 权重 + 三个邻居的光照) × 0.25`，它依赖世界里真实的光照传播。站点没有世界光照（统一按满亮），硬造一个遮蔽系数就只是"加了脏阴影"，不再对应任何原版算法，所以宁可不出这个效果。
- **Sodium 那套区块网格与顶点压缩**。它解决的是"视距 32 区块、每帧重建脏区块"，而这里最复杂的场景是一次性渲染 1.5 万个方块的静态结构，用不上，也就没有照抄。

### 动效参考了什么

界面的动画不是随手加的 `transition: all .2s`，两个参照物：

- **EaseGUI 那类 GUI 缓动 mod**：元素出现/切换时先冲过目标再回弹。CSS 里用 `linear()` 写多段回弹（`--spring`），因为 `cubic-bezier` 表达不了过冲。只用在短位移和小尺寸缩放上——大面积元素 over-scroll 到 1.05 会晃眼
- **钠（Sodium）那类渲染 mod**：先解决「整数倍缩放」。非整数倍会让浏览器用双线性插值补半像素，1px 边框糊成 2px 灰线。所以预览倍率是**算出来的整数**（`floor(min(可用宽/界面宽, 可用高/界面高))`），不是按界面种类写死，CSS 的 `max-width` 只作兜底

`prefers-reduced-motion: reduce` 下全部关掉。

### 放大之后为什么还是锐的

屏幕上的像素没有"矢量"这回事——最终都要落到物理像素上。所谓锐，只有一条：**每次显示都按当前物理分辨率重新光栅化**，而不是把一张小位图拉大。几何和贴图在这件事上是分开处理的：

| 部分 | 做法 | 放大后的表现 |
|---|---|---|
| 立方体的边 | GPU 走三角形光栅化 + MSAA；CPU 走 2.6 倍超采样再缩回 | 直边、斜边都保持平滑，不会变成阶梯 |
| 表面贴图 | 纹理采样 `NEAREST`（GPU）/ 逐 texel 取样（CPU） | 仍是一个个方块，不产生过渡色 |
| 画布分辨率 | `lib/dpr.ts`：CSS 尺寸 × 真实 `devicePixelRatio` | 缩放后自动重建，不再被浏览器拉伸 |

`devicePixelRatio` 上限 3：缩略图 76px 用满 3 倍（228px），详情页压在 2.5 倍并按**面积**封顶 260 万像素——详情页的画布铺满整块棋盘格，边长随窗口走，只按倍数封顶的话 430×850 在 3 倍屏上是 360 万像素，软件光栅化一帧要几百毫秒。

### 画布为什么是矩形

详情页的棋盘格是整块矩形面板，而画布曾经固定成「短边减 24 的正方形」摆在中间。后果不是布局问题而是画面问题：**那块正方形的边就是硬裁剪边**，放大看细节时模型在方框里被切断，框外还露着一圈棋盘格，看起来像被裁进一张纸里。

现在画布 `position: absolute; inset: 0` 铺满面板，裁剪边与棋盘格边重合，放大到哪一层都只会在面板边缘断开。两条渲染路径为此分开算宽高：

| 层 | 规则 |
|---|---|
| 取景比例 | CPU `pixelScale(短边)`、GPU `span / (短边 × fraction)`，同一口径，换后端模型大小不跳 |
| 落点 | CPU 用 `width/2`、`height/2`；GPU 正交框分 `halfW / halfH` |
| 离屏缓冲 | 图层、描边、拖尾全部按宽高分配，原先都是正方形 |
| 像素预算 | 按面积封顶，等比降分辨率，不单边裁 |

缩略图仍是正方形（`height` 不传即等于 `size`），所以列表的缓存键不受影响。

浏览器缩放（Ctrl +/-）不触发 `resize`，也不让 React 重渲染，所以 `lib/dpr.ts` 用 `matchMedia('(resolution: Xdppx)')` 盯着当前浓度，一变就重建画布。

一处**已知缺口**，结构页会当场报出来：

- **方块实体（箱子、告示牌、床、头颅、装饰罐）不进结构预览**。它们在资源包里没有 `elements`，模型由 `ChestRenderer` 之类的渲染器在运行时拼出来。结构页底部的状态行会写明"这几类方块实体的模型在渲染器里，未参与预览"，而不是静默少一件家具。要补的话得把 `entitymodels.json` 的盒体转成体素几何，属于另一条流水线，这一版没做。

## 为什么仓库里没有素材

```
mc-assets/26.3
├── sounds/    359 MB   4961 个音效
├── lang/       87 MB   144 种语言
├── index.json  2.2 MB  素材索引
└── ...                 合计约 460 MB / 17269 文件
```

这 460MB **全部可以重建**：`fetch-assets.mjs` 从 `piston-meta.mojang.com` 拿版本清单，下载 `client.jar` 与 asset index，按 hash 拉取对象，解包后现场生成 `index.json`、`textures.json`、`blockmaps.json`、`registries.json`。所以它们不需要进 git，进了只会让 clone 变成几十分钟。

真正无法重建的只有 7 个文件，它们来自**反编译源码**，官方 jar 里根本没有：

| 文件 | 提取自 |
|---|---|
| `entitymodels.json` | 各 `*Model` 类体里的 `ModelPart` 构建调用 |
| `entityanims.json` | `setupAnim` 方法体（行走摆动、头部朝向、坐下） |
| `entityrenderers.json` | `EntityRenderers.register` 全表 |
| `entitylayers.json` | 渲染器继承链上的 `addLayer` 调用 |
| `particledata.json` | `ParticleResources` 注册表与各粒子类 |
| `creativetabs.json` | `CreativeModeTabs` 的物品顺序 |
| `sounds.json` | 由素材侧 `sounds.json` + 官方字幕键增强出中文名 |

这些放在 `mc-derived/`，Vite 插件在 `/mc` 上按「先 derived、再 assets」两级查找，所以前端只认一个 URL，不关心文件在哪一层。

## 列表是边滚边取的

方块和物品的面数据合起来 2.2MB。整包下发意味着手机上要先解析完一兆多 JSON 才能画出第一个格子，所以烘焙时按 id 排序切成每片 200 条，落在 `mc/<版本>/baked/`。列表页先拿 meta（纹理池 + id 清单 + `display`、约 250KB），滚动到哪一片就取哪一片，翻回来命中缓存；点开一张还没到位的卡片时也会单独补一次。

计算出来的 `grid-template-columns` 直接参与虚拟滚动的列数，所以手机断点换成四列之后，行的估算高度不会跟着漂——这类「两边算法各算各的」是滚动列表最容易出现的错位来源。

### 缓存键必须带几何身份

三处缓存，任何一处键里只剩「贴图名」就会让不同模型互相命中：

| 缓存 | 键 | 少了身份会怎样 |
|---|---|---|
| `ModelView` 的 `thumbCache` | 几何指纹 + 贴图名 + 像素 + 角度 + 光照 + 缩放 | 木板、台阶、楼梯、栅栏、栅栏门、按钮、压力板的贴图都是 `block/acacia_planks`，键完全相同，余下全部被画成第一块的形状 |
| `pipeline` 的 `meshFor` | 调用方给的 `gpuKey`；方块是「几何指纹 + 贴图名（+ 动画帧号）」 | 命中后直接复用顶点缓冲，不再比对 `faces`，同贴图不同形状会共用网格 |
| `pipeline` 的 `TextureCache` | 纹理 id | 这一处本来就对：纹理 id 就是内容本身 |

几何指纹取顶点坐标的哈希，**不是**方块 id：详情页换 blockstate 时 id 不变、`faces` 会变，按 id 建键会把旧形状钉死在缓存里。

## 命令

```bash
pnpm run setup          # 下载素材（含音效）
pnpm run setup:lite     # 下载素材（跳过音效）
pnpm run assets stats   # 看体积构成，解释为什么不能入库
pnpm run assets verify  # 对照 lock 校验派生数据没有被改动
pnpm run assets lock    # 重新提取后刷新 mc-assets.lock.json
pnpm run build          # tsc -b && vite build，产物是单文件 dist/index.html
pnpm start              # 生产预览，素材由同一进程提供
```

`pnpm dev` / `pnpm build` 之前会自动跑一次 `assets ensure`：素材没就绪时给出明确的补齐命令，而不是让你对着白屏猜。CI 只想构建前端时设 `MC_SKIP_ASSETS=1`。

## 更新到新游戏版本

素材侧一条命令，派生侧需要反编译源码：

```bash
# 1. 拉新版本的官方素材（版本号不带 v）
node scripts/fetch-assets.mjs 26.3

# 2. 用 Vineflower 反编译 client.jar，产出 /tmp/modelsrc 与 /tmp/rendsrc
#    然后重跑提取脚本（默认输出到 mc-derived/<版本>/）
python3 scripts/extract-entities.py /tmp/modelsrc/net/minecraft/client/model
python3 scripts/extract-anim.py     /tmp/modelsrc/net/minecraft/client/model
python3 scripts/extract-renderers.py
python3 scripts/extract-layers.py
# 创造栏这一支不用反编译产物：它直接读 jar 里的字节码（javap），
# 因为注册顺序只在 getstatic 的出现顺序里，源码排版会骗人
python3 scripts/extract-tabs.py /tmp/client-26.3.jar
python3 scripts/extract-particles.py
python3 scripts/extract-sound-names.py

# 3. 刷新锁文件
pnpm run assets lock
```

提取脚本读的是 Java 源码，所以第 2 步是唯一无法自动化的环节——这也是那 7 个 JSON 必须入库的原因。

## 部署到 GitHub Pages

仓库自带 `.github/workflows/pages.yml`，push 到 `main` 就自动构建并发布。首次需要在 **Settings → Pages → Source** 选 **GitHub Actions**。

流程里有三个针对 Pages 的处理：

| 问题 | 处理 |
|---|---|
| 站点挂在 `/<repo>/` 子路径下 | 构建时注入 `VITE_BASE`，路由 basename 与素材地址都带前缀 |
| 深链接没有 rewrite，回 404 | 构建产出 `404.html`（内容同 `index.html`），Pages 会把未知路径交回 SPA |
| 素材 460MB，站点上限 1GB | CI 里裁成 `--no-sounds --lang=zh_cn,en_us`，约 7MB |

> **限制**：GitHub Pages 的免费账号只允许**公开仓库**使用 Pages。私有仓库要发布 Pages 需要 Pro。如果你的仓库还是私有的，先转公开，或改为部署到自己的服务器（见下）。

本地预览 Pages 效果（子路径 + 404 回退都能验证）：

```bash
pnpm run pages:build      # 按 /<当前目录名>/ 前缀构建，产物在 dist-site/
cd dist-site && python3 -m http.server 8080
# 打开 http://localhost:8080/<目录名>/
```

素材想改用外部 CDN（比如对象存储）而不跟站点一起发时，构建时设 `VITE_ASSET_BASE=https://cdn.example.com/mc`，前端所有素材请求会走它，`VITE_BASE` 只管站点路由。

## 导出

详情页可以把当前模型导出为 MP4 / GIF / WebP / APNG / PNG 序列 / glTF / GLB / OBJ / ZIP。帧序列与 glTF 都在主线程算，导出大尺寸时页面会短暂卡住，属预期。

## 版权

代码是本项目的。**素材不是**：纹理、音效、模型、语言文件的版权归 Mojang / Microsoft 所有，由 `fetch-assets.mjs` 在使用者自己的机器上从官方端点下载，不随本仓库分发。详见 [NOTICE.md](./NOTICE.md)。
