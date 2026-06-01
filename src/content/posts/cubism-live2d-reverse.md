---
title: Cubism Live2D Core模型变换公式逆向
published: 2026-06-01
description: Live2D的模型变换公式逆向
tags: [reverse]
category: Reverse
draft: false
---
我一直好奇cubism core里面的模型变换公式是什么，但是当我想看时，却发现Cubism Core并不开源。
Cubism Core 动态库文件基本没有做什么混淆，符号虽然不一定完整，但整体代码结构很干净，逆向起来非常简单。

研究了很久，我发现Live2D 是一条流水线：参数先被限制或循环处理，然后落到 Keyform 区间里，接着算出多维插值权重，再把这些权重用到 Part、Deformer、ArtMesh、Physics、Glue、Mask 等结构上。每一步都看着不复杂，但只要有一个小细节错了，最后画面就会明显偏掉。

为了让开发者不需要自己逆向就可以理解它的公式，我写出了本篇。

## 1. 整体更新链路

Cubism Core 的更新可以粗略看成这样：

```text
Parameter
  -> Keyform Binding
  -> Keyform Interpolation
  -> Part / Deformer / ArtMesh
  -> Blend / Glue / Physics
  -> Clipping Mask
  -> Draw Order
  -> Render
```

参数不会直接控制顶点。参数只是决定当前应该取哪些 Keyform，以及这些 Keyform 各自占多少权重。

更准确一点，可以拆成三层：

$$
\text{Parameter} \rightarrow \text{Weight}
$$

$$
\text{Weight} \times \text{Keyform} \rightarrow \text{Local Value}
$$

$$
\text{Local Value} \rightarrow \text{Deformed Vertex / Color / Opacity}
$$

Cubism Core 的作用就是把参数解释成几何结果。

## 2. 参数裁剪和 Repeat

普通参数会先被限制在范围里：

$$
v' = \operatorname{clamp}(v, v_{\min}, v_{\max})
$$

展开就是：

$$
v' = \max(v_{\min}, \min(v, v_{\max}))
$$

这个没什么神秘的，但真正需要注意的是 Repeat 参数。Repeat 不是简单 clamp，而是把值折回一个周期区间。

设参数最小值是 $v_{\min}$，周期步长是 $s$，那么：

$$
q = \frac{v - v_{\min}}{s}
$$

取整数部分：

$$
n = \lfloor q \rfloor
$$

最后折回：

$$
v' = (q - n)s + v_{\min}
$$

实际实现里不一定写成 `floor`，有时会用截断再修正负数情况。但这样做主要是为了保证负数 Repeat 也能得到正确结果。

还有一个细节，当 $q$ 大到一定程度时，浮点精度已经不太可靠，Core 会避免继续做过度精细的修正。这种地方看起来不起眼，但复现的时候如果完全按理想数学公式写，反而可能和原始行为对不上。

## 3. Keyform 区间定位

一个参数通常会绑定一组 key：

$$
K = \{k_0, k_1, k_2, \dots, k_n\}
$$

当前参数值为 $v$。

如果：

$$
v \le k_0
$$

那么直接取第一个 Keyform：

$$
i = 0, \quad t = 0
$$

如果：

$$
v \ge k_n
$$

那么取最后一个 Keyform：

$$
i = n, \quad t = 0
$$

如果落在中间：

$$
k_i \le v \le k_{i+1}
$$

则插值系数为：

$$
t = \frac{v - k_i}{k_{i+1} - k_i}
$$

单看这一步就是普通线性插值。但问题是 Cubism 的对象往往不是只受一个参数控制，而是同时受多个参数控制。比如脸部角度、眼睛开合、嘴巴形状都可能同时影响一个 ArtMesh。

## 4. 多维 Keyform 权重

如果只有一个参数轴，插值很简单：

$$
R = V_0(1 - t) + V_1t
$$

两个参数轴时，假设插值系数分别是 $t_x$ 和 $t_y$，四个角点权重就是：

$$
w_{00} = (1 - t_x)(1 - t_y)
$$

$$
w_{10} = t_x(1 - t_y)
$$

$$
w_{01} = (1 - t_x)t_y
$$

$$
w_{11} = t_xt_y
$$

结果：

$$
R = V_{00}w_{00} + V_{10}w_{10} + V_{01}w_{01} + V_{11}w_{11}
$$

推广到更多参数，本质就是：

$$
R = \sum_i V_iw_i
$$

其中每个 $w_i$ 是多个参数轴权重的乘积。

这就是 Cubism Keyform 最核心的一点：它不是“当前参数对应一个值”，而是在多维 Keyform 空间里取若干个角点，然后加权混合。

Keyform 在内存里通常不是以多维数组的形式摆着，而是压平成一维数组。因此还需要根据每个轴的 stride 算索引：

$$
\text{index} = a_0s_0 + a_1s_1 + a_2s_2 + \cdots + a_ns_n
$$

这里的 $a_i$ 是每个轴上的 key index，$s_i$ 是对应 stride。

逆向时如果只盯着单个参数，很容易觉得 Keyform 顺序很怪。其实它不是乱，而是多维坐标被压平了。

## 5. 标量、数组和整数的插值

浮点值的插值是最直接的：

$$
out = \sum_i v_iw_i
$$

数组也是一样，只是对每个元素分别算：

$$
out_j = \sum_i v_{i,j}w_i
$$

顶点坐标、颜色、透明度，本质都可以走这种逻辑。

比较有意思的是整数。Core 里很多理论上应该是整数的东西，并不是简单 cast，而是会先加一个很小的偏移：

$$
out = \operatorname{trunc}(v + 0.001)
$$

这个 $0.001$ 很像是为了抵消浮点误差。比如理论结果应该是 $3.0$，但实际算出来是 $2.999999$，直接截断就变成 $2$ 了。加一个小偏移以后，就能回到预期整数。

Draw Order 也能看到类似行为：

$$
d = \operatorname{clamp}(\operatorname{trunc}(v + 0.001), 0, 1000)
$$

## 6. ArtMesh 顶点是怎么来的

ArtMesh 的顶点坐标来自 Keyform 混合。

假设一个顶点在多个 Keyform 下的位置分别是：

$$
P_0, P_1, P_2, \dots, P_n
$$

对应权重是：

$$
w_0, w_1, w_2, \dots, w_n
$$

那么最终位置就是：

$$
P = \sum_i P_iw_i
$$

拆成 x、y：

$$
x = \sum_i x_iw_i
$$

$$
y = \sum_i y_iw_i
$$

透明度也是一样：

$$
\alpha = \sum_i \alpha_iw_i
$$

所以 Live2D 的网格变形看起来平滑，是因为每个顶点都在做连续加权混合。

## 7. Rotation Deformer

Rotation Deformer 可以看成二维旋转矩阵，再叠加缩放、翻转和平移。

角度先转成弧度：

$$
\theta = \frac{\pi}{180} \cdot \text{degree}
$$

然后计算：

$$
\cos\theta, \quad \sin\theta
$$

如果有翻转：

$$
s_x = \begin{cases}
-1, & \text{flipX} \\
1, & \text{otherwise}
\end{cases}
$$

$$
s_y = \begin{cases}
-1, & \text{flipY} \\
1, & \text{otherwise}
\end{cases}
$$

矩阵可以写成：

$$
M =
\begin{bmatrix}
\cos\theta \cdot S \cdot s_x & -\sin\theta \cdot S \cdot s_y \\
\sin\theta \cdot S \cdot s_x &  \cos\theta \cdot S \cdot s_y
\end{bmatrix}
$$

对点 $(x, y)$ 变换：

$$
x' = \cos\theta \cdot S \cdot s_x \cdot x - \sin\theta \cdot S \cdot s_y \cdot y + t_x
$$

$$
y' = \sin\theta \cdot S \cdot s_x \cdot x + \cos\theta \cdot S \cdot s_y \cdot y + t_y
$$

这里最容易搞错的是 $\sin$ 和 $\cos$ 的位置。它其实就是一个标准二维旋转矩阵。

角度本身通常也不是固定值，而是 Keyform 插值出来的：

$$
\theta = \theta_0 + \Delta\theta
$$

其中 $\Delta\theta$ 来自参数权重混合。

## 8. Warp Deformer

Warp Deformer 比 Rotation 有意思。它是一个网格变形。

假设 Warp 网格有 $C$ 列、$R$ 行，那么控制点数量为：

$$
(C + 1)(R + 1)
$$

对一个局部点 $(x, y)$，先映射到网格空间：

$$
u = xC
$$

$$
v = yR
$$

所在 cell：

$$
i = \lfloor u \rfloor, \quad j = \lfloor v \rfloor
$$

cell 内部局部坐标：

$$
s = u - i
$$

$$
t = v - j
$$

四个角点记为：

$$
C_{00}, C_{10}, C_{01}, C_{11}
$$

普通四边形插值就是双线性插值：

$$
P = C_{00}(1-s)(1-t) + C_{10}s(1-t) + C_{01}(1-s)t + C_{11}st
$$

也可以写成权重形式：

$$
w_{00} = (1-s)(1-t)
$$

$$
w_{10} = s(1-t)
$$

$$
w_{01} = (1-s)t
$$

$$
w_{11} = st
$$

$$
P = C_{00}w_{00} + C_{10}w_{10} + C_{01}w_{01} + C_{11}w_{11}
$$

还有一种做法是把 cell 切成两个三角形。

如果：

$$
s + t \le 1
$$

使用左上三角：

$$
P = C_{00} + (C_{10} - C_{00})s + (C_{01} - C_{00})t
$$

否则使用右下三角：

$$
a = 1 - s, \quad b = 1 - t
$$

$$
P = C_{11} + (C_{01} - C_{11})a + (C_{10} - C_{11})b
$$

点跑到网格外面时，Core 不是把点坐标控制在边缘，而是会 clamp cell index，同时保留 $s$、$t$ 的外推值。

也就是说，cell 是合法的，但局部插值系数可以小于 $0$ 或大于 $1$。这样边界外的点会沿着边缘继续外推。

## 9. Deformer 的顺序不能乱

ArtMesh 可能挂在一个 Deformer 下，而这个 Deformer 又有父 Deformer。最后顶点会沿着父子链一层一层变换。

可以理解成：

$$
P_{world} = D_n(D_{n-1}(\cdots D_1(P_{local}) \cdots))
$$

这里的顺序不能交换。比如：

$$
\operatorname{Warp}(\operatorname{Rotate}(P)) \ne \operatorname{Rotate}(\operatorname{Warp}(P))
$$

这也是很常见的错位来源：单个 Deformer 公式可能是对的，但父子顺序错了，最后画面还是不对。

尤其是 Rotation 和 Warp 混在一起时，旋转中心也要跟着对应的空间变换走。否则顶点变形了，锚点还留在旧空间，结果就会出现肉眼明显的偏移。

## 10. Glue：两个网格之间的吸附

Glue 的作用可以理解成让两个 ArtMesh 的边缘互相贴近。

假设两个点分别是 $A$ 和 $B$，Glue 强度是 $g$，两边权重分别是 $w_A$ 和 $w_B$。

那么：

$$
A' = A + (B - A)w_Ag
$$

$$
B' = B + (A - B)w_Bg
$$

如果 $g = 0$，完全不影响。

如果 $g$ 接近 $1$，两个点就会明显靠近。

这个东西很适合处理嘴唇、眼皮、衣服边缘这种“需要贴合，但又不能真的合并”的地方。

## 11. BlendShape 和颜色混合

BlendShape 更像是在当前结果上叠加 delta：

$$
P' = P + \Delta P \cdot w
$$

多个 BlendShape 就是：

$$
P' = P + \sum_i \Delta P_iw_i
$$

标量也类似：

$$
out = base + \sum_i v_iw_i
$$

颜色混合常见有 Multiply 和 Screen。

Multiply：

$$
C = C_{local} \cdot C_{parent}
$$

展开到 RGB：

$$
r = r_l r_p, \quad g = g_l g_p, \quad b = b_l b_p
$$

Screen：

$$
C = C_{local} + C_{parent} - C_{local}C_{parent}
$$

也就是：

$$
r = r_l + r_p - r_lr_p
$$

$$
g = g_l + g_p - g_lg_p
$$

$$
b = b_l + b_p - b_lb_p
$$

最后一般还会 clamp 到 $[0, 1]$。

## 12. Part 透明度继承

Part 的透明度会向下传递。

如果本地透明度是 $\alpha_l$，父级透明度是 $\alpha_p$，最终就是：

$$
\alpha = \alpha_l\alpha_p
$$

所以一个 ArtMesh 自己的透明度就算是 $1$，只要父 Part 是 $0$，最后也不会显示。

这个公式简单，但复现的时候很容易漏掉。漏了以后最明显的表现就是：某些本该随着 Part 隐藏的网格还在画面上。

## 13. 坐标系翻转

Cubism 内部坐标和渲染坐标之间经常会有 Y 轴方向差异。

常见转换就是：

$$
(x, y) \rightarrow (x, -y)
$$

也就是：

$$
y' = -y
$$

这个问题很阴间，它会让你觉得“公式全错了”。其实可能只是最后输出坐标系上下反了。

如果插值、Deformer、Draw Order 都看起来差不多，但画面整体倒过来，先查坐标系。

## 14. Physics 的归一化输入

Cubism 的物理不是直接拿参数值去模拟，而是先做归一化。

设参数范围为：

$$
[p_{\min}, p_{\max}]
$$

中点：

$$
p_{mid} = p_{\min} + \frac{|p_{\max} - p_{\min}|}{2}
$$

先 clamp：

$$
p = \operatorname{clamp}(p, p_{\min}, p_{\max})
$$

再减中点：

$$
d = p - p_{mid}
$$

如果 $d > 0$：

$$
r = d \cdot \frac{n_{\max} - n_{def}}{p_{\max} - p_{mid}} + n_{def}
$$

如果 $d < 0$：

$$
r = d \cdot \frac{n_{\min} - n_{def}}{p_{\min} - p_{mid}} + n_{def}
$$

如果 $d = 0$：

$$
r = n_{def}
$$

然后根据 reflect 决定方向：

$$
r' =
\begin{cases}
r, & \text{reflect} \\
-r, & \text{otherwise}
\end{cases}
$$

输入权重一般按百分比处理：

$$
r_w = r' \cdot \frac{w}{100}
$$

所以物理输入可以由多个参数累加，比如角度、X 位移、Y 位移一起影响头发、挂件、衣服飘动。

## 15. Physics 粒子链

Cubism 的物理更像一条带约束的粒子链，而不是完整刚体模拟。

第一个粒子通常跟随输入位置：

$$
P_0 = T
$$

重力方向由角度得到：

$$
g = \operatorname{normalize}(\sin\theta, \cos\theta)
$$

每个后续粒子受到重力、风、上一帧速度等影响。大概可以理解成：

$$
F = g \cdot a + wind
$$

时间因子通常会带上 delay：

$$
d = delay \cdot \Delta t \cdot 30
$$

位置预测：

$$
P' = P_{prev} + direction + velocity \cdot d + Fd^2
$$

为了保持粒子链长度，还会把新位置拉回固定半径：

$$
dir = \operatorname{normalize}(P' - P_{prev})
$$

$$
P' = P_{prev} + dir \cdot radius
$$

速度再更新：

$$
velocity = \frac{P' - P_{last}}{d} \cdot mobility
$$

角度输出一般来自两个方向向量的夹角：

$$
\theta = \operatorname{atan2}(b_y, b_x) - \operatorname{atan2}(a_y, a_x)
$$

并且会修正到：

$$
[-\pi, \pi]
$$

这个模型不追求绝对物理真实，它追求的是稳定、可控、好看。Live2D 的物理看起来舒服，靠的就是这种“够用而且稳定”的约束粒子链。

## 16. 预乘 Alpha 和混合模式

Cubism 渲染里一个非常关键的点是预乘 Alpha。

颜色会先乘透明度：

$$
\alpha = \alpha_{tex} \cdot opacity
$$

$$
C_{rgb} = C_{tex} \cdot \alpha
$$

最终输出：

$$
C = (C_{rgb}, \alpha)
$$

普通混合可以理解成：

$$
out = src + dst(1 - \alpha_{src})
$$

加法混合：

$$
out_{rgb} = src_{rgb} + dst_{rgb}
$$

乘法混合比较特殊：

$$
out_{rgb} = src_{rgb} \cdot dst_{rgb} + dst_{rgb}(1 - \alpha_{src})
$$

如果把预乘 Alpha 当成普通 straight alpha，很容易出现透明边缘发黑、加法颜色不对、遮罩边缘脏这些问题。

## 17. Clipping Mask

遮罩一般分两步。

第一步，先把 mask drawable 写入 mask texture 的某个通道。

设纹理透明度是 $\alpha_{tex}$，Drawable 透明度是 $\alpha_d$，区域判断是 $I$：

$$
\alpha_m = \alpha_{tex}\alpha_dI
$$

写入通道：

$$
M = channel \cdot \alpha_m
$$

区域判断可以写成：

$$
I = step(l, x) \cdot step(t, y) \cdot step(x, r) \cdot step(y, b)
$$

第二步，绘制被裁剪对象时采样 mask texture：

$$
mask = texture(MaskTexture, uv)
$$

然后取指定通道，并且通常会有反相逻辑：

$$
maskValue = dot(1 - mask, channel)
$$

最后：

$$
C' = C \cdot maskValue
$$

这里的 $1 - mask$ 很容易漏。漏了以后遮罩方向会反，表现就是该显示的不显示，该挡住的露出来。

## 18. Clipping 矩阵

Clipping 还需要把模型坐标映射到 mask texture 的某个 layout 区域。

设被裁剪对象 bounds 为：

$$
B = (x_b, y_b, w_b, h_b)
$$

mask layout 为：

$$
L = (x_l, y_l, w_l, h_l)
$$

缩放：

$$
s_x = \frac{w_l}{w_b}
$$

$$
s_y = \frac{h_l}{h_b}
$$

平移大概是：

$$
t_x = -x_b s_x + x_l
$$

$$
t_y = 1 - y_l + y_b s_y
$$

如果要映射到裁剪空间，还要扩到 $[-1, 1]$：

$$
s'_x = 2s_x
$$

$$
s'_y = 2s_y
$$

$$
t'_x = 2t_x - 1
$$

$$
t'_y = 2(-y_b s_y + y_l) - 1
$$

这也是为什么 Clipping 相关矩阵看起来比普通模型矩阵绕。它同时处理了模型 bounds、mask atlas layout、坐标系方向和 GPU 裁剪空间。

## 19. 总结

它大部分公式都很朴素，都是一些小公式

但 Cubism Core 把这些小公式串成了一整条链。一个 $0.001$ 的误差修正、一个 Y 轴翻转、一个 stride、一个父子 Deformer 顺序，都足够让最终画面偏得很明显。。。
