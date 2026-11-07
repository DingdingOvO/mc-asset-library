#!/usr/bin/env python3
"""
从反编译的 Minecraft 源码里提取实体模型几何。

@why 实体模型是硬编码在 Java 里的（EntityModel 子类 + addBox 调用），资源包里
      只有贴图没有几何。要做出和游戏一样的生物，只能从源码里把盒子挖出来。

@constraint 入口必须是 LayerDefinitions.createRoots()，不能逐个扫 *Model.java。
      游戏渲染一具生物的真实路径是：
        EntityRenderers → Renderer 构造器 bakeLayer(ModelLayers.X)
        → EntityModelSet 里查 ModelLayers.X → LayerDefinition（含贴图尺寸与
        MeshTransformer）→ PartDefinition.bake() → ModelPart 树 → render()
      只有这条链上的 LayerDefinition 带着正确的 texSize 和缩放。之前靠 PNG
      尺寸反推 texSize，猫（material 64×32 / 贴图 64×64）、恶魂
      （64×32 / 贴图 128×64）的 UV 全部算错，整只生物碎成几块。

输入：CFR 反编译后的 net/minecraft/client/model 目录
输出：entitymodels.json
"""
import ast
import json
import os
import re
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/modelsrc/net/minecraft/client/model'
# 输出进 mc-derived：这些数据来自反编译源码，官方 jar 里没有，必须入库
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'mc-derived', VERSION, 'entitymodels.json')
TEXTURES = sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, 'mc-assets', VERSION, 'textures')
# 少量图层建在渲染器类里（WitherSkullRenderer.createSkullLayer），模型目录搜不到
EXTRA_SRC = sys.argv[4] if len(sys.argv) > 4 else '/tmp/rendsrc/net/minecraft/client/renderer'


# ---------------------------------------------------------------- 源码索引

_CLASS_FILES = None
_SRC_CACHE = {}


def class_files():
    """类名 → 文件路径。同名类在不同包下极少见，取第一个即可。"""
    global _CLASS_FILES
    if _CLASS_FILES is not None:
        return _CLASS_FILES
    table = {}
    for root_dir in (SRC, EXTRA_SRC):
        if not os.path.isdir(root_dir):
            continue
        for root, _dirs, files in os.walk(root_dir):
            for name in files:
                if not name.endswith('.java'):
                    continue
                table.setdefault(name[:-5], os.path.join(root, name))
    _CLASS_FILES = table
    return table


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    text = re.sub(r'//[^\n]*', '', text)
    return text


def class_src(name):
    if name in _SRC_CACHE:
        return _SRC_CACHE[name]
    path = class_files().get(name)
    if not path:
        _SRC_CACHE[name] = None
        return None
    raw = strip_comments(open(path, encoding='utf-8', errors='replace').read())
    _SRC_CACHE[name] = raw
    return raw


# ---------------------------------------------------------------- Java 词法

def read_balanced(text, start):
    """从 start（指向 '(' 之后）读到一个配平的 ')' 为止"""
    depth = 1
    i = start
    quote = None
    while i < len(text) and depth > 0:
        ch = text[i]
        if quote:
            if ch == quote:
                quote = None
        elif ch in '"\'':
            quote = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        i += 1
    return text[start:i - 1], i


def read_block(text, start):
    """从 start（指向 '{' 之后）读到配平的 '}'"""
    depth = 1
    i = start
    quote = None
    while i < len(text) and depth > 0:
        ch = text[i]
        if quote:
            if ch == quote:
                quote = None
        elif ch in '"\'':
            quote = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
        i += 1
    return text[start:i - 1], i


def split_args(text):
    """按顶层逗号切分参数"""
    args, depth, cur, quote = [], 0, [], None
    for ch in text:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in '"\'':
            quote = ch
            cur.append(ch)
            continue
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == ',' and depth == 0:
            args.append(''.join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    if cur:
        args.append(''.join(cur).strip())
    return args


def methods_of(cls):
    """类自己声明的方法：name → (返回类型, 形参名列表, 方法体)"""
    src = class_src(cls)
    if src is None:
        return {}
    out = {}
    for m in re.finditer(
            r'(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?'
            r'([\w<>\[\],. ]+?)\s+(\w+)\s*\(([^)]*)\)\s*\{', src):
        ret = m.group(1).strip()
        if ret in ('if', 'for', 'while', 'switch', 'return', 'new', 'else'):
            continue
        name = m.group(2)
        params = []
        for part in split_args(m.group(3)):
            tokens = part.replace('final ', '').split()
            if len(tokens) >= 2:
                params.append(tokens[-1])
        body, _ = read_block(src, m.end())
        out.setdefault(name, (ret, params, body))
    return out


def class_extends(cls):
    """直接父类名（去掉泛型）。@why 鞍具/冷变体全都靠继承来的 createBodyMesh。"""
    src = class_src(cls)
    if not src:
        return None
    m = re.search(r'class\s+%s(?:<[^>]*>)?\s+extends\s+([\w.]+)' % re.escape(cls), src)
    return m.group(1).rsplit('.', 1)[-1] if m else None


_METHODS_MERGED = {}


def all_methods(cls):
    """
    含继承链的方法表：子类同名方法优先。

    @why CamelSaddleModel.createSaddleLayer() 里写的是 `CamelSaddleModel.createBodyMesh()`，
          而 createBodyMesh 根本没有覆写，声明在 AdultCamelModel 上。只查本类会得到
          空表，整个鞍具图层解析失败——马鞍、骆驼鞍、暖色牛、鹦鹉螺壳全是这么丢的。
    """
    hit = _METHODS_MERGED.get(cls)
    if hit is not None:
        return hit
    merged = {}
    stack = [cls]
    seen = set()
    depth = 0
    while stack and depth < 12:
        cur = stack.pop(0)
        depth += 1
        if cur in seen:
            continue
        seen.add(cur)
        for name, sig in methods_of(cur).items():
            merged.setdefault(name, sig)
        parent = class_extends(cur)
        if parent:
            stack.append(parent)
    _METHODS_MERGED[cls] = merged
    return merged


_STR_CONSTS = {}


def str_consts(cls):
    """类里 `static final String NAME = "x";` 的常量表（部件名大量用类内常量）"""
    if cls in _STR_CONSTS:
        return _STR_CONSTS[cls]
    out = {}
    cur = cls
    for _ in range(12):
        src = class_src(cur) if cur else None
        if not src:
            break
        for m in re.finditer(r'static\s+final\s+String\s+(\w+)\s*=\s*"([^"]*)"', src):
            out.setdefault(m.group(1), m.group(2))
        cur = class_extends(cur)
    _STR_CONSTS[cls] = out
    return out


def statements(code):
    """
    把方法体切成 ['stmt', 文本] 与 ['block', 头, 然后块, 否则块]

    @constraint 只有在括号深度为 0 时才算语句边界：for 头里的分号
      （`for (int i = 0; i < 9; ++i)`）不是语句结束，按 ';' 盲切会把
      循环拆成三条垃圾语句，恶魂的九根触手就是这么丢的。
    """
    out = []
    buf = []
    i = 0
    n = len(code)
    depth = 0
    quote = None
    while i < n:
        ch = code[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in '"\'':
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch in '([':
            depth += 1
            buf.append(ch)
            i += 1
            continue
        if ch in ')]':
            depth = max(0, depth - 1)
            buf.append(ch)
            i += 1
            continue
        if ch == '{' and depth == 0:
            header = ''.join(buf).strip()
            buf = []
            inner, i = read_block(code, i + 1)
            else_block = None
            tail = code[i:]
            m = re.match(r'\s*else\s*\{', tail)
            if m:
                else_block, i = read_block(code, i + m.end())
            out.append(['block', header, inner, else_block])
            while i < n and code[i] in ' \t\r\n;':
                i += 1
            continue
        if ch == ';' and depth == 0:
            text = ''.join(buf).strip()
            buf = []
            if text:
                out.append(['stmt', text])
            i += 1
            continue
        buf.append(ch)
        i += 1
    return out


# ---------------------------------------------------------------- 数值求值

def make_env(values):
    return {k: float(v) for k, v in values.items() if isinstance(v, (int, float))}


def eval_math(text, env):
    """
    把 Math.cos / Math.sin / Math.sqrt 这类常量调用就地折成数字。

    @constraint 只做「参数本身能算成数」的情形。参数里还有未知标识符时原样返回，
          交给后面按 0 处理的兜底逻辑，不会把整条表达式判死。
    """
    import math as _math

    # @why Mth.cos / Mth.sin 就是转调 Math 的同一批函数，烈焰人 12 根棒子
    #      的坐标全靠 Mth.cos(angle) 算，不认 Mth 前缀就全叠在原点
    text = text.replace('Mth.', 'Math.')
    funcs = {
        'cos': _math.cos,
        'sin': _math.sin,
        'tan': _math.tan,
        'sqrt': _math.sqrt,
        'abs': abs,
        'floor': _math.floor,
        'ceil': _math.ceil,
        'toRadians': _math.radians,
        'toDegrees': _math.degrees,
    }
    for _ in range(12):
        # @constraint 不能用 `\(([^()]*)\)` 抓参数：烈焰人的 y 是
        #      `Mth.cos((float)(i * 2) * 0.25f)`，参数里有嵌套括号，
        #      正则匹配不上整条调用，12 根棒子就全被算成 y=0
        m = re.search(r'Math\.(\w+)\s*\(', text)
        if not m or m.group(1) not in funcs:
            break
        inner, end = read_balanced(text, m.end())
        inner = eval_math(inner, env)
        # 参数里的局部变量要先代进去：Math.cos(angle) 里的 angle 是上一条语句算的
        inner = re.sub(
            r'\b([A-Za-z_]\w*)\b',
            lambda mm: repr(env[mm.group(1)]) if mm.group(1) in (env or {}) else mm.group(0),
            inner,
        )
        try:
            value = funcs[m.group(1)](eval(inner, {'__builtins__': {}}, {}))
        except Exception:
            break
        # @constraint 固定小数位输出：repr 会给出 6.1e-17 这种科学计数法，
        #              后面按标识符替换时 e 会被当成未知变量抹成 0，
        #              坐标系整个算飞（鱿鱼触手 x 变成 -78）。
        text = text[: m.start()] + ('%.8f' % value) + text[end:]
    return text.replace('Math.PI', repr(_math.pi))


def sub_static_calls(text, env, depth=0):
    """
    把 Cls.method(参数) 这种返回数值的静态调用换成算好的数字。

    @why 守护者 12 根尖刺的坐标全在 getSpikeX/Y/Z 里，每个 i 对应一个方向。
          不求值的话 12 根尖刺全部落在同一点，整只守卫者变成一个球。
    """
    if depth > 4:
        return text

    def repl(m):
        sig = all_methods(m.group(1)).get(m.group(2))
        if not sig or sig[0] not in ('float', 'double', 'int', 'long'):
            return m.group(0)
        inner, _ = read_balanced(m.group(0), m.group(0).find('(') + 1)
        local = dict(env)
        for pname, arg in zip(sig[1], split_args(inner)):
            local[pname] = num(arg, env)
        rm = re.search(r'return\s+(.+?);', sig[2], re.S)
        if not rm:
            return m.group(0)
        value = num(sub_static_calls(rm.group(1), local, depth + 1), local)
        return repr(float(value))

    return re.sub(r'\b(\w+)\.(\w+)\s*\([^()]*\)', repl, text)


def sub_arrays(text, env):
    """
    把 NAME[i] / NAME[i][j] 换成实际数值。

    @constraint 先替换二维再替换一维：`BODY_SIZES[i][1]` 若先走一维规则，
          会变成 `[4, 3, 2][1]` 这种非法表达式，整条语句直接归零。
    """

    def pick(name, idx, outer=None):
        table = None
        if _CURRENT_CLS:
            table = ARRAY_CONSTS.get(f'{_CURRENT_CLS}.{name}')
        table = table or ARRAY_CONSTS.get(name)
        if table is None:
            return None
        try:
            seq = table if outer is None else table[int(num(outer, env))]
            return seq[int(num(idx, env))]
        except (IndexError, TypeError, ValueError):
            return None

    def two(m):
        value = pick(m.group(1), m.group(3), m.group(2))
        return repr(float(value)) if isinstance(value, (int, float)) else m.group(0)

    def one(m):
        value = pick(m.group(1), m.group(2))
        if isinstance(value, (list, tuple)):
            return m.group(0)
        return repr(float(value)) if isinstance(value, (int, float)) else m.group(0)

    text = re.sub(r'\b(\w+)\s*\[([^\[\]]+)\]\s*\[([^\[\]]+)\]', two, text)
    text = re.sub(r'\b(\w+)\s*\[([^\[\]]+)\]', one, text)
    return text


def num(expr, env=None):
    """Java 简单表达式求值：5.0f → 5.0，env 里的标识符取真实值，其余标识符按 0。

    @why 不能"过滤掉不认识的参数"：PartPose.offset(-5.0f, 2.0f + yOffset, 0.0f)
         过滤后 z 会顶到 y 的位置，整条手臂挂到脚下。
    """
    env = env or {}
    text = expr.strip()
    ext = re.search(r'\.extend\(\s*(-?\d+(?:\.\d+)?)f?\s*\)', text)
    if ext:
        return float(ext.group(1))
    # @why 强制转型必须先去：`(float)(i % 3)` 里的 float 会被当作标识符替换成 0，
    #      变成 `(0)(i % 3)`——调用数字。恶魂触手的横坐标全靠这类表达式算，
    #      算不出来九根触手就全叠在原点，看起来像没有触手。
    text = re.sub(r'\((?:float|double|int|byte|short|long)\)\s*', '', text)
    # @why 循环变量是 Java int，`i / 3` 是整除。按浮点算会得到 0.333，
    #      恶魂触手的 (i / 3 % 2) 就永远算不到 1，三排触手挤成一排。
    for name in _INT_VARS:
        text = re.sub(r'\b%s\s*/\s*(\d+)' % re.escape(name), r'%s // \1' % name, text)
    text = re.sub(r'(\d+(?:\.\d+)?)[fFdDlL]\b', r'\1', text)
    # 数学库：鱿鱼八条触手的坐标是 Math.cos(i * 2π / 8) 算出来的，
    # 不认 Math.* 就全叠在原点，整只鱿鱼只剩一根触手。
    text = sub_arrays(text, env)
    text = sub_static_calls(text, env)
    text = eval_math(text, env)
    # 带点路径的标识符优先整体查表（PartNames.LEFT_LEG 之类）
    def repl(m):
        key = m.group(0)
        if key in env:
            return repr(env[key])
        short = key.split('.')[-1]
        if short in env:
            return repr(env[short])
        return '0'
    text = re.sub(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\([^()]*\))?', repl, text)
    # @why % 必须在白名单里：恶魂触手的横坐标是 (i % 3) 算出来的，
    #      漏掉取模会让表达式整条被判定为非法、返回 0，九根触手叠成一束。
    if not re.fullmatch(r'[\d\s+\-*/().%eE]+', text):
        return 0.0
    try:
        return float(eval(text, {'__builtins__': {}}, {}))
    except Exception:
        return 0.0


class JavaRandom:
    """LegacyRandomSource 的 nextInt 序列。@why 恶魂触手长度就是这么掷出来的。"""

    MULT = 0x5DEECE66D
    ADD = 0xB
    MASK = (1 << 48) - 1

    def __init__(self, seed):
        self.seed = (seed ^ self.MULT) & self.MASK

    def next(self, bits):
        self.seed = (self.seed * self.MULT + self.ADD) & self.MASK
        return self.seed >> (48 - bits)

    def next_int(self, bound):
        if bound <= 0:
            return 0
        if bound & (bound - 1) == 0:
            return (bound * self.next(31)) >> 31
        while True:
            bits = self.next(31)
            val = bits % bound
            if bits - val + (bound - 1) < (1 << 31):
                return val


# ---------------------------------------------------------------- 几何结构

class Ctx:
    """一次 PartDefinition 树的构建过程"""

    def __init__(self):
        self.parts = []
        self.env = {}       # 变量 → 值（部件 id / 盒子列表 / 数值 / pose）
        self.mesh_roots = {}  # MeshDefinition 变量 → 根部件 id
        self.depth = 0
        self.warnings = []

    def new_part(self, parent, name, cubes, pose):
        part = {
            'name': name,
            'parent': parent,
            'pose': pose,
            'cubes': cubes,
            'children': [],
        }
        idx = len(self.parts)
        self.parts.append(part)
        if parent is not None:
            self.parts[parent]['children'].append(idx)
        return idx

    def add_or_replace(self, parent, name, cubes, pose):
        """
        同名部件替换，但保留旧部件的子节点。

        @why PartDefinition.addOrReplaceChild 的语义就是这样：子类覆盖父类的
              "body" 时，挂在 body 下的腿不能跟着消失。按"简单追加"实现会出现
              两个同名 body 叠在一起，按"直接删掉旧枝"实现会丢腿——两种都会
              让模型看起来烂掉。
        """
        if parent is None:
            return None
        for child in self.parts[parent]['children']:
            if self.parts[child]['name'] == name:
                kept = self.parts[child]['children']
                self.parts[child] = {
                    'name': name,
                    'parent': parent,
                    'pose': pose,
                    'cubes': cubes,
                    'children': kept,
                }
                return child
        return self.new_part(parent, name, cubes, pose)

    def subtree_copy(self, src, dst_parent, name=None):
        """把一棵已建好的子树挪到新父节点下（addOrReplaceChild(name, PartDefinition)）"""
        node = self.parts[src]
        idx = self.add_or_replace(dst_parent, name or node['name'], node['cubes'], node['pose'])
        for child in list(node['children']):
            self.subtree_copy(child, idx)
        return idx


# 循环变量是 Java int，`i / 3` 必须按整除算
_INT_VARS = set()

EMPTY_GROW = (0.0, 0.0, 0.0)


def parse_grow(text, env):
    """CubeDeformation → 三个方向的膨胀量"""
    m = re.search(r'CubeDeformation\s*\(([^)]*)\)', text)
    if m:
        vals = [num(a, env) for a in split_args(m.group(1))]
        if len(vals) >= 3:
            return (vals[0], vals[1], vals[2])
        if vals:
            return (vals[0], vals[0], vals[0])
        return EMPTY_GROW
    if text.strip() == 'CubeDeformation.NONE':
        return EMPTY_GROW
    key = text.strip()
    if key in env and isinstance(env[key], tuple):
        return env[key]
    return EMPTY_GROW


ALL_FACES = ('down', 'up', 'west', 'north', 'east', 'south')


def parse_faces(text):
    if 'Direction.' not in text:
        return ALL_FACES
    names = [d.lower() for d in re.findall(r'Direction\.([A-Z]+)', text)]
    return tuple(n for n in names if n in ALL_FACES)


def parse_cubes(expr, env):
    """CubeListBuilder：texOffs / mirror / addBox 是一条有状态的链"""
    text = expr.strip()
    if text in env and isinstance(env[text], list):
        return env[text]

    cubes = []
    mirror = False
    uv = (0.0, 0.0)
    i = 0
    while i < len(text):
        m = re.search(r'\.(texOffs|mirror|addBox)\s*\(', text[i:])
        if not m:
            break
        kind = m.group(1)
        inner, nxt = read_balanced(text, i + m.end())
        args = split_args(inner)
        if kind == 'texOffs':
            if len(args) >= 2:
                uv = (num(args[0], env), num(args[1], env))
        elif kind == 'mirror':
            mirror = True if not args else args[0].strip() == 'true'
        else:
            # addBox 有 9 个重载，先按"有没有 id 字符串"分组
            has_id = bool(args) and args[0].startswith('"')
            vals = [a for a in args if not a.startswith('"')]
            if has_id:
                uv = uv if len(vals) < 9 else (num(vals[7], env), num(vals[8], env))
            if len(vals) < 6:
                i = nxt
                continue
            coords = [num(v, env) for v in vals[0:6]]
            grow = EMPTY_GROW
            faces = ALL_FACES
            tex_scale = (1.0, 1.0)
            if len(vals) >= 7:
                extra = vals[6]
                if 'CubeDeformation' in extra or extra.strip() == 'CubeDeformation.NONE':
                    grow = parse_grow(extra, env)
                elif 'Direction' in extra:
                    faces = parse_faces(extra)
                elif extra.strip() in ('true', 'false'):
                    mirror = extra.strip() == 'true'
                elif extra.strip() in env and isinstance(env[extra.strip()], tuple):
                    grow = env[extra.strip()]
            if len(vals) >= 9 and not has_id:
                tex_scale = (num(vals[7], env), num(vals[8], env))
            cubes.append({
                'uv': [round(uv[0]), round(uv[1])],
                'from': [coords[i2] - grow[i2] for i2 in range(3)],
                'size': [coords[i2 + 3] + grow[i2] * 2 for i2 in range(3)],
                # @why UV 必须按未膨胀的尺寸算：Cube 构造里 u1=u0+depth 用的是
                #      参数 depth，而几何才用 min/max ± grow。零宽盒子（缰绳、
                #      鬃毛、帆这类平板 addBox(...,0,...)）的上下前后四面在 vanilla
                #      里 UV 跨度为 0，画不出东西；用膨胀后的 0.002 当跨度，就会
                #      把它当成极窄面去采样贴图同一列，渲染成一条黑边。
                'base': [round(coords[i2 + 3], 4) for i2 in range(3)],
                'mirror': mirror,
                'faces': list(faces),
                'ts': [round(tex_scale[0], 4), round(tex_scale[1], 4)],
            })
        i = nxt
    return cubes


def parse_pose(text, env):
    """PartPose → (x, y, z, xRot, yRot, zRot, xScale, yScale, zScale)"""
    text = text.strip()
    if text in env and isinstance(env[text], tuple):
        return env[text]
    if 'PartPose.ZERO' in text:
        return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0)
    if text.startswith('new PartPose'):
        inner, _ = read_balanced(text, text.find('(') + 1)
        vals = [num(a, env) for a in split_args(inner)]
        while len(vals) < 9:
            vals.append(1.0 if len(vals) >= 6 else 0.0)
        return tuple(vals[:9])
    m = re.search(r'PartPose\.(offsetAndRotation|offset|rotation)\s*\(', text)
    if not m:
        return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0)
    inner, _ = read_balanced(text, m.end())
    vals = [num(a, env) for a in split_args(inner)]
    if m.group(1) == 'rotation':
        vals = [0.0, 0.0, 0.0] + vals
    while len(vals) < 6:
        vals.append(0.0)
    return tuple(vals[:6] + [1.0, 1.0, 1.0])


def split_plus(text):
    """按顶层 + 切分字符串拼接表达式（"tentacle" + i + "_tip"）"""
    out, depth, cur, quote = [], 0, [], None
    for ch in text:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in '"\'':
            quote = ch
            cur.append(ch)
            continue
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == '+' and depth == 0:
            out.append(''.join(cur))
            cur = []
            continue
        cur.append(ch)
    if cur:
        out.append(''.join(cur))
    return out


def eval_name(expr, env, cls=None):
    """部件名：字面量 / 常量 / PartNames.xxx(i) / 类内 static final String"""
    text = expr.strip()
    if text.startswith('"'):
        return text.strip('"')
    m = re.match(r'PartNames\.(\w+)\s*\((.*)\)$', text)
    if m:
        inner, _ = read_balanced(text, text.find('(') + 1)
        return m.group(1) + ''.join(str(int(num(a, env))) for a in split_args(inner))
    m = re.match(r'PartNames\.(\w+)$', text)
    if m:
        return m.group(1)
    # 类内的命名辅助方法：SquidModel.createTentacleName(i) → "tentacle" + i
    # @why 触手、肋骨这类循环生成的部件，名字是拼出来的。拼不出来时十条触手会
    #      共用一个名字，骨骼树里只剩最后一条，动作代码也就找不到它们。
    m = re.match(r'(\w+)\.(\w+)\s*\(', text)
    if m:
        sig = all_methods(m.group(1)).get(m.group(2))
        if sig and sig[0] == 'String':
            inner, _ = read_balanced(text, m.end())
            local = dict(zip(sig[1], [num(a, env) for a in split_args(inner)]))
            rm = re.search(r'return\s+(.+?);', sig[2], re.S)
            if rm:
                built = ''
                for piece in split_plus(rm.group(1)):
                    piece = piece.strip()
                    if piece.startswith('"'):
                        built += piece.strip('"')
                    elif piece in local:
                        built += str(int(local[piece]))
                    else:
                        built += str(int(num(piece, local)))
                if built:
                    return built
    if text in env and isinstance(env[text], str):
        return env[text]
    if text in NAME_CONSTS:
        return NAME_CONSTS[text]
    if cls:
        consts = str_consts(cls)
        if text in consts:
            return consts[text]
    return text.strip('"')


# ---------------------------------------------------------------- 方法体解释

NAME_CONSTS = {}


def load_name_consts():
    src = class_src('PartNames') or ''
    for m in re.finditer(r'static\s+final\s+String\s+(\w+)\s*=\s*"([\w]+)"', src):
        NAME_CONSTS[m.group(1)] = m.group(2)


ARRAY_CONSTS = {}
_CURRENT_CLS = None


def parse_array_literal(text):
    """new int[][]{{4,3,2},...} / new float[]{1.75f,...} → 嵌套的 float 列表"""
    body = text.strip()
    body = re.sub(r'^new\s+\w+\s*(?:\[\s*\])*\s*', '', body)
    body = re.sub(r'(\d)[fFdDlL]\b', r'\1', body)
    body = body.replace('{', '[').replace('}', ']')
    try:
        value = ast.literal_eval(body)
    except Exception:
        return None
    return value if isinstance(value, (list, tuple)) else None


def load_array_consts():
    """
    类内 static final 数组常量。

    @why 蠹虫 / 末影螨 / 守护者的每一段躯干尺寸都写在这些表里（BODY_SIZES、
          SPIKE_X_ROT…）。不认数组就等于所有段都是 0×0，整只生物退化成几个
          看不见的点。
    """
    for cls in class_files():
        src = class_src(cls) or ''
        for m in re.finditer(r'static\s+final\s+[\w\[\]]+\s+(\w+)\s*=\s*new\s+[\w.]+', src):
            brace = src.find('{', m.end())
            if brace < 0:
                continue
            inner, _ = read_block(src, brace + 1)
            value = parse_array_literal('[' + inner.replace('{', '[').replace('}', ']') + ']')
            if not value:
                continue
            ARRAY_CONSTS[f'{cls}.{m.group(1)}'] = value
            ARRAY_CONSTS.setdefault(m.group(1), value)


def run_method(cls, name, args, ctx, arg_vals, depth=0):
    """
    解释执行一个静态几何方法，返回它 return 出来的部件 id。

    @constraint 必须真按语句顺序跑，不能全文正则扫：addOrReplaceChild 是有状态的
      （同名替换、变量指向哪一枝、for 循环展开几份），扫出来的树和游戏里的
      ModelPart 树对不上，动作再准也是错位的。
    """
    if depth > 6:
        return None
    table = all_methods(cls)
    if name not in table:
        ctx.warnings.append(f'{cls}.{name} 未找到')
        return None
    ret_type, params, body = table[name]

    local = dict(args)
    for idx, pname in enumerate(params):
        if idx < len(arg_vals):
            local[pname] = arg_vals[idx]
    global _CURRENT_CLS
    saved = dict(ctx.env)
    ctx.env.update(local)
    prev_cls, _CURRENT_CLS = _CURRENT_CLS, cls
    try:
        result = exec_block(statements(body), ctx, depth + 1, cls)
    finally:
        ctx.env = {**saved, **{k: v for k, v in ctx.env.items() if k not in local}}
        _CURRENT_CLS = prev_cls
    return result


def eval_cond(header, env):
    """
    求值 `if (...)` 的条件，返回 True / False / None（判不出来）。

    @why 岩浆怪的每一层 UV 都靠 `if (i > 0 && i < 4)` 选，把条件当恒真执行会
          让后四层全部取到 i<4 的贴图区，整个怪糊成一片。
    @constraint 判不出来时必须返回 None 而不是 False：解析器不认识的条件（含
          this.xxx、方法返回值）宁可按"执行"处理，退化成原来的行为，
          否则会整块整块地丢部件。
    """
    m = re.match(r'if\s*\(', header)
    if not m:
        return None
    inner, _ = read_balanced(header, m.end())
    expr = inner.strip().replace('&&', ' and ').replace('||', ' or ')
    expr = re.sub(r'!(?!=)', ' not ', expr)
    expr = re.sub(r'(\d+(?:\.\d+)?)[fFdDlL]\b', r'\1', expr)

    def repl(mo):
        key = mo.group(0)
        # @constraint and/or/not 是上一步替换出来的关键字，不能当成标识符抹掉，
        #      否则 `i > 0 && i < 4` 永远判不出来，岩浆怪后四层会取错贴图区
        if key in ('and', 'or', 'not'):
            return key
        if key in ('true', 'false'):
            return key.capitalize()
        if isinstance(env.get(key), (int, float)):
            return repr(float(env[key]))
        return '__unknown__'

    expr = re.sub(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*', repl, expr)
    if '__unknown__' in expr:
        return None
    try:
        return bool(eval(expr, {'__builtins__': {}}, {}))
    except Exception:
        return None


def exec_block(nodes, ctx, depth, cls):
    """返回最后 return 的部件 id（没有 return 就是 None）"""
    result = None
    for node in nodes:
        if node[0] == 'stmt':
            value = exec_stmt(node[1], ctx, depth, cls)
            if value is not None and value != 'return-void':
                if isinstance(value, tuple) and value[0] == 'return':
                    return value[1]
                result = result if result is not None else None
            if isinstance(value, tuple) and value[0] == 'return':
                return value[1]
            continue

        _, header, then_block, else_block = node
        # for 循环：恶魂的九根触手、烈焰人的十二根棒子都是循环里建的
        # @constraint 循环变量可以声明在 for 头里，也可以在外面先 `int i;` 再
        #      `for (i = 0; ...)`——BlazeModel 是后者，只认前者会只剩一个头
        fm = re.match(r'for\s*\(\s*(?:(?:int|long)\s+)?(\w+)\s*=\s*(-?\d+)\s*;'
                      r'\s*\1\s*<\s*([\w.]+)\s*;\s*(?:\+\+\1|\1\+\+)\s*\)', header)
        if fm:
            var, start, limit_expr = fm.group(1), int(fm.group(2)), fm.group(3)
            limit = int(num(limit_expr, ctx.env)) if num(limit_expr, ctx.env) else 0
            limit = max(0, min(limit, 64))
            _INT_VARS.add(var)
            for i in range(start, limit):
                ctx.env[var] = float(i)
                outcome = exec_block(statements(then_block), ctx, depth + 1, cls)
                if isinstance(outcome, int):
                    result = outcome
            ctx.env.pop(var, None)
            continue

        head = header[len('else'):].strip() if header.startswith('else') else header
        # @why `else if (c) {` 在 statements 里是独立 block（不是 else 块），
        #      当成普通 if 处理：岩浆怪的 u/v 两组条件是互斥的，结果一致
        if head.startswith('if'):
            cond = eval_cond(head, ctx.env)
            if cond is False:
                if else_block is None:
                    continue
                outcome = exec_block(statements(else_block), ctx, depth + 1, cls)
            else:
                outcome = exec_block(statements(then_block), ctx, depth + 1, cls)
            if isinstance(outcome, int):
                result = outcome
            continue

        # while / switch / try：几何里没有，直接跳过

    return result


def resolve_part(expr, ctx, env):
    """
    把一段"部件表达式"求值成 ctx.parts 的下标。

    支持 mesh / root / mesh.getRoot() / body.getChild("head") 这几种链式写法。
    """
    text = expr.strip()
    if not text:
        return None
    hit = env.get(text)
    if isinstance(hit, int):
        return hit
    m = re.match(r'(\w+)\.getRoot\s*\(\s*\)$', text)
    if m:
        return ctx.mesh_roots.get(m.group(1))
    m = re.match(r'(\w+)\.getChild\s*\(', text)
    if m:
        parent = resolve_part(m.group(1), ctx, env)
        if not isinstance(parent, int):
            return None
        inner, _ = read_balanced(text, m.end())
        name = eval_name(split_args(inner)[0], env) if inner else ''
        for child in ctx.parts[parent]['children']:
            if ctx.parts[child]['name'] == name:
                return child
        return None
    return None


def exec_stmt(stmt, ctx, depth, cls):
    env = ctx.env

    if stmt.startswith('return'):
        expr = stmt[len('return'):].strip()
        if expr in env and isinstance(env[expr], int):
            return ('return', env[expr])
        if 'getRoot()' in expr:
            return ('return', ctx.mesh_roots.get(expr.split('.')[0]))
        # @why return 的常常是 LayerDefinition.create(mesh, w, h) 这种表达式，
        #      不是变量名。这时"这一趟建出来的那棵树"就是答案——取最早的根。
        roots = [i for i, p in enumerate(ctx.parts) if p['parent'] is None]
        return ('return', roots[0] if roots else None)

    # MeshDefinition mesh = new MeshDefinition();
    m = re.match(r'MeshDefinition\s+(\w+)\s*=\s*new\s+MeshDefinition\s*\(\s*\)$', stmt)
    if m:
        root = ctx.new_part(None, '', [], (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0))
        ctx.parts[root]['name'] = ''
        ctx.mesh_roots[m.group(1)] = root
        env[m.group(1)] = root
        return None

    """
    MeshDefinition mesh = new MeshDefinition().transformed(p -> p.translated(0.0f, 24.0f, 0.0f));

    @why transformed() 里的 translated 是整棵树的位移，等价于根部件 pose 的 offset。
          copper_golem 全靠这一下把模型从"脚在原点"搬到"脚在 y=24"，漏了整只傀儡
          会陷进地里半格。缩放类变换由外层 .apply(MeshTransformer) 处理，不在这里。
    """
    m = re.match(r'MeshDefinition\s+(\w+)\s*=\s*new\s+MeshDefinition\s*\(\s*\)\s*\.\s*transformed\s*\(', stmt)
    if m:
        inner, _ = read_balanced(stmt, m.end())
        offset = (0.0, 0.0, 0.0)
        tm = re.search(r'\.translated\s*\(', inner)
        if tm:
            tinner, _ = read_balanced(inner, tm.end())
            vals = [num(a, ctx.env) for a in split_args(tinner)]
            if len(vals) >= 3:
                offset = (vals[0], vals[1], vals[2])
        pose = (offset[0], offset[1], offset[2], 0.0, 0.0, 0.0, 1.0, 1.0, 1.0)
        root = ctx.new_part(None, '', [], pose)
        ctx.parts[root]['name'] = ''
        ctx.mesh_roots[m.group(1)] = root
        env[m.group(1)] = root
        return None

    # CubeDeformation g = new CubeDeformation(0.5f) / CubeDeformation.NONE
    m = re.match(r'CubeDeformation\s+(\w+)\s*=\s*(.+)$', stmt)
    if m:
        env[m.group(1)] = parse_grow(m.group(2), env)
        return None

    # CubeListBuilder legs = CubeListBuilder.create()...
    m = re.match(r'CubeListBuilder\s+(\w+)\s*=\s*(.+)$', stmt)
    if m:
        env[m.group(1)] = parse_cubes(m.group(2), env)
        return None

    # MeshDefinition mesh = SomeModel.createBodyMesh(...)
    m = re.match(r'MeshDefinition\s+(\w+)\s*=\s*(\w+)\.(\w+)\s*\(', stmt)
    if m:
        inner, _ = read_balanced(stmt, m.end())
        arg_vals = [eval_arg(a, env) for a in split_args(inner)]
        before = len(ctx.parts)
        root = run_method(m.group(2), m.group(3), {}, ctx, arg_vals, depth + 1)
        del before
        if root is not None:
            ctx.mesh_roots[m.group(1)] = root
            env[m.group(1)] = root
        return None

    # PartDefinition root = mesh.getRoot()
    m = re.match(r'PartDefinition\s+(\w+)\s*=\s*(\w+)\.getRoot\s*\(\s*\)$', stmt)
    if m:
        env[m.group(1)] = ctx.mesh_roots.get(m.group(2))
        return None

    # PartDefinition x = <parent>.getChild("name")
    m = re.match(r'PartDefinition\s+(\w+)\s*=\s*(\w+)\.getChild\s*\(', stmt)
    if m:
        inner, _ = read_balanced(stmt, m.end())
        name = eval_name(split_args(inner)[0], env, cls) if inner else ''
        parent = env.get(m.group(2))
        found = None
        if isinstance(parent, int):
            for child in ctx.parts[parent]['children']:
                if ctx.parts[child]['name'] == name:
                    found = child
        env[m.group(1)] = found
        return None

    # PartDefinition x = <父部件表达式>.addOrReplaceChild(...)
    # @why 父部件不一定是裸变量：WarmCowModel 写的是 mesh.getRoot().addOrReplaceChild(...)。
    #      只认 `变量.` 会把整条暖色牛头丢掉。
    at = stmt.find('.addOrReplaceChild')
    if at > 0:
        head = stmt[:at]
        var = None
        vm = re.match(r'PartDefinition\s+(\w+)\s*=\s*(.+)$', head)
        if vm:
            var, head = vm.group(1), vm.group(2)
        parent = resolve_part(head.strip(), ctx, env)
        inner, _ = read_balanced(stmt, at + len('.addOrReplaceChild') + 1)
        args = split_args(inner)
        if not isinstance(parent, int) or len(args) < 2:
            return None
        name = eval_name(args[0], env, cls)
        builder = args[1]
        # 第二参数是 PartDefinition 变量：整枝挪过来
        if builder.strip() in env and isinstance(env[builder.strip()], int):
            idx = ctx.subtree_copy(env[builder.strip()], parent, name)
        else:
            cubes = parse_cubes(builder, env)
            pose = parse_pose(args[2], env) if len(args) > 2 else (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0)
            idx = ctx.add_or_replace(parent, name, cubes, pose)
        if var:
            env[var] = idx
        return None

    # 裸静态调用：BoatModel.addCommonParts(root); PiglinModel.addHead(g, mesh);
    # @why 这类方法只是往已有树上挂盒子，跳过就等于整条船没有船帮、猪灵头没有耳朵。
    m = re.match(r'(\w+)\.(\w+)\s*\(', stmt)
    if m and class_src(m.group(1)):
        cls_name, meth = m.group(1), m.group(2)
        if meth in all_methods(cls_name):
            inner, end = read_balanced(stmt, m.end())
            if stmt[end:].strip() == '':
                arg_vals = []
                for arg in split_args(inner):
                    part = resolve_part(arg.strip(), ctx, env)
                    arg_vals.append(part if isinstance(part, int) else eval_arg(arg, env))
                run_method(cls_name, meth, {}, ctx, arg_vals, depth + 1)
                return None

    # PartDefinition x = root; 之类的纯拷贝
    m = re.match(r'PartDefinition\s+(\w+)\s*=\s*(\w+)$', stmt)
    if m:
        env[m.group(1)] = env.get(m.group(2))
        return None

    # int len = random.nextInt(7) + 8;
    m = re.match(r'(?:int|float|double)\s+(\w+)\s*=\s*(\w+)\.nextInt\s*\(', stmt)
    if m and isinstance(env.get(m.group(2)), JavaRandom):
        inner, _ = read_balanced(stmt, m.end())
        bound = int(num(split_args(inner)[0], env))
        roll = env[m.group(2)].next_int(bound)
        rest = stmt[stmt.find(')', m.end()) + 1:].strip()
        if rest.startswith('+'):
            roll += num(rest[1:], env)
        env[m.group(1)] = float(roll)
        return None

    # 无初始化声明：float x; int i;（烈焰人先声明再在循环里反复赋值）
    # @constraint 必须给 0 兜底：后面的 `x = ...` 只认 env 里已存在的变量，
    #      不给就整条赋值被丢，12 根棒子全站在原点
    m = re.match(r'(?:final\s+)?(?:float|double|int|long)\s+(\w+)$', stmt)
    if m:
        env[m.group(1)] = 0.0
        return None

    # 局部变量：float x = ...;
    m = re.match(r'(?:final\s+)?(?:float|double|int)\s+(\w+)\s*=\s*(.+)$', stmt)
    if m:
        env[m.group(1)] = num(m.group(2), env)
        return None

    # 复合赋值：angle += 1.5707964f;（烈焰人的每一层棒子靠这一步转 90°）
    m = re.match(r'^(\w+)\s*\+=?\s*(.+)$', stmt)
    if m and m.group(1) in env:
        env[m.group(1)] = num(m.group(1), env) + num(m.group(2), env)
        return None
    m = re.match(r'^(\w+)\s*-=\s*(.+)$', stmt)
    if m and m.group(1) in env:
        env[m.group(1)] = num(m.group(1), env) - num(m.group(2), env)
        return None

    # 已知局部变量的再赋值：angle = i * Math.PI * -2.0 / 8.0 + 1.57…;
    # @why 鱿鱼触手的朝向就是先声明 angle 再重算一次，漏掉这一步八条触手
    #      会用同一个角度，看起来像一根。
    m = re.match(r'^(\w+)\s*=\s*(.+)$', stmt)
    if m and m.group(1) in env:
        env[m.group(1)] = num(m.group(2), env)
        return None

    # RandomSource random = RandomSource.createThreadLocalInstance(1660L);
    m = re.match(r'RandomSource\s+(\w+)\s*=\s*RandomSource\.createThreadLocalInstance\s*\(', stmt)
    if m:
        inner, _ = read_balanced(stmt, m.end())
        env[m.group(1)] = JavaRandom(int(num(split_args(inner)[0], env)))
        return None

    return None


def eval_arg(text, env):
    """实参求值：数字 / 变量 / CubeDeformation"""
    text = text.strip()
    if 'CubeDeformation' in text or text in ('CubeDeformation.NONE', 'CubeDeformation.NONE'):
        return parse_grow(text, env)
    if text in env:
        return env[text]
    return num(text, env)


# ---------------------------------------------------------------- 图层定义

def parse_layer_expr(expr, ctx_cls=None, ctx_method=None, depth=0, locals_=None):
    """
    LayerDefinition 表达式 → {'cls','method','args','texW','texH','transforms'}

    三种写法都要能跟到底：
      LayerDefinition.create(SomeModel.createBodyMesh(g), 64, 32).apply(...)
      LayerDefinition.create(mesh, 64, 32)          ← mesh 是同一方法里建的
      SomeModel.createBodyLayer()                   ← 进类里看它 return 什么
    """
    if depth > 6:
        return None
    text = expr.strip()
    transforms = []
    while True:
        m = re.search(r'\.apply\s*\(', text)
        if not m:
            break
        inner, nxt = read_balanced(text, m.end())
        transforms.append(inner.strip())
        text = (text[:m.start()] + text[nxt:]).strip()

    # 引用前面定义好的局部变量（felineBodyLayer / spiderBodyLayer）
    if locals_ and re.fullmatch(r'\w+', text) and text in locals_:
        found = dict(locals_[text])
        found['transforms'] = transforms + found['transforms']
        return found

    if text.startswith('LayerDefinition.create'):
        inner, _ = read_balanced(text, text.find('(') + 1)
        args = split_args(inner)
        if len(args) < 3:
            return None
        mesh = args[0].strip()
        tex_w, tex_h = int(num(args[-2])), int(num(args[-1]))
        sub = parse_layer_expr(mesh, ctx_cls, ctx_method, depth + 1, locals_)
        if sub is None:
            if ctx_cls and ctx_method:
                return {'cls': ctx_cls, 'method': ctx_method, 'args': [],
                        'texW': tex_w, 'texH': tex_h, 'transforms': transforms}
            return None
        sub['texW'] = tex_w
        sub['texH'] = tex_h
        sub['transforms'] = transforms + sub['transforms']
        return sub

    m = re.match(r'(\w+)\.(\w+)\s*\(', text)
    if m:
        cls, method = m.group(1), m.group(2)
        inner, _ = read_balanced(text, m.end())
        args = split_args(inner)
        body = all_methods(cls).get(method)
        if not body:
            return None
        ret, _params, code = body
        if ret == 'MeshDefinition':
            return {'cls': cls, 'method': method, 'args': args,
                    'texW': None, 'texH': None, 'transforms': transforms}
        for node in statements(code):
            if node[0] != 'stmt' or not node[1].startswith('return'):
                continue
            found = parse_layer_expr(node[1][len('return'):].strip(), cls, method, depth + 1, locals_)
            if found:
                found['transforms'] = transforms + found['transforms']
                return found
        return None
    return None


def find_mesh_expr(code):
    """从 createBodyMesh 方法体里还原出"怎么建这棵树"的调用表达式"""
    m = re.search(r'return\s+(\w+)\s*;', code)
    if not m:
        return None
    var = m.group(1)
    # return root; → 找 root 是从哪个 mesh 出来的
    m2 = re.search(r'PartDefinition\s+%s\s*=\s*(\w+)\.getRoot\s*\(' % var, code)
    if m2:
        mesh_var = m2.group(1)
        m3 = re.search(r'MeshDefinition\s+%s\s*=\s*new\s+MeshDefinition' % mesh_var, code)
        if m3:
            return 'INLINE:' + code
    return 'INLINE:' + code


def transformer_scale(expr):
    """MeshTransformer → (scale, yOffset)。识别不了返回 None（不做缩放）"""
    text = expr.strip()
    m = re.search(r'MeshTransformer\.scaling\s*\(', text)
    if m:
        inner, _ = read_balanced(text, m.end())
        factor = num(split_args(inner)[0])
        # @constraint 0 或负数一律当解析失败：缩放为 0 的模型会直接消失，
        #              宁可退回原始尺寸也不要整只生物不见。
        if not (0.05 <= factor <= 20.0):
            return None
        return (factor, 24.016 * (1.0 - factor))
    m = re.match(r'(\w+)\.(\w+)$', text)
    if m:
        src = class_src(m.group(1)) or ''
        hit = re.search(r'static\s+final\s+MeshTransformer\s+%s\s*=\s*(.+?);' % m.group(2), src)
        if hit:
            return transformer_scale(hit.group(1))
    return None


def parse_layer_defs():
    """
    LayerDefinitions.createRoots() → layer 名 → 图层信息

    @constraint 必须先收全部局部变量再解析 put：绝大多数实体写的是
      `LayerDefinition catBody = ...; result.put(ModelLayers.CAT, catBody.apply(...))`，
      单遍扫描时 put 那一行还查不到 catBody。
    """
    src = class_src('LayerDefinitions')
    if not src:
        return {}
    at = src.find('createRoots')
    body, _ = read_block(src, src.find('{', at) + 1)

    entries = []
    for node in statements(body):
        if node[0] != 'stmt':
            continue
        stmt = node[1]
        m = re.match(r'LayerDefinition\s+(\w+)\s*=\s*(.+)$', stmt)
        if m:
            entries.append(('var', m.group(1), m.group(2)))
            continue
        m = re.match(r'result\.put\s*\(\s*\(Object\)\s*ModelLayers\.(\w+)\s*,\s*\(Object\)\s*(.+)\)$', stmt)
        if m:
            entries.append(('put', m.group(1), m.group(2)))

    locals_ = {}
    defs = {}
    for _round in range(3):
        for kind, key, expr in entries:
            if kind == 'var':
                if key in locals_:
                    continue
                info = parse_layer_expr(expr, None, None, 0, locals_)
                if info:
                    locals_[key] = info
            else:
                if ('@' + key) in defs:
                    continue
                info = parse_layer_expr(expr, None, None, 0, locals_)
                if info:
                    defs['@' + key] = info
    return defs


# ---------------------------------------------------------------- 贴图

def png_size(path):
    if not path or not os.path.exists(path):
        return None
    with open(path, 'rb') as fh:
        head = fh.read(24)
    if len(head) < 24 or head[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', head[16:24])


_tex_index = None


def tex_index():
    """
    textures/entity 下的 stem → 贴图相对路径索引。

    @why 原实现每匹配一个模型就 os.walk 一遍整棵贴图树，263 个模型等于 263 次
          全盘遍历；建一次索引后全是字典查找，提取时间从十几秒降到两秒。
    """
    global _tex_index
    if _tex_index is not None:
        return _tex_index
    idx = {}
    ent = os.path.join(TEXTURES, 'entity')
    if os.path.isdir(ent):
        for dirpath, _dirs, files in os.walk(ent):
            rel = os.path.relpath(dirpath, ent).replace(os.sep, '/')
            for name in files:
                if name.endswith('.png'):
                    idx.setdefault(name[:-4], []).append(f'entity/{rel}/{name[:-4]}')
    _tex_index = idx
    return idx


# 贴图名与模型层键对不上的特例。
#
# @why 这些名字来自各渲染器的 getTextureLocation，跟 ModelLayers 的键毫无关系，
#      靠字符串推断不出来：armor_stand 的贴图叫 armorstand、chest 的叫 normal、
#      骷髅马叫 horse_skeleton。宁可写死一张表，也不要靠猜。
TEXTURE_ALIAS = {
    'armor_stand': ('entity/armorstand/armorstand',),
    'armor_stand_small': ('entity/armorstand/armorstand',),
    'chest': ('entity/chest/normal',),
    'chest_minecart': ('entity/chest/normal',),
    'command_block_minecart': ('entity/minecart/minecart',),
    'furnace_minecart': ('entity/minecart/minecart',),
    'hopper_minecart': ('entity/minecart/minecart',),
    'spawner_minecart': ('entity/minecart/minecart',),
    'tnt_minecart': ('entity/minecart/minecart',),
    'skeleton_horse': ('entity/horse/horse_skeleton',),
    'skeleton_horse_baby': ('entity/horse/horse_skeleton_baby', 'entity/horse/horse_skeleton'),
    'zombie_horse': ('entity/horse/horse_zombie',),
    'zombie_horse_baby': ('entity/horse/horse_zombie_baby', 'entity/horse/horse_zombie'),
    'donkey': ('entity/horse/donkey',),
    'mule': ('entity/horse/mule',),
    'book': ('entity/enchantment/enchanting_table_book',),
    'ender_dragon': ('entity/enderdragon/dragon',),
    'elder_guardian': ('entity/guardian/guardian_elder',),
    'giant': ('entity/zombie/zombie',),
    'magma_cube': ('entity/slime/magmacube',),
    'slime_outer': ('entity/slime/slime',),
    'polar_bear': ('entity/bear/polarbear',),
    'polar_bear_baby': ('entity/bear/polarbear_baby',),
    'leash_knot': ('entity/lead_knot/lead_knot',),
    'shulker_box': ('entity/shulker/shulker',),
    'shulker_bullet': ('entity/shulker/shulker',),
    'wither_skull': ('entity/wither/wither',),
    'wither_skeleton_skull': ('entity/skeleton/wither_skeleton',),
    'skeleton_skull': ('entity/skeleton/skeleton',),
    'zombie_head': ('entity/zombie/zombie',),
    'creeper_head': ('entity/creeper/creeper',),
    'piglin_head': ('entity/piglin/piglin',),
    'player_head': ('entity/player/wide/steve',),
    'dragon_skull': ('entity/enderdragon/dragon',),
    'conduit': ('entity/conduit/break_particle', 'entity/conduit/base'),
    # @why 旗帜模型的旗杆 texOffs(44,0) 只有 banner_base.png 画到了，
    #      base.png 是纯旗面图案（内容到 42×41），拿它当底图旗杆整根透明
    'standing_banner': ('entity/banner/banner_base',),
    'wall_banner': ('entity/banner/banner_base',),
    'standing_banner_flag': ('entity/banner/banner_base',),
    'wall_banner_flag': ('entity/banner/banner_base',),
    'boat_water_patch': ('entity/boat/oak',),
    'cushion': ('entity/cushion/white_cushion',),
    'copper_golem_running': ('entity/copper_golem/copper_golem',),
    'copper_golem_sitting': ('entity/copper_golem/copper_golem',),
    'copper_golem_star': ('entity/copper_golem/copper_golem',),
    'sulfur_cube': ('entity/sulfur_cube/sulfur_cube_outer',),
    'sulfur_cube_small': ('entity/sulfur_cube/sulfur_cube_outer_small',),
    'sulfur_cube_small_inner': ('entity/sulfur_cube/sulfur_cube_inner_small',),
    'warden_tendrils': ('entity/warden/warden',),
    'end_crystal': ('entity/end_crystal/end_crystal',),
    'chest_minecart': ('entity/chest/normal',),
    'double_chest_left': ('entity/chest/normal_left',),
    'double_chest_right': ('entity/chest/normal_right',),
    'parched_outer_layer': ('entity/skeleton/parched',),
    'sheep_baby_wool': ('entity/sheep/sheep_wool_baby',),
    'cat_baby_collar': ('entity/cat/cat_collar_baby',),
    'sniffer_baby': ('entity/sniffer/snifflet',),
    'villager_no_hat': ('entity/villager/villager',),
    'villager_baby_no_hat': ('entity/villager/villager_baby',),
    'zombie_villager_no_hat': ('entity/zombie_villager/zombie_villager',),
    'zombie_villager_baby_no_hat': ('entity/zombie_villager/zombie_villager_baby',),
    'player': ('entity/player/wide/steve',),
    'player_ears': ('entity/player/wide/steve',),
    'player_cape': ('entity/player/wide/steve',),
    'player_spin_attack': ('entity/player/wide/steve',),
    'player_head': ('entity/player/wide/steve',),
    'player_slim': ('entity/player/slim/steve',),
    'pufferfish_big': ('entity/fish/pufferfish',),
    'pufferfish_medium': ('entity/fish/pufferfish',),
    'pufferfish_small': ('entity/fish/pufferfish',),
    'salmon_small': ('entity/fish/salmon',),
    'salmon_large': ('entity/fish/salmon',),
    # @constraint 名字是反的：TropicalFishRenderer 里 SMALL_TEXTURE = tropical_a.png、
    #      LARGE_TEXTURE = tropical_b.png。按字面猜会把大鱼的 UV 全部采到空白区，
    #      渲染出来只剩几个白点。
    'tropical_fish_large': ('entity/fish/tropical_b',),
    'tropical_fish_large_pattern': ('entity/fish/tropical_b_pattern_1',),
    'tropical_fish_small': ('entity/fish/tropical_a',),
    'tropical_fish_small_pattern': ('entity/fish/tropical_a_pattern_1',),
    # 装备贴图在 equipment/<kind>/<variant> 下，ModelLayers 的键只到 kind
    'skeleton_horse_saddle': ('entity/equipment/skeleton_horse_saddle/saddle',),
    'zombie_horse_saddle': ('entity/equipment/zombie_horse_saddle/saddle',),
    'horse_saddle': ('entity/equipment/horse_saddle/saddle',),
    'pig_saddle': ('entity/equipment/pig_saddle/saddle',),
    'strider_saddle': ('entity/equipment/strider_saddle/saddle',),
    'camel_saddle': ('entity/equipment/camel_saddle/saddle',),
    'camel_husk_saddle': ('entity/equipment/camel_husk_saddle/saddle',),
    'donkey_saddle': ('entity/equipment/donkey_saddle/saddle',),
    'mule_saddle': ('entity/equipment/mule_saddle/saddle',),
    'horse_armor': ('entity/equipment/horse_body/iron',),
    'undead_horse_armor': ('entity/equipment/horse_body/iron',),
    'llama_decor': ('entity/equipment/llama_body/brown',),
    'llama_baby_decor': ('entity/equipment/llama_body/brown',),
    'happy_ghast_harness': ('entity/equipment/happy_ghast_body/brown_harness',),
    'happy_ghast_baby_harness': ('entity/equipment/happy_ghast_body/brown_harness',),
    'elytra_baby': ('entity/equipment/wings/elytra',),
}


def _lookup(stem, baby=None):
    """stem 精确或前缀匹配；baby 指定是否必须命中幼体贴图"""
    best = None
    for s, paths in tex_index().items():
        if s != stem and not s.startswith(stem + '_'):
            continue
        for path in paths:
            # @why 目录名必须逐条参与排序：creeper 既是生物也是旗帜图案，
            #      只按文件名匹配会拿到 entity/banner/creeper（64×64 的旗帜底图），
            #      整只苦力怕变成白色碎片
            folder = path.split('/')[1]
            score = (
                0 if s == stem else 1,
                0 if folder == stem else 1,
                0 if (baby is None or s.endswith('_baby') == baby) else 1,
                0 if any(t in s for t in ('temperate', 'brown', 'normal', 'tabby')) else 1,
                len(s),
            )
            if best is None or score < best[0]:
                best = (score, path)
    return best[1] if best else None


LAYER_SUFFIX = (
    '_outer_layer', '_outer', '_inner', '_overlay', '_tendrils', '_ropes',
    '_harness', '_decor', '_saddle', '_armor', '_flag', '_pattern',
)


def texture_candidates(key):
    """按优先级产出候选贴图路径（尚未做尺寸校验）"""
    out = []

    def add(path):
        if path and path not in out:
            out.append(path)

    for path in TEXTURE_ALIAS.get(key, ()):
        add(path)

    # boat/oak、chest_boat/oak：键本身就是贴图的相对路径
    if '/' in key:
        add('entity/' + key)
    # oak_boat → entity/boat/oak，bamboo_chest_raft → entity/chest_boat/bamboo
    for pattern, folder in (
        (r'(.+)_chest_boat$', 'chest_boat'),
        (r'(.+)_chest_raft$', 'chest_boat'),
        (r'(.+)_boat$', 'boat'),
        (r'(.+)_raft$', 'boat'),
    ):
        wood = re.match(pattern, key)
        if wood:
            add(f'entity/{folder}/{wood.group(1)}')

    stems = []

    def push(stem):
        if stem and stem not in stems:
            stems.append(stem)

    push(key)
    # cold_pig → pig_cold：MC 的贴图命名是 <mob>_<climate>，模型键是 <climate>_<mob>
    climate = re.match(r'(cold|warm)_(.+)', key)
    if climate:
        mob = climate.group(2)
        if mob.endswith('_baby'):
            push(f'{mob[:-5]}_{climate.group(1)}_baby')
            push(mob[:-5])
        else:
            push(f'{mob}_{climate.group(1)}')
            push(mob)
    for suffix in LAYER_SUFFIX:
        if key.endswith(suffix):
            cut = key[: -len(suffix)]
            push(cut)
            push(cut + '_overlay')
    if key.endswith('_baby'):
        push(key[:-5])

    baby = key.endswith('_baby')
    for stem in stems:
        if '/' in stem:
            continue
        add(_lookup(stem, baby=True if baby else None))
        if baby:
            add(_lookup(stem, baby=None))
    return out


def match_texture(key, want=None):
    """
    在 textures/entity 下找对应皮肤，返回 (路径, 整数倍数, 实际尺寸)。

    @constraint 贴图尺寸必须是模型声明尺寸的整数倍，且横纵倍数相同：UV 全是
          绝对像素坐标，拿 64×64 的成年贴图去配 32×32 的幼年模型，整只生物
          都是错位的色块；而 128×64 的贴图配 64×32 的模型只是 2 倍分辨率，
          把 UV 同样放大 2 倍即可，不算错。其余情况宁可留空。
    """
    for path in texture_candidates(key):
        size = png_size(os.path.join(TEXTURES, path + '.png'))
        if not size:
            continue
        if want and all(want):
            if size[0] < want[0] or size[1] < want[1]:
                # 贴图比模型声明的还小，说明配错了对象
                continue
            if size[0] % want[0] == 0 and size[1] % want[1] == 0:
                sx, sy = size[0] // want[0], size[1] // want[1]
                if sx == sy:
                    return path, sx, size
            # 非等比（贴图右侧/下方留白）：UV 仍按模型声明尺寸归一化
            return path, 1, None
        return path, 1, size
    if os.environ.get('TEX_DEBUG'):
        print(f'  [tex] {key} want={want} 候选={texture_candidates(key)}', file=sys.stderr)
    return None, 1, None


# ---------------------------------------------------------------- 主流程

def snake(name):
    return re.sub(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', '_', name).lower()


def flatten(parts, root):
    """树 → 扁平列表，父部件一定排在子部件前面"""
    out = []

    def walk(idx, parent_name):
        node = parts[idx]
        out.append({
            'name': node['name'] or 'root',
            'parent': parent_name,
            'pos': [round(v, 4) for v in node['pose'][:3]],
            'rot': [round(v, 5) for v in node['pose'][3:6]],
            'scale': [round(v, 4) for v in node['pose'][6:9]],
            'boxes': [{
                'uv': b['uv'],
                'from': [round(v, 4) for v in b['from']],
                'size': [round(v, 4) for v in b['size']],
                # 未膨胀尺寸，只用于算 UV；见 parse_cubes 里的说明。没膨胀的盒子不写，
                # 省下的 50KB 在首屏是实打实的解析时间
                **({'base': [round(v, 4) for v in b['base']]} if b.get('base') != b['size'] else {}),
                'mirror': b['mirror'],
                'faces': b['faces'],
            } for b in node['cubes']],
        })
        for child in node['children']:
            walk(child, node['name'] or 'root')

    walk(root, None)
    return out


def build_model(layer_id, info, tex_key, tex_scale=1, tex_size=None):
    ctx = Ctx()
    root = run_method(info['cls'], info['method'], {}, ctx, [eval_arg(a, {}) for a in info['args']])
    if root is None:
        return None

    scale = None
    for t in info['transforms']:
        got = transformer_scale(t)
        if got:
            scale = got
    if scale and scale[0] != 1.0:
        factor, y_shift = scale
        pose = list(ctx.parts[root]['pose'])
        pose[0] *= factor
        pose[1] = pose[1] * factor + y_shift
        pose[2] *= factor
        pose[6] *= factor
        pose[7] *= factor
        pose[8] *= factor
        ctx.parts[root]['pose'] = tuple(pose)

    parts = flatten(ctx.parts, root)
    if len(parts) <= 1 and not parts[0]['boxes']:
        return None

    if tex_scale != 1:
        # 高清贴图：模型按 64×32 声明，贴图是 128×64，UV 同步放大后归一化结果不变
        for part in parts:
            for box in part['boxes']:
                box['uv'] = [round(v * tex_scale, 4) for v in box['uv']]

    return {
        'texW': (tex_size[0] if tex_size else None) or info['texW'] or 64,
        'texH': (tex_size[1] if tex_size else None) or info['texH'] or 32,
        'texture': tex_key,
        'parts': parts,
        'warn': ctx.warnings[:4],
    }


def layer_paths():
    """
    ModelLayers.CONST → 规范化图层键（与 extract-renderers.py 保持一致）。

    register("pig")           → 'pig'
    register("camel","saddle")→ 'camel:saddle'
    register("boat/oak")      → 'boat/oak'

    @why 前端只有这一个键（渲染器里 bakeLayer 的那个），模型表必须能用同一个键查，
          否则船的 'boat/oak' 会全部落空。
    """
    src = class_src('ModelLayers') or ''
    table = {}
    for m in re.finditer(
            r'public static final ModelLayerLocation (\w+)\s*=\s*ModelLayers\.register\("([^"]+)"(?:,\s*"([^"]+)")?\)',
            src):
        table[m.group(1)] = m.group(2) if not m.group(3) else m.group(2) + ':' + m.group(3)
    return table


def main():
    load_name_consts()
    load_array_consts()
    defs = parse_layer_defs()
    print('LayerDefinitions 解析到', len([k for k in defs if not k.startswith('@')]), '个局部变量 /',
          len([k for k in defs if k.startswith('@')]), '个 layer 绑定')

    paths = layer_paths()
    models = {}
    by_class = {}
    by_layer = {}
    missing = []

    for key, found in defs.items():
        if not key.startswith('@'):
            continue
        const = key[1:]
        layer = const.lower()
        if not found:
            missing.append(layer)
            continue
        tex_key, tex_scale, tex_size = match_texture(layer, (found.get('texW'), found.get('texH')))
        built = build_model(layer, found, tex_key, tex_scale, tex_size)
        if not built:
            missing.append(layer)
            continue
        models[layer] = built
        by_class.setdefault(found['cls'], layer)
        if const in paths:
            by_layer[paths[const]] = layer

    # 类名索引：前端拿到渲染器的模型类名后回落到这里
    for cls_name, layer in by_class.items():
        models.setdefault('@' + snake(cls_name), layer)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = {
        'models': {k: v for k, v in models.items() if not k.startswith('@')},
        'byClass': {k[1:]: v for k, v in models.items() if k.startswith('@')},
        'byLayer': by_layer,
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, separators=(',', ':'))

    print('提取', len(payload['models']), '个模型，类名索引', len(payload['byClass']))
    for k in ['cat', 'ghast', 'horse', 'wolf', 'zombie', 'chicken']:
        if k in payload['models']:
            item = payload['models'][k]
            print(f"  {k:<10} tex={item['texW']}x{item['texH']} 部件={len(item['parts'])} "
                  f"盒={sum(len(p['boxes']) for p in item['parts'])} 贴图={item['texture']}")
    if missing:
        print('未解析', len(missing), '个：', missing[:12])


if __name__ == '__main__':
    main()
