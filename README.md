# MC 素材库

**[dingdingovo.github.io/mc-asset-library](https://dingdingovo.github.io/mc-asset-library/)** — 直接打开就能用，不需要本地跑。

在浏览器里翻阅 Minecraft 的全部素材：方块、物品、生物模型、粒子、界面图、音效。

三件事和常见的「贴图预览站」不一样：

- **立体模型是软件光栅化算出来的**。没有 three.js，没有 WebGL 上下文，只有 `raster.ts` 里一个带 z-buffer 的三角形光栅器 + 超采样。所以每张方块图标、每个生物渲染都能逐像素控制，也能离线导出。
- **生物模型不是猜的**。几何、UV、动画、渲染图层全部由 `scripts/extract-*.py` 从反编译的 Java 源码里提取，字段与 `ModelPart$Cube`、`setupAnim`、`addLayer` 一一对应。263 个烘焙模型全部有贴图，`for` 循环里建的部件（烈焰人的十二根棒子、末影龙的脖子）、静态数组常量（蠹虫的分段尺寸）、返回数值的静态方法（守护者的十二根尖刺）都按源码求值，不靠猜。
- **状态能选**。品种、花纹、染色、职业都是下拉框：猫 11 种毛色、狼 27 张、马 7 色 × 5 花纹、村民 7 生态型 × 15 职业（僵尸村民同样）。
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

## 目录

| 路径 | 说明 | 入库 |
|---|---|---|
| `src/lib/raster.ts` | 软件光栅器：三角形填充、z-buffer、半透明 over 合成 | ✅ |
| `src/lib/scene.ts` | 正交投影、光照、描边、画布合成 | ✅ |
| `src/lib/blockmodels.ts` | 方块模型 JSON → 面片，含 `elements`/`rotation`/`uvlock` | ✅ |
| `src/lib/entityRig.ts` | `ModelPart` 树 → 面片，逐盒 UV 展开 | ✅ |
| `src/lib/anim.ts` | `setupAnim` 的 JS 侧复刻：行走、坐、幼年、头部朝向 | ✅ |
| `mc-derived/26.3/*.json` | **从反编译源码提取、官方 jar 里没有的派生数据** | ✅ 1.3MB |
| `mc-assets/26.3/**` | 官方纹理、音效、模型、语言文件 | ❌ 由 `setup` 重建 |
| `scripts/fetch-assets.mjs` | 素材管线：piston-meta → client.jar → 解包 + 建索引 | ✅ |
| `scripts/assets.mjs` | 素材管线的统一入口（sync/ensure/verify/lock/stats） | ✅ |

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
python3 scripts/extract-tabs.py /tmp/tabs.java
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
