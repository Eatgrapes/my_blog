---
title: "ZKM 控制流混淆破解"
description: "反混淆 Zelix KlassMaster 的控制流混淆。"
published: 2026-05-15
tags: ["Java", "ASM", "ZKM", "Bytecode", "Deobfuscation"]
category: Java
draft: false
---

Zelix KlassMaster 是 Java 字节码混淆器中最为强悍的混淆器，而令 ZKM 引以为傲的混淆就是它的控制流混淆。

以下演示用的是 ASM 库，也就是 Java 字节码操作与分析框架。

## 什么是控制流平坦化

在正常 Java 方法中，控制流一般是树状或者块状的。

比如原始逻辑长这样：

```
if (a) {
    runA();
} else {
    runB();
}
runC();
```

字节码里虽然也是跳转，但结构还算清楚。

控制流平坦化会把这种结构打散，搞进一个调度循环里。逻辑大概会变成这样：

```
int state = 0;

while (true) {
    switch (state) {
        case 0:
            state = a ? 1 : 2;
            break;
        case 1:
            runA();
            state = 3;
            break;
        case 2:
            runB();
            state = 3;
            break;
        case 3:
            runC();
            return;
    }
}
```

它的执行顺序被打散了，都变成一个个 case，通过 `state` 状态变量决定下一步跳到哪里。

ZKM 不只用一种平坦化形式。它可能是 `switch` 调度，也可能是各种 `if`、`goto`、`try-catch` 混在一起。

## ZKM 的控制流恶心在哪

ZKM 会用这些东西混淆：

- 用假条件跳转污染控制流图（CFG）
- 用 `long` 比较指令做无意义分支
- 用对象空值检查塞假路径
- 用 `invokedynamic` 生成控制变量（这里不详细讲）
- 用 `try-catch` 异常处理器伪造异常边
- 用不可达代码干掉反编译器
- 用常量分支制造恒真或者恒假的跳转

反编译器会以为某些死代码能执行，会把简单逻辑还原成奇怪的嵌套判断，甚至直接反编译失败。

## 逻辑

逻辑可以这样写：

```java
private int processMethod(ClassNode owner, MethodNode method) {
    int total = 0;
    boolean dirty;

    do {
        dirty = false;

        dirty |= cleanHandlers(owner, method) > 0;
        dirty |= foldLongJumps(method) > 0;
        dirty |= foldIntJumps(owner, method) > 0;
        dirty |= foldObjectJumps(owner, method) > 0;
        dirty |= dropUnusedStores(method) > 0;
        dirty |= foldKnownBranches(owner, method) > 0;
        dirty |= sweepUnreachable(owner, method) > 0;
        dirty |= trimEmptyBranches(method) > 0;

        if (dirty) {
            total++;
        }
    } while (dirty);

    return total;
}
```

循环是重点。

因为你删掉一个假跳转之后，后面可能会暴露出新的死代码。删掉死代码之后，又可能出现新的常量分支。只跑一遍是不够的。

## 异常破解

ZKM 经常会塞一些假的异常处理器。
比如这样：

```
handler:
    getstatic xxx
    athrow
```

或者：

```
handler:
    astore n
    getstatic xxx
    athrow
```

这种傻子 handler 是拿来污染控制流图的。

拆法就是遍历 `tryCatchBlocks`，找到 handler 的 `LabelNode` 后面的真实指令。如果是经典的 `GETSTATIC + ATHROW`，就把 `try-catch` 记录和对应指令删掉。

```java
private int cleanHandlers(ClassNode owner, MethodNode method) {
    if (method.tryCatchBlocks == null || method.tryCatchBlocks.isEmpty()) {
        return 0;
    }

    int count = 0;
    Iterator<TryCatchBlockNode> iterator = method.tryCatchBlocks.iterator();

    while (iterator.hasNext()) {
        TryCatchBlockNode block = iterator.next();
        AbstractInsnNode first = nextReal(block.handler);

        if (first == null) {
            continue;
        }

        if (first.getOpcode() == GETSTATIC) {
            AbstractInsnNode second = nextReal(first);

            if (second != null && second.getOpcode() == ATHROW) {
                iterator.remove();
                method.instructions.remove(first);
                method.instructions.remove(second);
                count += 3;
            }
        }
    }

    return count;
}
```

删的别太激进。正常代码里也可能有 catch 后重新抛出异常 的情况。如果可以确定是假的就删，不能确定就留着。

## 破解 `long` 比较跳转

ZKM 控制流里经常能看到这种结构：

```
lload x
lconst_0
lcmp
iflt L
```

也可能是：

```
lload x
lconst_0
lcmp
ifge L
```

这类分支很多是控制流垃圾。识别 模式 直接就：

```
LLOAD
LCONST_0
LCMP
IFLT / IFLE / IFGE / IFGT
```

可以写成这样：

```java
private int foldLongJumps(MethodNode method) {
    int count = 0;

    for (AbstractInsnNode insn : method.instructions.toArray()) {
        if (insn.getOpcode() != LLOAD) {
            continue;
        }

        AbstractInsnNode a = nextReal(insn);
        AbstractInsnNode b = nextReal(a);
        AbstractInsnNode c = nextReal(b);

        if (a == null || b == null || c == null) {
            continue;
        }

        if (a.getOpcode() == LCONST_0
                && b.getOpcode() == LCMP
                && isLongBranch(c.getOpcode())) {
            method.instructions.remove(insn);
            method.instructions.remove(a);
            method.instructions.remove(b);
            method.instructions.remove(c);
            count += 4;
        }
    }

    return count;
}

private boolean isLongBranch(int opcode) {
    return opcode == IFLT || opcode == IFLE || opcode == IFGE || opcode == IFGT;
}
```

这个是比较好处理的。

## `int` 假判断

常见假分支：

```
iload x
ifeq L
```

或者：

```
iload x
ifne L
```

但是不能看到 `iload + ifeq` 就删。正常判断里一堆这种写法。

比较靠谱的判断是看 `ILOAD` 执行前操作数栈是不是空的。

如果操作数栈不是空的，它突然来个 `iload + ifeq`，这种就很像 ZKM 的假栈干扰。

ASM 可以用 Analyzer 计算 `Frame`：

```java
private int foldIntJumps(ClassNode owner, MethodNode method) {
    int count = 0;
    Frame<BasicValue>[] frames = analyzeFrames(owner, method);

    if (frames == null) {
        return 0;
    }

    List<AbstractInsnNode> insns = realInsns(method);

    for (int i = 0; i + 1 < insns.size(); i++) {
        AbstractInsnNode load = insns.get(i);
        AbstractInsnNode jump = insns.get(i + 1);

        if (load.getOpcode() != ILOAD) {
            continue;
        }

        if (jump.getOpcode() != IFEQ && jump.getOpcode() != IFNE) {
            continue;
        }

        int index = method.instructions.indexOf(load);
        Frame<BasicValue> frame = frames[index];

        if (frame == null) {
            continue;
        }

        if (frame.getStackSize() != 0) {
            method.instructions.remove(load);
            method.instructions.remove(jump);
            count += 2;
        }
    }

    return count;
}
```

## 找到调度变量

ZKM 用 `invokedynamic` 生成某种状态变量，然后拿这个变量到处跳。

大概长这样：

```
invokedynamic ...
istore x
...
iload x
ifeq L
```

可以先扫出这种状态变量：

```java
private Set<Integer> collectStateVars(MethodNode method) {
    Set<Integer> vars = new HashSet<>();

    for (AbstractInsnNode insn : method.instructions) {
        if (insn.getOpcode() != INVOKEDYNAMIC) {
            continue;
        }

        AbstractInsnNode next = nextReal(insn);

        if (next instanceof VarInsnNode varInsn && next.getOpcode() == ISTORE) {
            vars.add(varInsn.var);
        }
    }

    return vars;
}
```

后面遇到 `iload x / ifeq` 的时候，如果 `x` 是这种状态变量，就可以考虑清掉。

但要加副作用判断。

因为有些分支包住的是真实代码，比如 `PUTSTATIC`、`INVOKEVIRTUAL`、`ATHROW`。这种删错了，程序直接寄。

```java
private boolean hasGuardedEffects(AbstractInsnNode branch, LabelNode target) {
    for (AbstractInsnNode insn = branch.getNext(); insn != null && insn != target; insn = insn.getNext()) {
        if (!isReal(insn)) {
            continue;
        }

        if (hasSideEffect(insn)) {
            return true;
        }
    }

    return false;
}

private boolean hasSideEffect(AbstractInsnNode insn) {
    int op = insn.getOpcode();

    return op == INVOKEVIRTUAL
            || op == INVOKESTATIC
            || op == INVOKESPECIAL
            || op == INVOKEINTERFACE
            || op == INVOKEDYNAMIC
            || op == PUTFIELD
            || op == PUTSTATIC
            || op == ATHROW
            || op == MONITORENTER
            || op == MONITOREXIT;
}
```

实际处理可以这样：

```java
Set<Integer> stateVars = collectStateVars(method);
int var = ((VarInsnNode) load).var;
JumpInsnNode branch = (JumpInsnNode) jump;

if (stateVars.contains(var) && !hasGuardedEffects(branch, branch.label)) {
    method.instructions.remove(load);
    method.instructions.remove(jump);
}
```

这就比无脑删多了。

## 对象空值判断

对象分支也会出现类似模式：

```
aload x
ifnull L
```

或者：

```
aload x
ifnonnull L
```

处理思路和 int 分支差不多：

```java
private int foldObjectJumps(ClassNode owner, MethodNode method) {
    int count = 0;
    Frame<BasicValue>[] frames = analyzeFrames(owner, method);

    if (frames == null) {
        return 0;
    }

    List<AbstractInsnNode> insns = realInsns(method);

    for (int i = 0; i + 1 < insns.size(); i++) {
        AbstractInsnNode load = insns.get(i);
        AbstractInsnNode jump = insns.get(i + 1);

        if (load.getOpcode() != ALOAD) {
            continue;
        }

        if (jump.getOpcode() != IFNULL && jump.getOpcode() != IFNONNULL) {
            continue;
        }

        int index = method.instructions.indexOf(load);
        Frame<BasicValue> frame = frames[index];

        if (frame != null && frame.getStackSize() != 0) {
            method.instructions.remove(load);
            method.instructions.remove(jump);
            count += 2;
        }
    }

    return count;
}
```

它不只喜欢玩 int，也会拿 对象空值检查 当假边用。

## 把成对反向判断压成 goto

有时候 ZKM 会把一个简单 `goto` 拆成两个互相抵消的判断。

类似：

```
iload x
ifeq L1

L1:
iload x
ifne L2
```

如果两个判断用的是同一个变量，而且 opcode 互为反向条件，那它其实就是绕了一圈。

可以改成：

```
goto L2
```

判断函数：

```java
private boolean isOpposite(int a, int b) {
    return (a == IFEQ && b == IFNE)
            || (a == IFNE && b == IFEQ)
            || (a == IFNULL && b == IFNONNULL)
            || (a == IFNONNULL && b == IFNULL);
}
```

但是有个重要条件：两个跳转之间不能夹真实代码。

```java
private boolean hasCodeBetween(AbstractInsnNode from, LabelNode to) {
    for (AbstractInsnNode insn = from.getNext(); insn != null && insn != to; insn = insn.getNext()) {
        if (isReal(insn)) {
            return true;
        }
    }

    return false;
}
```

如果中间有真实指令，不要改。

## 没人读的 `store` 换成 `pop`

当你删掉一堆假分支以后，会留下这种东西：

```
invokedynamic ...
istore x
```

但 `x` 后面已经没人读了。

这时候不能直接删 `istore x`，因为栈上还有 `invokedynamic` 的返回值。直接删会导致操作数栈不平衡。

正确做法是：

```
istore x  -> pop
lstore x  -> pop2
dstore x  -> pop2
```

代码：

```java
private int dropUnusedStores(MethodNode method) {
    int count = 0;
    Set<Integer> unused = collectUnusedStateVars(method);

    for (AbstractInsnNode insn : method.instructions.toArray()) {
        if (!(insn instanceof VarInsnNode varInsn)) {
            continue;
        }

        if (!unused.contains(varInsn.var)) {
            continue;
        }

        int op = varInsn.getOpcode();

        if (op == ISTORE || op == FSTORE || op == ASTORE) {
            method.instructions.set(varInsn, new InsnNode(POP));
            count++;
        } else if (op == LSTORE || op == DSTORE) {
            method.instructions.set(varInsn, new InsnNode(POP2));
            count++;
        }
    }

    return count;
}
```

## 常量条件折叠

清理到后面，经常会出现这种分支：

```
iconst_0
ifeq L
```

这是永远跳。

或者：

```
iconst_0
ifne L
```

这是永远不跳。

如果一定跳，就插入 `GOTO target`。
如果一定不跳，就直接删掉常量和条件跳转。

```java
private int foldKnownBranches(ClassNode owner, MethodNode method) {
    int count = 0;
    List<AbstractInsnNode> insns = realInsns(method);

    for (int i = 0; i + 1 < insns.size(); i++) {
        AbstractInsnNode value = insns.get(i);
        AbstractInsnNode jump = insns.get(i + 1);

        if (!isIntConstant(value)) {
            continue;
        }

        if (jump.getOpcode() != IFEQ && jump.getOpcode() != IFNE) {
            continue;
        }

        int intValue = readIntConstant(value);
        JumpInsnNode branch = (JumpInsnNode) jump;
        boolean taken = jump.getOpcode() == IFEQ ? intValue == 0 : intValue != 0;

        if (taken) {
            method.instructions.insertBefore(value, new JumpInsnNode(GOTO, branch.label));
        }

        method.instructions.remove(value);
        method.instructions.remove(jump);
        count += 2;
    }

    return count;
}
```


## 扫不可达代码

控制流清完以后，方法里会残留大量不可达代码。

比如：

```
goto L1
垃圾指令
垃圾指令
垃圾指令
L1:
真实代码
```

这时候就可以扫一遍。

思路：

1. 收集所有被 `jump`、`switch`、`try-catch` 引用的 `LabelNode`
2. 遇到 `GOTO`、`RETURN`、`ATHROW` 后进入不可达区间
3. 在不可达区间里删除真实指令
4. 遇到遇到被引用的 `LabelNode` 停止删除

```java
private int sweepUnreachable(ClassNode owner, MethodNode method) {
    int count = 0;
    Set<LabelNode> usedLabels = collectUsedLabels(method);
    boolean dead = false;

    for (AbstractInsnNode insn : method.instructions.toArray()) {
        if (dead) {
            if (insn instanceof LabelNode label && usedLabels.contains(label)) {
                dead = false;
                continue;
            }

            if (!isReal(insn)) {
                continue;
            }

            method.instructions.remove(insn);
            count++;
            continue;
        }

        if (isReal(insn)) {
            int op = insn.getOpcode();

            if (op == GOTO || op == ATHROW || isReturn(op)) {
                dead = true;
            }
        }
    }

    return count;
}
```

这里不要乱删 `LabelNode`、`FrameNode`、`LineNumberNode`。尤其是 label，有些是 跳转目标，有些是 `try-catch` 边界，删错就损坏 class 文件。

## 处理顺序

我推荐这个顺序：

```
cleanHandlers
foldLongJumps
foldIntJumps
foldObjectJumps
dropUnusedStores
foldKnownBranches
sweepUnreachable
trimEmptyBranches
```

原因很简单：

- 异常陷阱会污染 CFG
- `long` 比较 这种明显 模式 可以早点清
- `int` / 对象假跳转依赖 `Frame` 分析
- 假跳转删完以后，没用的 `store` 才会出现
- `store` 清完以后，常量分支更容易暴露
- 常量分支折叠后，不可达代码更多
- 最后再扫死分支和空跳转

这不是唯一顺序。

## 效果
这是清理前和清理后的效果：

Before:
```java
 private void C(Object[] var1) {
    long var3;
    label110: {
        int var5;
        d var8;
        label105: {
            label111: {
                label103: {
                    int var2 = (Integer)var1[0];
                    var3 = (Long)var1[1];
                    var5 = 8791405012267327996L.ä<invokedynamic>(8791405012267327996L, var3);
        int var10000 = var2;
        if (var3 >= 0L) {
            if (var5 == 0) {
                switch (var2) {
                case 1:
                    break label110;
                case 2:
                    break label111;
                case 3:
                    break label103;
                case 4:
                    this.a.M(new Object[]{this.a.C, (this.a.W + 1) % a(1932, 731985377339037758L ^ var3)});
                    this.F.add(new o(this.a.C, this.a.W));
                    break;
                default:
                    return;
                }
            }

            var10000 = var5;
        }

        if (var10000 == 0) {
            return;
        }
        }

        label112: {
            label86: {
            o var6 = this.a;
            int var10001 = var5;
            if (var3 > 0L) {
            if (var5 == 0) {
                label114: {
                    var7 = var6.W - 1;
                    if (var3 > 0L) {
            if (var7 >= 0) {
                break label114;
            }

            this.a.M(new Object[]{this.a.C, a(29136, 2917130341553155683L ^ var3)});
            var7 = var5;
        }

            if (var3 <= 0L) {
                break label112;
            }

            if (var7 == 0) {
                break label86;
            }
        }

            var6 = this.a;
        }

            var10001 = this.a.C;
        }

            var6.M(new Object[]{var10001, Math.abs(this.a.W - 1) % a(17797, 9156378109973535282L ^ var3)});
        }

            var8 = this;
            if (var3 < 0L) {
                break label105;
            }

            this.F.add(new o(this.a.C, this.a.W));
            var7 = var5;
        }

        if (var7 == 0) {
            return;
        }
        }

        var8 = this;
        }

        label64: {
            label63: {
            o var9 = var8.a;
            int var11 = var5;
            if (var3 >= 0L) {
            if (var5 == 0) {
                label116: {
                    var10 = var9.C - 1;
                    if (var3 >= 0L) {
            if (var10 >= 0) {
                break label116;
            }

            this.a.M(new Object[]{a(28420, 7594277407537606836L ^ var3), this.a.W});
            var10 = var5;
        }

            if (var3 <= 0L) {
                break label64;
            }

            if (var10 == 0) {
                break label63;
            }
        }

            var9 = this.a;
        }

            var11 = Math.abs(this.a.C - 1) % a(17797, 9156378109973535282L ^ var3);
        }

            var9.M(new Object[]{var11, this.a.W});
        }

            this.F.add(new o(this.a.C, this.a.W));
            var10 = var5;
        }

        if (var3 < 0L || var10 == 0) {
            return;
        }
        }

        this.a.M(new Object[]{Math.abs(this.a.C + 1) % a(17797, 9156378109973535282L ^ var3), this.a.W});
        this.F.add(new o(this.a.C, this.a.W));
        }
```


After:

```java
private void C(int var1, long var2) {
    boolean var5 = false;

    switch (var1) {
        case 1:
            this.a.M(Math.abs(this.a.C + 1) % 20, this.a.W);
            this.F.add(new o(this.a.C, this.a.W));
            break;

        case 2:
            if (this.a.C - 1 < 0) {
                this.a.M(19, this.a.W);
            } else {
                this.a.M(Math.abs(this.a.C - 1) % 20, this.a.W);
            }

            this.F.add(new o(this.a.C, this.a.W));
            break;

        case 3:
            if (this.a.W - 1 < 0) {
                this.a.M(this.a.C, 19);
            } else {
                this.a.M(this.a.C, Math.abs(this.a.W - 1) % 20);
            }

            this.F.add(new o(this.a.C, this.a.W));
            break;

        case 4:
            this.a.M(this.a.C, (this.a.W + 1) % 20);
            this.F.add(new o(this.a.C, this.a.W));
            break;
    }
}
```

轻松理解含义。。。。。
