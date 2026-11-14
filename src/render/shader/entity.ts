/**
 * 实体着色器（等价 `assets/minecraft/shaders/core/entity.vsh|fsh`）。
 *
 * @why 保留了 `PER_FACE_LIGHTING`：原版用它把正面和背面的光照分开算，
 *      `gl_FrontFacing` 选其中一个。没有这一步，盒子内壁（比如帽子内侧、
 *      披风背面）会和外侧一样亮，模型看起来是"实心的"，没有厚度感。
 *
 * @constraint 方向光必须在**顶点**阶段算完并写进 varying。放到片元里算
 *      等价，但实体每帧几十万个顶点，逐顶点算远比逐像素算便宜，
 *      而且原版就是这么做的——对齐原版也意味着将来接别的
 *      `Light0_Direction`（下界、物品栏）时行为一致。
 *
 * @constraint `ColorModulator` 必须乘上去。它承载「染色」「受伤闪红」
 *      「旁观者半透明」这些状态，漏掉会让染色羊变回白羊。
 */
export const ENTITY_VSH = /* glsl */ `#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:light.glsl>
#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <minecraft:projection.glsl>
#include <minecraft:sample_lightmap.glsl>

layout(location = 0) in vec3 Position;
layout(location = 1) in vec4 Color;
layout(location = 2) in vec2 UV0;
layout(location = 3) in vec2 UV1;
layout(location = 4) in vec2 UV2;
layout(location = 5) in vec3 Normal;

uniform sampler2D Sampler1;
uniform sampler2D Sampler2;

layout(location = 0) out float sphericalVertexDistance;
layout(location = 1) out float cylindricalVertexDistance;
#ifdef PER_FACE_LIGHTING
layout(location = 2) out vec4 vertexPerFaceColorBack;
layout(location = 3) out vec4 vertexPerFaceColorFront;
#else
layout(location = 2) out vec4 vertexColor;
#endif
#ifndef EMISSIVE
layout(location = 4) out vec4 lightMapColor;
#endif
layout(location = 5) out vec4 overlayColor;
layout(location = 6) out vec2 texCoord0;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position + ModelOffset, 1.0);

    sphericalVertexDistance = fog_spherical_distance(Position);
    cylindricalVertexDistance = fog_cylindrical_distance(Position);

#ifdef PER_FACE_LIGHTING
    vec2 light = minecraft_compute_light(Light0_Direction, Light1_Direction, Normal);
    vertexPerFaceColorBack = minecraft_mix_light_separate(-light, Color);
    vertexPerFaceColorFront = minecraft_mix_light_separate(light, Color);
#else
    vertexColor = minecraft_mix_light(Light0_Direction, Light1_Direction, Normal, Color);
#endif

#ifndef EMISSIVE
    lightMapColor = sample_lightmap(Sampler2, UV2);
#endif
    overlayColor = texture(Sampler1, UV1);
    texCoord0 = UV0;
}
`

export const ENTITY_FSH = /* glsl */ `#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>

uniform sampler2D Sampler0;

layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in float cylindricalVertexDistance;
#ifdef PER_FACE_LIGHTING
layout(location = 2) in vec4 vertexPerFaceColorBack;
layout(location = 3) in vec4 vertexPerFaceColorFront;
#else
layout(location = 2) in vec4 vertexColor;
#endif
#ifndef EMISSIVE
layout(location = 4) in vec4 lightMapColor;
#endif
layout(location = 5) in vec4 overlayColor;
layout(location = 6) in vec2 texCoord0;

layout(location = 0) out vec4 fragColor;

void main() {
    vec4 color = texture(Sampler0, texCoord0);

#ifdef ALPHA_CUTOUT
    if (color.a < ALPHA_CUTOUT) {
        discard;
    }
#endif

#ifdef PER_FACE_LIGHTING
    vec4 faceVertexColor = gl_FrontFacing ? vertexPerFaceColorFront : vertexPerFaceColorBack;
#else
    vec4 faceVertexColor = vertexColor;
#endif

    color *= faceVertexColor * ColorModulator;

    // 受伤闪红：原版用 overlay 颜色的 alpha 做混合通道
    color.rgb = mix(overlayColor.rgb, color.rgb, overlayColor.a);

#ifndef EMISSIVE
    color *= lightMapColor;
#endif

    fragColor = apply_fog(color, sphericalVertexDistance, cylindricalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogColor);
}
`
