/**
 * 地形着色器（等价 `assets/minecraft/shaders/core/terrain.vsh|fsh`）。
 *
 * @why 逐行照搬原版，只去掉三个我们用不到的编译分支：
 *      `MULTIDRAW_TERRAIN`（一次绘制多个区块，需要 multidraw 扩展）、
 *      `OIT_*`（顺序无关透明，需要多张浮点缓冲，成本高且观感差异极小）、
 *      `FADE_IN`（区块异步加载时的淡入）。
 *
 * @constraint 顶点色已经是最终亮度，片元里**不能再乘方向光**。
 *      方块的方向亮度（上下南北西东 = 1.0 / 0.5 / 0.8 / 0.6）是在
 *      网格烘焙阶段按 `CardinalLighting.DEFAULT` 算进 Color 里的；
 *      片元再乘一次会变成平方，画面整体暗一档。
 */

export const TERRAIN_VSH = /* glsl */ `#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:globals.glsl>
#include <minecraft:projection.glsl>
#include <minecraft:sample_lightmap.glsl>
#include <minecraft:chunksection.glsl>
#include <minecraft:terrainglobals.glsl>

layout(location = 0) in vec3 Position;
layout(location = 1) in vec4 Color;
layout(location = 2) in vec2 UV0;
layout(location = 3) in vec2 UV2;

uniform sampler2D Sampler2;

layout(location = 0) out float sphericalVertexDistance;
layout(location = 1) out float cylindricalVertexDistance;
layout(location = 2) out vec4 vertexColor;
layout(location = 3) out vec2 texCoord0;
layout(location = 4) out float chunkVisibility;

void main() {
    // 原版把区块坐标与相机区块坐标相减，让传入的顶点坐标始终是
    // 「区块内相对坐标」（0..16）。float32 在世界坐标几千格之外时，
    // 一个格子的精度只剩 0.0005，顶点会开始抖动；相对坐标把量级压到
    // 16 以内，精度足够。建筑结构铺开几百格就会碰到这个坎。
    vec3 pos = Position + vec3(ChunkPosition - CameraBlockPos) + CameraOffset;
    gl_Position = ProjMat * ModelViewMat * vec4(pos, 1.0);

    sphericalVertexDistance = fog_spherical_distance(pos);
    cylindricalVertexDistance = fog_cylindrical_distance(pos);

    vertexColor = Color * sample_lightmap(Sampler2, UV2);
    texCoord0 = UV0;

    // 区块淡入：离得近的区块恒为 1，远处按 ChunkVisibility 混合。
    // 视距边缘的区块突然出现会很明显，这一段就是原版用来消除它的。
    const float chunkFullyVisibleRange = 16.0;
    float dist = length(pos);
    chunkVisibility = mix(1.0, ChunkVisibility, clamp((dist - chunkFullyVisibleRange) / chunkFullyVisibleRange, 0.0, 1.0));
}
`

export const TERRAIN_FSH = /* glsl */ `#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:globals.glsl>
#include <minecraft:texture_sampling.glsl>
#include <minecraft:terrainglobals.glsl>

uniform sampler2D Sampler0;

layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in float cylindricalVertexDistance;
layout(location = 2) in vec4 vertexColor;
layout(location = 3) in vec2 texCoord0;
layout(location = 4) in float chunkVisibility;

layout(location = 0) out vec4 fragColor;

void main() {
    // UseRgss==1 时走旋转网格超采样：远处的方块墙会变得安静、不再闪。
    // 近处 RGSS 会自动退回点采样（代码里 smoothstep 的过渡带），
    // 所以放大看单个方块时仍是硬边像素风。
    vec4 color = (UseRgss == 1 ? sampleRGSS(Sampler0, texCoord0, 1.0 / vec2(TextureSize)) : sampleNearest(Sampler0, texCoord0, 1.0 / vec2(TextureSize))) * vertexColor;

    color = mix(FogColor * vec4(1, 1, 1, color.a), color, chunkVisibility);

#ifdef ALPHA_CUTOUT
    if (color.a < ALPHA_CUTOUT) {
        discard;
    }
#endif

    fragColor = apply_fog(color, sphericalVertexDistance, cylindricalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogColor);
}
`
