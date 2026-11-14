/**
 * 原版着色器 include 库的移植层。
 *
 * @why 这些文件是从 client jar 的 `assets/minecraft/shaders/include/*.glsl`
 *      逐行搬过来的，只做 GLSL ES 3.00 的语法适配（`#version 300 es`、
 *      `layout(binding=)` 之类），公式一个字符都没改。
 *      自己重写一份"差不多"的光照公式是之前颜色对不上的根源：
 *      原版的六面亮度是 1.0 / 0.8 / 0.6 / 0.5，之前那份被"整体提亮过一档"
 *      成了 1 / 0.88 / 0.76 / 0.66，于是所有方块都偏灰。
 *
 * @constraint 源文件里的 `#include <minecraft:xxx.glsl>` 和注释掉的
 *      `#moj_import` 由 `expand()` 展开，顺序必须和原版一致：先 include
 *      后声明，因为 include 里定义了 uniform block。
 */

/** 与 jar 内 `shaders/include/` 一一对应 */
export const INCLUDE: Record<string, string> = {
  // ---------------------------------------------------------------- globals
  'globals.glsl': /* glsl */ `
layout(std140) uniform Globals {
    ivec3 CameraBlockPos;
    float GlintAlpha;
    vec3 CameraOffset;
    float GameTime;
    vec2 ScreenSize;
    int MenuBlurRadius;
    int UseRgss;
};
`,

  'terrainglobals.glsl': /* glsl */ `
layout(std140) uniform TerrainUniform {
    mat4 ModelViewMat;
    ivec2 TextureSize;
};
`,

  'chunksection.glsl': /* glsl */ `
layout(std140) uniform ChunkSection {
    ivec3 ChunkPosition;
    float ChunkVisibility;
};
`,

  'dynamictransforms.glsl': /* glsl */ `
layout(std140) uniform DynamicTransforms {
    mat4 ModelViewMat;
    mat4 TextureMat;
    vec4 ColorModulator;
    vec3 ModelOffset;
};
`,

  'projection.glsl': /* glsl */ `
layout(std140) uniform Projection {
    mat4 ProjMat;
};

vec4 projection_from_position(vec4 position) {
    vec4 projection = position * 0.5;
    projection.xy = vec2(projection.x + projection.w, projection.y + projection.w);
    projection.zw = position.zw;
    return projection;
}
`,

  'matrix.glsl': /* glsl */ `
mat2 mat2_rotate_z(float radians) {
    return mat2(
        cos(radians), -sin(radians),
        sin(radians), cos(radians)
    );
}
`,

  // ------------------------------------------------------------------- light
  // 原版 light.glsl 原文。MINECRAFT_LIGHT_POWER / AMBIENT 这两个常数的取值
  // 决定了实体受光的整体亮度，改一个数字整个观感就变，所以不参数化。
  'light.glsl': /* glsl */ `
#define MINECRAFT_LIGHT_POWER   (0.6)
#define MINECRAFT_AMBIENT_LIGHT (0.4)

layout(std140) uniform Lighting {
    vec3 Light0_Direction;
    vec3 Light1_Direction;
};

vec2 minecraft_compute_light(vec3 lightDir0, vec3 lightDir1, vec3 normal) {
    return vec2(dot(lightDir0, normal), dot(lightDir1, normal));
}

vec4 minecraft_mix_light_separate(vec2 light, vec4 color) {
    vec2 lightValue = max(vec2(0.0), light);
    float lightAccum = min(1.0, (lightValue.x + lightValue.y) * MINECRAFT_LIGHT_POWER + MINECRAFT_AMBIENT_LIGHT);
    return vec4(color.rgb * lightAccum, color.a);
}

vec4 minecraft_mix_light(vec3 lightDir0, vec3 lightDir1, vec3 normal, vec4 color) {
    vec2 light = minecraft_compute_light(lightDir0, lightDir1, normal);
    return minecraft_mix_light_separate(light, color);
}
`,

  // 光照图采样。`+ 0.5/16` 是半像素对齐：光照图只有 16×16，采样点落在
  // texel 边界上时硬件会做双线性，把相邻两档亮度混成一个不存在的中间值。
  'sample_lightmap.glsl': /* glsl */ `
vec4 sample_lightmap(sampler2D lightMap, vec2 uv) {
    return texture(lightMap, clamp((uv / 256.0) + 0.5 / 16.0, vec2(0.5 / 16.0), vec2(15.5 / 16.0)));
}
`,

  // --------------------------------------------------------------------- fog
  'fog.glsl': /* glsl */ `
layout(std140) uniform Fog {
    vec4 FogColor;
    float FogEnvironmentalStart;
    float FogEnvironmentalEnd;
    float FogRenderDistanceStart;
    float FogRenderDistanceEnd;
    float FogSkyEnd;
    float FogCloudsEnd;
};

float linear_fog_value(float vertexDistance, float fogStart, float fogEnd) {
    if (vertexDistance <= fogStart) {
        return 0.0;
    } else if (vertexDistance >= fogEnd) {
        return 1.0;
    }
    return (vertexDistance - fogStart) / (fogEnd - fogStart);
}

float total_fog_value(float sphericalVertexDistance, float cylindricalVertexDistance, float environmentalStart, float environmantalEnd, float renderDistanceStart, float renderDistanceEnd) {
    return max(linear_fog_value(sphericalVertexDistance, environmentalStart, environmantalEnd), linear_fog_value(cylindricalVertexDistance, renderDistanceStart, renderDistanceEnd));
}

vec4 apply_fog(vec4 inColor, float sphericalVertexDistance, float cylindricalVertexDistance, float environmentalStart, float environmantalEnd, float renderDistanceStart, float renderDistanceEnd, vec4 fogColor) {
    float fogValue = total_fog_value(sphericalVertexDistance, cylindricalVertexDistance, environmentalStart, environmantalEnd, renderDistanceStart, renderDistanceEnd);
    return vec4(mix(inColor.rgb, fogColor.rgb, fogValue * fogColor.a), inColor.a);
}

float fog_spherical_distance(vec3 pos) {
    return length(pos);
}

float fog_cylindrical_distance(vec3 pos) {
    float distXZ = length(pos.xz);
    float distY = abs(pos.y);
    return max(distXZ, distY);
}
`,

  // --------------------------------------------------------- texture sampling
  // 这一段就是 Sodium 的 RGSS，26.3 已把它合进原版。删掉它换回纯
  // `texture()`，远处方块会重新出现闪烁的高频噪点——因为 mipmap 在
  // 点采样下没有过渡带。
  'texture_sampling.glsl': /* glsl */ `
vec4 sampleNearest(sampler2D source, vec2 uv, vec2 pixelSize, vec2 du, vec2 dv, vec2 texelScreenSize) {
    vec2 uvTexelCoords = uv / pixelSize;
    vec2 texelCenter = round(uvTexelCoords) - 0.5;
    vec2 texelOffset = uvTexelCoords - texelCenter;

    texelOffset = (texelOffset - 0.5) * pixelSize / texelScreenSize + 0.5;
    texelOffset = clamp(texelOffset, 0.0, 1.0);

    uv = (texelCenter + texelOffset) * pixelSize;
    return textureGrad(source, uv, du, dv);
}

vec4 sampleNearest(sampler2D source, vec2 uv, vec2 pixelSize) {
    vec2 du = dFdx(uv);
    vec2 dv = dFdy(uv);
    vec2 texelScreenSize = sqrt(du * du + dv * dv);
    return sampleNearest(source, uv, pixelSize, du, dv, texelScreenSize);
}

vec4 sampleRGSS(sampler2D source, vec2 uv, vec2 pixelSize) {
    vec2 du = dFdx(uv);
    vec2 dv = dFdy(uv);

    vec2 texelScreenSize = sqrt(du * du + dv * dv);
    float maxTexelSize = max(texelScreenSize.x, texelScreenSize.y);

    float minPixelSize = min(pixelSize.x, pixelSize.y);

    float transitionStart = minPixelSize * 1.0;
    float transitionEnd = minPixelSize * 2.0;
    float blendFactor = smoothstep(transitionStart, transitionEnd, maxTexelSize);

    float duLength = length(du);
    float dvLength = length(dv);
    float minDerivative = min(duLength, dvLength);
    float maxDerivative = max(duLength, dvLength);

    float effectiveDerivative = sqrt(minDerivative * maxDerivative);

    float mipLevelExact = max(0.0, log2(effectiveDerivative / minPixelSize));

    float mipLevelLow = floor(mipLevelExact);
    float mipLevelHigh = mipLevelLow + 1.0;
    float mipBlend = fract(mipLevelExact);

    const vec2 offsets[4] = vec2[](
        vec2(0.125, 0.375),
        vec2(-0.125, -0.375),
        vec2(0.375, -0.125),
        vec2(-0.375, 0.125)
    );

    vec4 rgssColorLow = vec4(0.0);
    vec4 rgssColorHigh = vec4(0.0);
    for (int i = 0; i < 4; ++i) {
        vec2 sampleUV = uv + offsets[i] * pixelSize;
        rgssColorLow += textureLod(source, sampleUV, mipLevelLow);
        rgssColorHigh += textureLod(source, sampleUV, mipLevelHigh);
    }
    rgssColorLow *= 0.25;
    rgssColorHigh *= 0.25;

    vec4 rgssColor = mix(rgssColorLow, rgssColorHigh, mipBlend);

    vec4 nearestColor = sampleNearest(source, uv, pixelSize, du, dv, texelScreenSize);

    return mix(nearestColor, rgssColor, blendFactor);
}
`,
}

/**
 * 把 std140 uniform block 摊平成普通 uniform。
 *
 * @why 原版用 UBO（`layout(std140) uniform Globals {...}`），那是为了
 *      一次 bindBufferBase 更新整帧参数。WebGL2 也支持 UBO，但每个块都要
 *      自己维护显存缓冲、算 std140 的 padding 规则，还要处理
 *      `minUniformBufferOffsetAlignment`——任何一处算错，读到的是全 0，
 *      表现为"整个场景纯黑"，而且 GL 不会报错。
 *
 *      摊平成普通 uniform 后，字段名和原版一字不差，移植对照表还对得上，
 *      设置成本只是几十次 uniform3f。等绘制调用真的成为瓶颈时再换回 UBO，
 *      换的时候只改这一个函数。
 *
 * @constraint 块内字段名必须全局唯一。原版做到了这一点（CameraBlockPos、
 *      FogColor、Light0_Direction 各不相同），唯一的例外是 ModelViewMat
 *      同时出现在 TerrainUniform 和 DynamicTransforms 里——但那两个块
 *      从不出现在同一个着色器中，摊平后不会撞名。
 */
export function flattenUniformBlocks(source: string): string {
  return source.replace(
    /layout\s*\(\s*std140\s*\)\s*uniform\s+\w+\s*\{([^}]*)\}\s*;/g,
    (_match, body: string) =>
      body
        .split(';')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `uniform ${line};`)
        .join('\n'),
  )
}

/**
 * 展开 `#include <minecraft:name.glsl>`。
 *
 * @constraint 重复 include 必须静默跳过。原版每个 include 文件都自带
 *      `#ifndef MINECRAFT_XXX_GLSL` 守卫，展开两遍会重复声明函数，
 *      GLSL 直接编译失败。这里用"已展开集合"达到同样的效果，
 *      比逐个文件抄守卫短得多，而且不会漏。
 *      顺带也天然防住环引用：A→B→A 时第二次的 A 被跳过，不会爆栈。
 */
export function expand(source: string, expanded = new Set<string>()): string {
  return source.replace(/^[ \t]*#include[ \t]+<minecraft:([\w.]+)>[ \t]*$/gm, (_match, name: string) => {
    if (expanded.has(name)) return ''
    expanded.add(name)
    const body = INCLUDE[name]
    if (body == null) throw new Error(`未移植的着色器 include：${name}`)
    return expand(body, expanded)
  })
}

/**
 * 去掉 varying（顶点输出 / 片元输入）上的 `layout(location = N)`。
 *
 * @constraint GLSL ES 3.00 只在「顶点着色器的输入」和「片元着色器的输出」
 *      上允许 `layout(location=)`。原版是 GLSL 330，三者都能写，
 *      直接搬到 ES 3.00 会报 `'location' : invalid layout qualifier`，
 *      而且错误行号指在文件末尾附近的 varying 声明上，很容易误以为是
 *      别的语法问题。varying 靠名字配对即可，不需要显式槽位。
 */
export function stripVaryingLocations(source: string, stage: 'vertex' | 'fragment'): string {
  const target = stage === 'vertex' ? 'out' : 'in'
  const pattern = new RegExp(`^[ \\t]*layout\\s*\\([^)]*location\\s*=[^)]*\\)\\s*${target}\\b`, 'gm')
  return source.replace(pattern, target)
}

/**
 * 把原版 GLSL 330 的源码转成 GLSL ES 3.00。
 *
 * @why 只做必要的机械替换，不做语义改写。原版用的是 `#version 330` +
 *      `GL_ARB_separate_shader_objects`，WebGL2 只认 `#version 300 es`，
 *      且把 `layout(location)` 的 in/out 视为内建能力（不需要扩展声明）。
 * @constraint 精度限定必须补。ES 3.00 的片元着色器没有默认 float 精度，
 *      不写 `precision highp float` 会直接编译失败；而顶点着色器虽然默认
 *      是 highp，为一致性也一并写。
 */
export function toEs(source: string, stage: 'vertex' | 'fragment'): string {
  let out = source
    .replace(/^[ \t]*#version[ \t]+330[ \t]*$/m, '#version 300 es')
    .replace(/^[ \t]*#extension[ \t]+GL_ARB_separate_shader_objects[ \t]*:[ \t]*require[ \t]*$/m, '')

  out = flattenUniformBlocks(out)
  out = stripVaryingLocations(out, stage)

  // 扩展声明删掉后会留下空行，压一下，方便编译报错时对行号
  out = out.replace(/\n{3,}/g, '\n\n')

  const precision =
    stage === 'fragment'
      ? 'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n'
      : 'precision highp float;\nprecision highp int;\n'

  // 插到版本行之后
  return out.replace(/^#version 300 es[ \t]*$/m, `#version 300 es\n${precision}`)
}
