# 版权与素材来源

## 代码

本仓库的代码（`src/`、`scripts/`、`vite.*.ts`）为本项目原创。

## 素材

`mc-assets/` 下的全部内容**不属于本仓库，也不随本仓库分发**，包括但不限于：

- 纹理（`textures/`）
- 音效（`sounds/`）
- 模型与方块状态（`models/`、`blockstates/`、`items/`）
- 语言文件（`lang/`）
- 着色器、字体、图集

这些内容的版权归 **Mojang Studios / Microsoft** 所有，受 Minecraft 最终用户许可协议（EULA）与商业使用指南约束。本项目仅通过 `scripts/fetch-assets.mjs` 在**使用者自己的机器上**从 Mojang 公开端点下载这些文件，仓库中不含任何素材二进制。

```
https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
https://resources.download.minecraft.net/<hash>
```

因此：

- 自建、自用、学习研究没有问题。
- 若要公开部署成站点，请注意 EULA 对「分发游戏素材」的限制，自行承担合规责任；稳妥做法是只部署代码，把素材加载交给访问者本地的游戏安装。
- 不要把这些素材重新打包分发，也不要用作商业产品的素材来源。

## 派生数据

`mc-derived/` 下的 7 个 JSON 是从反编译得到的 Java 源码中提取的**结构化描述**（模型骨架、UV 坐标、动画参数、注册表 id），不含图像或音频数据。它们描述的是接口与数值关系，随仓库分发。

提取脚本 `scripts/extract-*.py` 需要使用者自行反编译 `client.jar`。仓库不提供、也不分发反编译产物。
