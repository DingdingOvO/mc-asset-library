#!/usr/bin/env python3
"""
从反编译的 Minecraft 源码里提取实体动画（setupAnim）。

@why 实体的动作不是资源包数据，而是硬编码在 *Model.java 的 setupAnim 里：
      this.rightHindLeg.xRot = Mth.cos(animationPos * 0.6662f) * 1.4f * animationSpeed;
      要做出和游戏一模一样的动作，只能把这段逻辑抄出来，而不是凭感觉调参数。

@constraint 不追求通用 Java 解析器：只转译「赋值 / 局部变量 / if-else」三类语句，
      遇到方法调用、循环就整块跳过。跳过会丢一点细节（比如手持物品的姿势），
      但腿、头、翅膀这些主运动全部保留，且永远不会生成错误代码。

@why 还要额外内联 AnimationUtils 的静态方法：僵尸的前平举、猪灵的持械姿势
      都不在 *Model 里，而是 this.setupAttackAnimation() 调
      AnimationUtils.animateZombieArms() 设的。只抄 setupAnim 会得到
      "僵尸像正常人一样甩胳膊"，而这正是之前所有亡灵动作看起来不对的根源。

输入：CFR 反编译后的 net/minecraft/client/model 目录
输出：entityanims.json
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/modelsrc/net/minecraft/client/model'
# 输出进 mc-derived：动画来自反编译的 setupAnim，官方 jar 里没有
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'mc-derived', VERSION, 'entityanims.json')

# 基础类型 / 常见类型，用于把 "float x = 1.0f;" 识别成变量声明
PRIMITIVES = {'float', 'double', 'int', 'boolean', 'byte', 'short', 'long'}

AXIS = r'(?:xRot|yRot|zRot|x|y|z|xScale|yScale|zScale|visible)'

ASSIGN_RE = re.compile(
    r'^(?:this\.)?(\w+)\.' + AXIS + r'\s*(?:\+|-|\*|/)?=\s*.+$'
)
DECL_RE = re.compile(r'^(?:final\s+)?(?:%s)\s+\w+\s*=\s*.+$' % '|'.join(PRIMITIVES))
# 任意引用类型的声明：PiglinArmPose pose = state.armPose;
# @why 不声明它，pose 就成了未知标识符——而未知值和未知枚举比相等会走错分支
#      （猪灵因此一直在跳胜利之舞）。声明成 let 之后至少是"未知 ≠ 未知"。
DECL_ANY_RE = re.compile(r'^(?:final\s+)?([A-Za-z_]\w*(?:<[^>]*>)?(?:\[\])?)\s+(\w+)\s*=\s*(.+);$', re.S)
DECL_BARE_RE = re.compile(r'^(?:[A-Z]\w*(?:<[^>]*>)?)\s+\w+;$')
# `float speed;` / `boolean flag;` —— 只声明不赋值，后面在 if 里才赋值
PRIM_BARE_RE = re.compile(r'^(float|double|int|long|var|boolean|String)\s+(\w+);$')
# 局部变量赋值（不是部件）：speed = state.ageInTicks * 120.0f;
LOCAL_SET_RE = re.compile(r'^(\w+)\s*=\s*(.+);$', re.S)


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    text = re.sub(r'//[^\n]*', '', text)
    return text


def split_members(body):
    """把类体按顶层 {} 切分，返回 [(header, body)] 供找方法与字段用"""
    out = []
    depth = 0
    start = 0
    i = 0
    n = len(body)
    seg_start = 0
    while i < n:
        ch = body[i]
        if ch == '{':
            if depth == 0:
                header = body[seg_start:i]
                inner_start = i + 1
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                out.append((header, body[inner_start:i]))
                seg_start = i + 1
        i += 1
    return out


def _skip_ws(text, i):
    n = len(text)
    while i < n and text[i].isspace():
        i += 1
    return i


def parse_one(text, i):
    """解析一条语句，返回 ((节点), 下一个位置)"""
    i = _skip_ws(text, i)
    n = len(text)
    if i >= n:
        return None, i

    # 块
    if text[i] == '{':
        stmts, j = parse_statements(text, i + 1, stop_at_brace=True)
        return ('block', stmts), j

    # if
    if text.startswith('if', i) and not re.match(r'\w', text[i + 2:i + 3] or ' '):
        j = i + 2
        while j < n and text[j] != '(':
            j += 1
        depth = 0
        start = j
        while j < n:
            if text[j] == '(':
                depth += 1
            elif text[j] == ')':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        cond = text[start + 1:j]
        then_node, k = parse_one(text, j + 1)
        then_block = then_node[1] if then_node and then_node[0] == 'block' else ([then_node] if then_node else [])
        k2 = _skip_ws(text, k)
        else_block = None
        if text.startswith('else', k2):
            else_node, k3 = parse_one(text, k2 + 4)
            else_block = else_node[1] if else_node and else_node[0] == 'block' else ([else_node] if else_node else [])
            k = k3
        return ('if', 'if (%s)' % cond.strip(), then_block, else_block), k

    # for：循环体里是触手、龙颈、蠹虫体节，不认这个节点，body 会被摊平到
    # 外层，循环变量 i 变成未知量，整段动作按字面量只跑一遍
    if text.startswith('for', i) and not re.match(r'\w', text[i + 3:i + 4] or ' '):
        j = i + 3
        while j < n and text[j] != '(':
            j += 1
        depth = 0
        start = j
        while j < n:
            if text[j] == '(':
                depth += 1
            elif text[j] == ')':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        header = 'for (%s)' % text[start + 1:j].strip()
        body_node, k = parse_one(text, j + 1)
        body = body_node[1] if body_node and body_node[0] == 'block' else ([body_node] if body_node else [])
        return ('for', header, body, None), k

    # 普通语句：读到分号
    j = text.find(';', i)
    if j < 0:
        return None, n
    return ('stmt', text[i:j + 1].strip()), j + 1


def parse_statements(text, start=0, stop_at_brace=False):
    """按 ; { } 把方法体切成语句树，返回 (语句列表, 结束位置)"""
    stmts = []
    i = start
    n = len(text)
    while i < n:
        i = _skip_ws(text, i)
        if i >= n:
            break
        if text[i] == '}':
            if stop_at_brace:
                return stmts, i + 1
            i += 1
            continue
        node, i = parse_one(text, i)
        if node is None:
            continue
        if node[0] == 'block':
            stmts.extend(node[1])
        else:
            stmts.append(node)
    return stmts, i


ESCAPE_RE = re.compile(r'\(\((\w*RenderState)\)state\)')


def conv_expr(expr, fields):
    e = expr
    e = ESCAPE_RE.sub('state', e)
    e = re.sub(r'\((?:float|double|int|byte|short|long)\)\s*', '', e)
    e = re.sub(r'\b(\d+(?:\.\d+)?)[fFdDlL]\b', r'\1', e)
    e = e.replace('Mth.', 'MC.')
    # AnimationUtils 的方法由前端注入成 ANIM 命名空间，调用点原样转发
    e = e.replace('AnimationUtils.', 'ANIM.')
    e = e.replace('Math.PI', 'Math.PI')
    # 字段名保持 camelCase，前端会给 p 对象挂同义键
    e = re.sub(r'\bthis\.', 'p.', e)
    e = re.sub(r'!=(?!=)', '!==', e)
    e = re.sub(r'(?<![!<>])==(?!=)', '===', e)
    return e


# @constraint 用整词匹配而不是子串：HumanoidModel.ArmPose.THROW_TRIDENT 里含
#      "throw"，子串匹配会把整条 if 判成不可转译，animateZombieArms 的赋值
#      于是整块消失——僵尸的手还是抬不起来。
BAD_RE = re.compile(r'\b(?:new|switch|while|for|return|throw)\b|->|\.setupAnim\(')


CALL_RE = re.compile(r'\b([A-Za-z_]\w*)\.(\w+)\s*\(')
BAD_BODY = re.compile(r'\b(?:switch|case|while|try|catch|default)\b|\bbreak\b|\bcontinue\b')
SAFE_RECV = {'state', 'Mth', 'MC', 'Math', 'AnimationUtils'}


def is_transpilable_stmt(stmt, fields, calls=None, cls=None):
    """判断一行语句能否安全转成 JS"""
    if BAD_RE.search(stmt):
        return False
    # @constraint 不是"有没有方法调用"，而是"每个方法调用是否都认识"。
    #      只查一个白名单前缀会漏判：`Mth.cos(x) + this.foo(y)` 里那个 foo 转成
    #      JS 之后是 p.foo(y)，哑部件不可调用，整只生物的动作代码直接抛错。
    for m in CALL_RE.finditer(stmt):
        recv, fname = m.group(1), m.group(2)
        if recv in SAFE_RECV:
            continue
        key = '%s.%s' % (cls if recv == 'this' else recv, fname)
        if calls and key in calls:
            continue
        return False
    return True


def transpile(stmts, fields, out, indent=0, prefix='p.', allow_return=False, calls=None, cls=None):
    """
    @param prefix 部件变量的前缀。类里的 setupAnim 写 this.rightArm，模型部件
                  从 p 上取所以是 'p.'；AnimationUtils 里的静态方法收的就是
                  ModelPart 形参本身，不能再加前缀，传 ''。
    @param allow_return 只有独立成函数的方法（AnimationUtils、setupAttackAnimation）
                  才能保留 return：setupAnim 是多个类的代码拼成一段，
                  中间冒出一个 return 会把后半段整条吃掉。
    """
    ok = True
    pad = '  ' * indent
    for node in stmts:
        if node[0] == 'stmt':
            stmt = node[1]
            if allow_return and re.match(r'^return;$', stmt):
                out.append('%sreturn;' % pad)
                continue
            # @why 返回常量的辅助方法必须真的返回：AbstractEquineModel 的
            #      getLegStandingYOffset() { return 12.0f; } 被跳过就返回 undefined，
            #      马的站立姿势 `y -= undefined * standing` 直接变 NaN，四条腿飞掉。
            if allow_return:
                m = re.match(r'^return\s+(.+);$', stmt, re.S)
                if m:
                    out.append('%sreturn %s;' % (pad, conv_expr(m.group(1), fields)))
                    continue
            # @why setupAttackAnimation 必须真的调用：僵尸/猪灵的手臂姿势全在
            #      它里面，跳过就等于把亡灵变成普通人。
            m = re.match(r'^(?:this\.)?setupAttackAnimation\((.+)\);$', stmt, re.S)
            if m:
                out.append('%sANIM.setupAttackAnimation(%s);' % (pad, conv_expr(m.group(1), fields)))
                continue
            # 父类的实现在分层里是另一个函数，占位符交给前端换成上一层
            m = re.match(r'^super\.setupAttackAnimation\((.+)\);$', stmt, re.S)
            if m:
                out.append('%s__parent(%s);' % (pad, conv_expr(m.group(1), fields)))
                continue
            # 关键帧状态动画：this.flyingAnimation.apply(state.flyAnimationState, ageInTicks)
            m = re.match(r'^this\.(\w+)\.apply\((.+)\);$', stmt, re.S)
            if m:
                target_def = None if cls is None else field_defs(cls).get(m.group(1))
                if target_def:
                    if cls in _APPLIED:
                        out.append('%s/* skip: %s 与主状态互斥 */' % (pad, target_def))
                    else:
                        _APPLIED.add(cls)
                        out.append('%s__kfApply(%s);' % (pad, json.dumps(target_def)))
                    continue
            # 关键帧行走：this.walkAnimation.applyWalk(pos, speed, factor, scale)
            m = re.match(r'^this\.(\w+)\.applyWalk\((.+)\);$', stmt, re.S)
            if m:
                target_def = walk_def_for(cls, m.group(1))
                if target_def:
                    out.append('%s__kfWalk(%s, %s);' % (
                        pad, json.dumps(target_def), conv_expr(m.group(2), fields)))
                    continue
            if not is_transpilable_stmt(stmt, fields, calls, cls):
                out.append('%s/* skip: %s */' % (pad, stmt.strip()[:70]))
                continue
            # 静态动画工具：调用点原样转发到 ANIM 命名空间
            m = re.match(r'^AnimationUtils\.(\w+)\((.*)\);$', stmt, re.S)
            if m:
                out.append('%sANIM.%s(%s);' % (pad, m.group(1), conv_expr(m.group(2), fields)))
                continue
            # 白名单里的辅助方法调用：原样转发，稍后统一换成内联函数名
            if CALL_RE.search(stmt) and not re.search(r'(?<![=!<>])=(?!=)', stmt):
                out.append(pad + conv_expr(stmt, fields))
                continue
            if DECL_RE.match(stmt):
                name, value = re.match(r'^(?:final\s+)?(?:\w+)\s+(\w+)\s*=\s*(.+);$', stmt, re.S).groups()
                out.append('%slet %s = %s;' % (pad, name, conv_expr(value, fields)))
                continue
            # 引用/枚举类型声明。只认首字母大写的类型名，避免把
            # `p.head = foo;` 这种部件赋值误当声明
            m = DECL_ANY_RE.match(stmt)
            if m and m.group(1)[0].isupper():
                out.append('%slet %s = %s;' % (pad, m.group(2), conv_expr(m.group(3), fields)))
                continue
            if DECL_BARE_RE.match(stmt):
                name = re.match(r'^[A-Z]\w*(?:<[^>]*>)?\s+(\w+);$', stmt).group(1)
                out.append('%slet %s = 0;' % (pad, name))
                continue
            # @why 只声明不赋值是常态（`float speed;` 然后在 if 里算），
            #      跳过声明会让后面的赋值也一起失效——蜜蜂翅膀、悦灵飘浮全靠这个。
            m = PRIM_BARE_RE.match(stmt)
            if m:
                zero = 'false' if m.group(1) == 'boolean' else ('""' if m.group(1) == 'String' else '0')
                out.append('%slet %s = %s;' % (pad, m.group(2), zero))
                continue
            m = LOCAL_SET_RE.match(stmt)
            if m and not m.group(1)[0].isupper():
                out.append('%s%s = %s;' % (pad, m.group(1), conv_expr(m.group(2), fields)))
                continue
            # 数组元素上的部件：this.tentacles[i].xRot = ...
            m = re.match(r'^(?:this\.)?(\w+)\s*\[(\w+)\]\s*\.\s*(' + AXIS + r')\s*(\+|-|\*|/)?=\s*(.+);$', stmt, re.S)
            if m:
                out.append('%s%s%s[%s].%s %s= %s;' % (
                    pad, prefix, m.group(1), conv_expr(m.group(2), fields), m.group(3),
                    m.group(4) or '', conv_expr(m.group(5), fields)))
                continue
            if re.match(r'^(?:this\.)?\w+\.' + AXIS + r'\s*(?:\+|-|\*|/)?=', stmt):
                m = re.match(r'^(?:this\.)?(\w+)\.((?:xRot|yRot|zRot|x|y|z|xScale|yScale|zScale|visible))\s*(\+|-|\*|/)?=\s*(.+);$', stmt, re.S)
                if not m:
                    out.append('%s/* skip: %s */' % (pad, stmt.strip()[:70]))
                    continue
                part, axis, op, value = m.groups()
                code = '%s%s.%s %s= %s;' % (prefix, part, axis, op or '', conv_expr(value, fields))
                out.append(pad + code.replace('  =', ' ='))
                continue
            out.append('%s/* skip: %s */' % (pad, stmt.strip()[:70]))
            continue

        # for 循环：触手、肋骨、龙颈、蠹虫体节都是循环摆的
        _, header, then_block, else_block = node
        head = header.strip()
        # 增强 for：for (ModelPart tentacle : this.tentacles)
        fm = re.match(r'^for\s*\(\s*[\w<>\[\].]+\s+(\w+)\s*:\s*(.+)\)$', head, re.S)
        if fm:
            var, src = fm.group(1), conv_expr(fm.group(2), fields)
            out.append('%sfor (const %s of %s) {' % (pad, var, src))
            inner = []
            transpile(then_block, fields, inner, indent + 1, prefix, allow_return, calls, cls)
            # 循环变量本身就是部件对象，不能再加 p. 前缀
            out.extend(re.sub(r'\bp\.%s\b' % re.escape(var), var, line) for line in inner)
            out.append('%s}' % pad)
            continue
        fm = re.match(r'^for\s*\(\s*(?:int|byte|short)\s+(\w+)\s*=\s*(-?\d+)\s*;'
                      r'\s*\1\s*<\s*(.+?)\s*;\s*\+\+\1\s*\)$', head, re.S)
        if fm:
            var, start, limit = fm.group(1), fm.group(2), fm.group(3)
            bound = conv_expr(limit, fields)
            # 上限是数组长度就照抄长度判断，是数字就按数字走
            cond = '%s < %s' % (var, bound) if re.search(r'\w$', bound) else '%s < %s' % (var, bound)
            out.append('%sfor (let %s = %s; %s; %s++) {' % (pad, var, start, cond, var))
            transpile(then_block, fields, out, indent + 1, prefix, allow_return, calls, cls)
            out.append('%s}' % pad)
            continue

        m = re.match(r'^if\s*\((.+)\)$', header.strip(), re.S)
        if not m:
            out.append('%s/* skip block */' % pad)
            ok = False
            continue
        cond = m.group(1)
        if not is_transpilable_stmt(cond + ';', fields, calls, cls):
            out.append('%s/* skip conditional: %s */' % (pad, cond.strip()[:60]))
            continue
        out.append('%sif (%s) {' % (pad, conv_expr(cond, fields)))
        transpile(then_block, fields, out, indent + 1, prefix, allow_return, calls, cls)
        if else_block is not None:
            out.append('%s} else {' % pad)
            transpile(else_block, fields, out, indent + 1, prefix, allow_return, calls, cls)
        out.append('%s}' % pad)
    return ok


def load_animation_utils(src):
    """
    转译 AnimationUtils 里的静态方法。

    @why 僵尸/尸壳/溺尸/猪灵的手臂姿势不写在各自 *Model 里，而是
          setupAttackAnimation -> AnimationUtils.animateZombieArms(...)。
          不把这段抽出来，这些生物就会照抄 HumanoidModel 的走路甩臂，
          看起来"像正常人"，完全没有亡灵的样子。
    @return {方法名: {params: [...], code: '...'}}
    """
    path = os.path.join(src, 'AnimationUtils.java')
    if not os.path.exists(path):
        return {}
    raw = strip_comments(open(path, encoding='utf-8', errors='replace').read())
    head = re.search(r'class\s+AnimationUtils\s*\{', raw)
    if not head:
        return {}
    out_map = {}
    for header, inner in split_members(raw[head.end():]):
        sig = re.search(r'static\s+(?:<[^>]*>\s*)?[\w<>\[\]]+\s+(\w+)\s*\(([^)]*)\)', header)
        if not sig:
            continue
        name = sig.group(1)
        params = []
        for piece in sig.group(2).split(','):
            piece = piece.strip()
            if piece:
                params.append(re.sub(r'\[\]', '', piece).split()[-1])
        stmts, _ = parse_statements(inner)
        lines = []
        # prefix=''：静态方法收的就是 ModelPart 形参本身，不能再套 p.
        transpile(stmts, {}, lines, 0, '', True)
        out_map[name] = {'params': params, 'code': '\n'.join(lines)}
    return out_map


def attack_layers(name, models):
    """
    把一条继承链上的 setupAttackAnimation 按「父先子后」拆成若干层，一层一个函数。

    @why 不拼成一段：父类实现第一句是 `if (swingAnimation <= 0) return;`，
         拼起来后这个 return 会把子类的 animateZombieArms 一起跳过——
         僵尸的手臂姿势就永远不生效。分层成独立函数后 return 只退出自己那层，
         子类通过 __parent(state) 显式续接父层。
    """
    chain = []
    seen = set()
    cur = name
    while cur and cur not in seen and cur in models:
        seen.add(cur)
        chain.append(cur)
        cur = models[cur]['extends']
    chain.reverse()
    return [models[c]['attack'] for c in chain if models[c].get('attack') and models[c]['attack'].strip()]


# ------------------------------------------------------- 类内辅助方法内联
_CLASS_FILES = None
_DEFS = {}
_OWNERS = {}
# 类名 → 源码文本 / 父类名 / 构造参数 / 参数→字段
_RAWS = {}
_PARENT = {}
_PARAMS = {}
_PARAM_FIELD = {}
# 类名 → {字段: 关键帧定义名}；抽象父类 → {形参: 定义名}
_FIELD_DEF = {}
_PARAM_DEF = {}
# 已经取过主状态的类：一套动画里多路 apply 会抢同一批骨骼
_APPLIED = set()


# ------------------------------------------------------------ 关键帧动画定义
ANIM_DEF_SRC = '/tmp/animsrc/net/minecraft/client/animation/definitions'


def anim_definitions():
    """
    解析 net/minecraft/client/animation/definitions 里的 AnimationDefinition。

    @why 26.3 之后大部分动物不再用 setupAnim 里的三角函数，而是把动作写成关键帧
          （CAMEL_WALK、FROG_WALK…），模型只负责 this.walkAnimation.applyWalk(...)。
          不把这些关键帧搬过来，骆驼、青蛙、铜傀儡就永远只有头在动——腿是本体的。
    """
    defs = {}
    owners = {}
    if not os.path.isdir(ANIM_DEF_SRC):
        return defs, owners
    for name in sorted(os.listdir(ANIM_DEF_SRC)):
        if not name.endswith('Animation.java'):
            continue
        stem = name[:-5]
        raw = strip_comments(open(os.path.join(ANIM_DEF_SRC, name), encoding='utf-8', errors='replace').read())
        marks = [m.start() for m in re.finditer(r'public\s+static\s+final\s+AnimationDefinition\s+(\w+)\s*=', raw)]
        for index, start in enumerate(marks):
            end = marks[index + 1] if index + 1 < len(marks) else len(raw)
            chunk = raw[start:end]
            header = re.match(r'public\s+static\s+final\s+AnimationDefinition\s+(\w+)\s*=', chunk)
            def_name = header.group(1)
            length = re.search(r'withLength\(([\d.]+)', chunk)
            bones = {}
            for chan in re.finditer(r'\.addAnimation\(\s*"([^"]+)"\s*,\s*new\s+AnimationChannel\(', chunk):
                inner, _ = call_args(chunk, chan.end() - 1)
                target = 'ROTATION'
                if 'Targets.POSITION' in inner:
                    target = 'POSITION'
                elif 'Targets.SCALE' in inner:
                    target = 'SCALE'
                keys = []
                for key in re.finditer(
                        r'new\s+Keyframe\(\s*(-?[\d.]+)[fF]?\s*,\s*(?:\(Vector3fc\))?\s*'
                        r'KeyframeAnimations\.(\w+)\(([^)]*)\)\s*,\s*AnimationChannel\.Interpolations\.(\w+)',
                        inner):
                    stamp = float(key.group(1))
                    kind = key.group(2)
                    values = [float(piece.strip().rstrip('fF')) for piece in key.group(3).split(',')]
                    while len(values) < 3:
                        values.append(0.0)
                    if kind == 'degreeVec':
                        values = [value * 3.141592653589793 / 180 for value in values]
                    elif kind == 'posVec':
                        values[1] = -values[1]
                    elif kind == 'scaleVec':
                        values = [value - 1 for value in values]
                    keys.append([stamp] + values + [key.group(4).lower()])
                if keys:
                    bones[chan.group(1)] = {'target': target, 'keys': keys}
            if bones:
                defs[def_name] = {
                    'length': float(length.group(1)) if length else 1.0,
                    'loop': '.looping()' in chunk,
                    'bones': bones,
                }
                owners[def_name] = stem
    return defs, owners


def strip_switch(text):
    """
    删掉 switch(...) { ... } 整块，以及残留的 case / default / break 标签。

    @why 转译器只认「赋值 / 局部变量 / if-else」。switch 块被 parse_statements
          拍平之后，case 标签变成孤立语句，生成的是非法 JS——一行语法错误就让
          整只生物的动作代码编译失败（僵尸、骷髅、村民、猪灵集体变木偶）。
          宁可丢掉这几种持械姿势，也不能让整段动作消失。
    """
    out = []
    i = 0
    n = len(text)
    while i < n:
        m = re.compile(r'\bswitch\s*\(').search(text, i)
        if not m:
            out.append(text[i:])
            break
        out.append(text[i:m.start()])
        j = m.end() - 1
        depth = 0
        while j < n:
            if text[j] == '(':
                depth += 1
            elif text[j] == ')':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        k = text.find('{', j)
        if k < 0:
            i = j + 1
            continue
        depth = 0
        while k < n:
            if text[k] == '{':
                depth += 1
            elif text[k] == '}':
                depth -= 1
                if depth == 0:
                    k += 1
                    break
            k += 1
        i = k
    joined = '\n'.join(out)
    return re.sub(r'(?m)^\s*(?:case\b[^{}]*|default\s*:|break;|continue;)\s*$', '', joined)


def call_args(text, open_index):
    """从 text[open_index] == '(' 开始，返回括号内的子串与结束位置"""
    depth = 0
    i = open_index
    while i < len(text):
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
            if depth == 0:
                return text[open_index + 1:i], i + 1
        i += 1
    return '', len(text)


def eval_part_name(cls, expr, index):
    """把 root.getChild(PartNames.tentacle(i)) 里的命名调用算成字符串"""
    text = expr.strip()
    m = re.match(r'(?:(\w+)\.)?(\w+)\s*\(([^()]*)\)$', text)
    param = 'i'
    if m:
        owner = m.group(1) or cls
        hit = class_methods(owner).get(m.group(2))
        if hit:
            ret = re.search(r'return\s+(.+?);', hit['body'], re.S)
            if ret and hit['params']:
                text = ret.group(1).strip()
                param = hit['params'][0]
    pieces = []
    for piece in text.split('+'):
        piece = piece.strip()
        if piece.startswith('"'):
            pieces.append(piece.strip('"'))
        elif piece in ('i', param):
            pieces.append(str(index))
        else:
            try:
                pieces.append(str(int(eval(piece, {'__builtins__': {}}, {'i': index, param: index}))))
            except Exception:
                return None
    return ''.join(pieces)


def part_arrays(cls, raw):
    """
    部件数组：模型里的 this.tentacles / this.bodyParts 是 ModelPart[]。

    @why 两种写法都要认：`Arrays.setAll(this.tentacles, i -> root.getChild(...))`
          （鱿鱼、蠹虫）和 `for (...) { this.tentacles[i] = root.getChild(...) }`
          （恶魂）。缺了这张表，动作代码里的 p.tentacles 退回哑部件，
          for..of 一抛，整只生物就凝在出生姿势。
    """
    out = {}
    for m in re.finditer(
            r'(?:this\.)?(\w+)\s*=\s*new\s+ModelPart\[\s*(\d+)\s*\]'
            r'|ModelPart\[\]\s+(\w+)\s*=\s*new\s+ModelPart\[\s*(\d+)\s*\]', raw):
        if m.group(1):
            field, size = m.group(1), int(m.group(2))
        else:
            field, size = m.group(3), int(m.group(4))

        expr = None
        at = raw.find('Arrays.setAll(this.%s' % field)
        if at >= 0:
            comma = raw.find(',', at)
            arrow = raw.find('->', comma)
            g = raw.find('getChild(', arrow)
            if g > 0:
                expr = call_args(raw, g + len('getChild'))[0]
        if expr is None:
            assign = re.search(r'this\.%s\s*\[\s*\w+\s*\]\s*=\s*[\w.]*\.getChild\(' % field, raw)
            if assign:
                expr = call_args(raw, assign.end() - 1)[0]
        if expr is None:
            continue
        names = [eval_part_name(cls, expr, index) for index in range(size)]
        if all(names):
            out[field] = names
    return out


def class_index():
    """类名 → 文件路径。内联要读别的类的源码（船的 animatePaddle 在父类里）"""
    global _CLASS_FILES
    if _CLASS_FILES is None:
        table = {}
        for root, _dirs, names in os.walk(SRC):
            for name in names:
                if name.endswith('.java'):
                    table.setdefault(name[:-5], os.path.join(root, name))
        _CLASS_FILES = table
    return _CLASS_FILES


def class_methods(cls):
    """类里声明的方法：name → {params, body, static}。构造器与字段不算"""
    path = class_index().get(cls)
    if not path:
        return {}
    raw = strip_comments(open(path, encoding='utf-8', errors='replace').read())
    m = re.search(r'class\s+%s[^{]*\{' % cls, raw)
    if not m:
        return {}
    out = {}
    for header, inner in split_members(raw[m.end():]):
        # @why 字段声明以 ; 结尾、不带花括号，会和后面的方法签名粘成同一段 header。
        #      只取最后一段，否则 "public static final String X = ...;" 里的 '='
        #      会把整段判成字段，类里所有方法都找不到。
        h = header.strip().split(';')[-1].strip()
        if '=' in h or '(' not in h:
            continue
        mm = re.search(r'(\w+)\s*\(([^)]*)\)\s*$', h)
        if not mm:
            continue
        fname, params = mm.group(1), mm.group(2)
        if fname == cls:
            continue
        plist = [piece.strip().split()[-1] for piece in params.split(',') if piece.strip()]
        out.setdefault(fname, {
            'params': plist,
            'body': inner,
            'static': 'static' in h,
        })
    return out


def numeric_consts(raw):
    """static final float X = 1.5f; → {X: 1.5}，内联后要按字面值展开"""
    table = {}
    for m in re.finditer(r'static\s+final\s+(?:float|double|int|long)\s+(\w+)\s*=\s*(-?[\d.]+)[fFdDlL]?\s*;', raw):
        table[m.group(1)] = m.group(2)
    return table



def camel_words(text):
    """walkWithItem → WALK_WITH_ITEM"""
    return re.sub(r'(?<!^)(?=[A-Z])', '_', text).upper()


def field_defs(cls):
    """
    模型字段 → 关键帧定义名。

    @why 以前靠「字段名猜定义名」，蝙蝠的 flyingAnimation 猜不出 BAT_FLYING，
          兔子更是把定义藏在父类构造参数里。其实答案就写在源码里：
          `this.flyingAnimation = BatAnimation.BAT_FLYING.bake(root)`。
          抽象父类则是 `this.hopAnimation = hop.bake(root)`，具体定义由子类
          `super(root, RabbitAnimation.HOP, RabbitAnimation.IDLE_HEAD_TILT)`
          按位置传进来——所以要顺着构造参数对号。
    """
    if cls in _FIELD_DEF:
        return _FIELD_DEF[cls]
    _FIELD_DEF[cls] = {}
    raw = _RAWS.get(cls)
    if not raw:
        return {}
    out = dict(re.findall(r'this\.(\w+)\s*=\s*\w+\.(\w+)\.bake\(', raw))
    # 形参传进来的定义：this.hopAnimation = hop.bake(root) + 子类 super(...)
    param_def = _PARAM_DEF.get(cls) or {}
    for param, field in (_PARAM_FIELD.get(cls) or {}).items():
        if param in param_def:
            out[field] = param_def[param]
    parent = _PARENT.get(cls)
    if parent and parent in _RAWS:
        out = {**field_defs(parent), **out}
    _FIELD_DEF[cls] = out
    return out


def walk_def_for(cls, field):
    """
    给 `this.walkAnimation.applyWalk(...)` 找到它对应的关键帧定义。

    @why 关键帧定义挂在动画类上（CamelAnimation.CAMEL_WALK），模型只保留一个
          字段名。这里按「模型类名 ↔ 动画类名」+「字段名里的动作词」配对，
          配不上就继续跳过——宁可不猜。
    """
    if not _OWNERS:
        return None
    stem = cls[:-5] if cls.endswith('Model') else cls
    token = field[:-9] if field.endswith('Animation') else field
    token = camel_words(token)
    best, best_score = None, 0
    for name, owner in _OWNERS.items():
        score = 0
        if owner.lower() == (stem + 'Animation').lower():
            score += 4
        elif stem.lower() in owner.lower():
            score += 2
        if name == token:
            score += 5
        elif name.endswith('_' + token):
            score += 4
        elif token and token in name:
            score += 2
        if score > best_score:
            best, best_score = name, score
    return best if best_score >= 5 else None


def collect_inlines(cls, texts, fields):
    """
    把 setupAnim 里调用到的辅助方法也转译成函数内联进来。

    @why 动作本体经常不在 setupAnim 里：监守者的 animateWalk / animateIdlePose、
          船的 animatePaddle、骆驼的 applyHeadRotation 都是私有辅助方法。
          之前"方法调用一律跳过"，这些模型就只剩超类那层静止姿势——
          看着有完整骨骼，拖到详情页却一动不动。

    @constraint 只内联本类的实例方法（拿得到 this 对应的 p）与别的类的静态方法
          （部件是形参）。别类的实例方法需要那个对象，这里没有，跳过。
    """
    pools = {}

    def pool(owner):
        if owner not in pools:
            pools[owner] = class_methods(owner)
        return pools[owner]

    found = {}
    queue = []

    def scan(text, owner):
        for m in CALL_RE.finditer(text):
            recv, fname = m.group(1), m.group(2)
            if recv in SAFE_RECV:
                continue
            target = owner if recv == 'this' else recv
            key = '%s.%s' % (target, fname)
            if key in found:
                continue
            hit = pool(target).get(fname)
            if not hit or len(hit['body']) > 2600:
                continue
            # @constraint switch / while / try 不是「赋值 + if」的子集，转译出来
            #      的 case 标签会变成非法 JS，整段动作代码一编译就抛错——
            #      人形模型的 poseRightArm 就是 switch，内联它会把僵尸、骷髅、
            #      村民全部变成不动的木偶。这类方法宁可不内联。
            if BAD_BODY.search(hit['body']):
                continue
            if target == cls and fname in ('setupAnim', 'setupAttackAnimation'):
                continue
            if hit['static']:
                kind = 'static'
            elif target == cls:
                kind = 'inst'
            else:
                continue
            found[key] = {'owner': target, 'name': fname, 'params': hit['params'],
                          'body': strip_switch(hit['body']), 'kind': kind}
            queue.append(key)
            scan(hit['body'], target)

    for text in texts:
        scan(text, cls)
    if not found:
        return '', set()

    calls = set(found)
    parts = []
    for item in found.values():
        out = []
        if item['kind'] == 'inst':
            transpile(parse_statements(item['body'])[0], fields, out, 0, 'p.', True, calls, cls)
        else:
            transpile(parse_statements(item['body'])[0], {}, out, 0, '', True, calls, cls)
        parts.append('function __h_%s_%s(%s) {\n%s\n}' % (
            item['owner'], item['name'], ', '.join(item['params']), '\n'.join(out)))
    return '\n'.join(parts), calls


def rewrite_calls(code, calls, cls):
    """
    调用点改成内联函数名。

    @constraint 本类的调用在 conv_expr 之后写成 p.animateWalk(...)，
          跨类的仍是 BoatModel.animatePaddle(...)，两种都得认。
    """
    for key in sorted(calls, key=len, reverse=True):
        owner, fname = key.split('.', 1)
        recv = r'(?:p|this|%s)' % re.escape(owner) if owner == cls else re.escape(owner)
        code = re.sub(r'\b%s\.%s\s*\(' % (recv, re.escape(fname)),
                      '__h_%s_%s(' % (owner, fname), code)
    return code


def scan_classes(files):
    """
    预扫全部模型类，建好继承与构造参数索引。

    @why 关键帧定义经常由子类 super(...) 按位置传给抽象父类（兔子、犰狳），
          转译父类时子类还没被读到，配不出定义名——所以必须先扫一遍再转译。
    """
    for path in sorted(files):
        raw = strip_comments(open(path, encoding='utf-8', errors='replace').read())
        hit = re.search(r'public\s+(?:abstract\s+)?class\s+(\w+)', raw)
        if not hit:
            continue
        name = hit.group(1)
        ext = re.search(r'class\s+%s(?:<[^<>]*>)?\s+extends\s+([\w.]+)' % name, raw)
        parent = ext.group(1).split('.')[-1] if ext else None
        if parent and not parent.endswith('Model'):
            parent = None
        _RAWS[name] = raw
        _PARENT[name] = parent
        ctor = re.search(r'(?:public|protected|private)\s+%s\s*\(([^)]*)\)' % name, raw)
        if ctor:
            _PARAMS[name] = [piece.strip().split()[-1] for piece in ctor.group(1).split(',') if piece.strip()]
        _PARAM_FIELD[name] = {
            arg.strip(): field
            for field, arg in re.findall(r'this\.(\w+)\s*=\s*(\w+)\.bake\(', raw)
        }

    for name, raw in _RAWS.items():
        parent = _PARENT.get(name)
        params = _PARAMS.get(parent) if parent else None
        if not params:
            continue
        sup = re.search(r'super\(([^;]*)\)\s*;', raw)
        if not sup:
            continue
        for index, arg in enumerate(piece.strip() for piece in sup.group(1).split(',')):
            target = re.match(r'^\w+\.(\w+)$', arg)
            if index == 0 or index >= len(params) or not target:
                continue
            _PARAM_DEF.setdefault(parent, {})[params[index]] = target.group(1)


def main():
    global _DEFS, _OWNERS
    _DEFS, _OWNERS = anim_definitions()
    anims = load_animation_utils(SRC)
    models = {}
    files = []
    for root, _dirs, names in os.walk(SRC):
        for name in names:
            if name.endswith('Model.java'):
                files.append(os.path.join(root, name))

    scan_classes(files)

    for path in sorted(files):
        raw = strip_comments(open(path, encoding='utf-8', errors='replace').read())
        cls = re.search(r'public\s+(?:abstract\s+)?class\s+(\w+)', raw)
        if not cls:
            continue
        name = cls.group(1)
        # @why 泛型参数里也有 extends：ZombieModel<S extends ZombieRenderState>
        #      extends HumanoidModel。不跳过 <> 会匹配到 "S extends ZombieRenderState"，
        #      于是父类被认成"不是 *Model"而丢弃，僵尸、村民、骷髅的动作整条断掉。
        ext = re.search(r'class\s+%s(?:<[^<>]*>)?\s+extends\s+([\w.]+)' % name, raw)
        parent = ext.group(1).split('.')[-1] if ext else None
        # 跳过 Java 泛型参数残留
        if parent and not parent.endswith('Model'):
            parent = None

        body_match = re.search(r'class\s+%s[^{]*\{' % name, raw)
        if not body_match:
            continue
        body = raw[body_match.end():]

        # 关键帧字段配对的原料：源码、父类、构造参数、参数→字段
        _RAWS[name] = raw
        _PARENT[name] = parent
        ctor = re.search(r'(?:public|protected|private)\s+%s\s*\(([^)]*)\)' % name, raw)
        if ctor:
            _PARAMS[name] = [piece.strip().split()[-1] for piece in ctor.group(1).split(',') if piece.strip()]
        _PARAM_FIELD[name] = {
            arg.strip(): field
            for field, arg in re.findall(r'this\.(\w+)\s*=\s*(\w+)\.bake\(', raw)
        }
        _APPLIED.clear()

        members = split_members(body)

        # 字段 → part 名
        # @constraint 部件名经常是类内常量（root.getChild(STINGER)），接收者也可能
        #      是链式（this.bone.getChild("right_wing")）。只认 `x.getChild("字面量")`
        #      会让蜜蜂、僵尸这些模型的字段表整张空掉，动作代码里的 p.rightWing
        #      于是落到哑部件上——代码在跑，模型纹丝不动。
        consts = dict(re.findall(r'static\s+final\s+String\s+(\w+)\s*=\s*"([^"]*)"', raw))
        fields = {}
        for m in re.finditer(
                r'(?:this\.)?(\w+)\s*=\s*[\w.]*\.getChild\(\s*(?:"([^"]*)"|([A-Z_][A-Z0-9_]*))\s*\)',
                body):
            part_name = m.group(2) if m.group(2) is not None else consts.get(m.group(3) or '')
            if part_name:
                fields[m.group(1)] = part_name

        setup_texts = []
        code_parts = []
        attack_parts = []
        for header, inner in members:
            # setupAttackAnimation 不含 'setupAnim' 子串，两个分支不会互相吞掉
            target = code_parts if 'setupAnim' in header else (
                attack_parts if 'setupAttackAnimation' in header else None)
            if target is None:
                continue
            setup_texts.append(strip_switch(inner))

        # 辅助方法先内联：调用白名单要在转译之前定下来
        inline_src, calls = collect_inlines(name, setup_texts, fields)

        for header, inner in members:
            target = code_parts if 'setupAnim' in header else (
                attack_parts if 'setupAttackAnimation' in header else None)
            if target is None:
                continue
            stmts, _ = parse_statements(strip_switch(inner))
            out = []
            transpile(stmts, fields, out, 0, 'p.', target is attack_parts, calls, name)
            target.append('\n'.join(out))

        # 常量字段：内联后 this.MAX_X 变成 p.MAX_X，按字面值展开
        for const_name, const_value in numeric_consts(raw).items():
            for bucket in (code_parts, attack_parts):
                for index, text in enumerate(bucket):
                    bucket[index] = re.sub(r'\bp\.%s\b' % const_name, const_value, text)
        if inline_src:
            for index, text in enumerate(code_parts):
                code_parts[index] = rewrite_calls(text, calls, name)

        calls_super = 'super.setupAnim(' in body
        if not code_parts and not fields and not parent:
            continue
        body_code = '\n'.join(code_parts).strip()
        if body_code and calls:
            body_code = rewrite_calls(body_code, calls, name)
        arrays = part_arrays(name, raw)
        models[name] = {
            'extends': parent,
            'fields': fields,
            'arrays': arrays,
            'sup': calls_super,
            'code': (inline_src + '\n' + body_code).strip() if inline_src else body_code,
            'attack': '\n'.join(attack_parts).strip(),
        }

    attacks = {}
    for name in models:
        layers = attack_layers(name, models)
        if layers:
            attacks[name] = layers

    # 代码里出现的枚举引用（HumanoidArm.RIGHT 等）在 JS 里需要桩对象
    all_enums = set()
    for item in list(models.values()) + list(anims.values()):
        for m in re.finditer(r'\b([A-Z]\w*)\.[A-Z_]+\b', item['code']):
            all_enums.add(m.group(1))
    for layers in attacks.values():
        for code in layers:
            for m in re.finditer(r'\b([A-Z]\w*)\.[A-Z_]+\b', code):
                all_enums.add(m.group(1))

    # state 上所有 isXxx / hasXxx 之类的布尔标记
    # @why 前端默认值表不可能列全（isHidingInShell、isSneezing、isCurled…），
    #      漏一个就会被黑洞 Proxy 当成 truthy——犰狳因此永远缩在壳里，
    #      整个模型变成一颗球。这里把所有标记收集出来，前端统一置 false。
    flags = set()
    for item in list(models.values()) + list(anims.values()):
        for m in re.finditer(r'\bstate\.((?:is|has|can|should)[A-Z]\w*)', item['code']):
            flags.add(m.group(1))
    for layers in attacks.values():
        for code in layers:
            for m in re.finditer(r'\bstate\.((?:is|has|can|should)[A-Z]\w*)', code):
                flags.add(m.group(1))

    used_defs = {}
    for item in models.values():
        for hit in re.findall(r'__kf(?:Walk|Apply)\("(\w+)"', item['code']):
            if hit in _DEFS:
                used_defs[hit] = _DEFS[hit]
    data = {'enums': sorted(all_enums), 'anims': anims, 'classes': models, 'attacks': attacks,
            'flags': sorted(flags), 'defs': used_defs}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))

    total_lines = sum(item['code'].count('\n') + 1 for item in models.values() if item['code'])
    skipped = sum(item['code'].count('/* skip') for item in models.values())
    print('classes=%d  utils=%d  attacks=%d  defs=%d  code lines=%d  skipped stmts=%d  -> %s'
          % (len(models), len(anims), len(attacks), len(used_defs), total_lines, skipped, OUT))


if __name__ == '__main__':
    main()
