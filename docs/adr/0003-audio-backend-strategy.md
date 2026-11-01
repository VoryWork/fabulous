# ADR-0003：音频后端选型 —— WASAPI / DirectSound / ASIO，默认不独占

> 状态：**已决定**
> 日期：2026-11-01
> 关联：`ROADMAP.md` M2（音频引擎）、ADR-0001、PRD §11 C

---

## 1. 决策

| 项 | 决定 |
|---|---|
| **支持的后端** | WASAPI、DirectSound、**ASIO**（三者都要） |
| **默认模式** | **不独占**（共享模式） |
| **独占模式** | 提供，但需用户显式开启（"低延迟模式"），不作为默认 |
| **默认后端** | WASAPI 共享 |
| **降级顺序** | WASAPI 共享 → DirectSound → （失败则静音，但时间轴仍可用） |

---

## 2. 为什么默认不独占

### 2.1 用户场景决定的

这是**音乐研究/学习工具**，不是宿主 DAW。用户的实际行为：

- 一边播放一边查资料（浏览器、PDF 阅读器）
- 一边播放一边看乐谱
- 偶尔在 DAW 里对照
- 开着会议软件/聊天

**独占模式会把这些全部掐断** —— 用户播一下就被迫关掉浏览器，体验极差。

### 2.2 独占的代价收益比很低

| 模式 | 延迟 | 对"听辨校对"够不够 |
|---|---|---|
| WASAPI 独占 | 3–5 ms | 绰绰有余 |
| **WASAPI 共享** | **10–30 ms** | **够**（人耳对 <50ms 的启动延迟基本无感） |
| ASIO | 1–10 ms | 绰绰有余 |
| DirectSound | 20–50 ms | 勉强够 |

本产品的核心交互是"点击和弦 → 听这一小段"，**不是实时演奏**。
30ms 的延迟意味着按下后 1/30 秒开始响 —— 用户不会觉得"卡"。

**用 20ms 延迟换"能同时开浏览器"，非常划算。**

### 2.3 独占还会带来这些问题

- **设备丢失**：切到独占后，其他软件的音频流会被强制中断，用户以为"软件坏了"
- **热插拔崩溃**：独占模式下拔耳机，很多驱动直接崩
- **多设备冲突**：用户同时接了声卡和蓝牙，独占会锁死一个

---

## 3. 各后端的技术现实（这里必须说清楚）

### 3.1 WASAPI

```
共享模式（Shared）   ← 默认
  · 通过与系统混音器共享设备
  · 延迟 10–30ms（受系统音频引擎周期影响）
  · 采样率由系统混音格式决定，需要我们自己重采样
  · 优点：任何设备都能用，不干扰其他软件

独占模式（Exclusive）  ← 可选，默认关闭
  · 直接接管设备，绕过系统混音器
  · 延迟 3–5ms
  · 缺点：其他软件立刻没声音；采样率必须与设备支持的完全一致
```

Rust 实现：`wasapi` crate 或 `cpal` 的 WASAPI backend。

### 3.2 DirectSound

```
天生共享，无独占选项
  · 延迟 20–50ms（走 DirectSound → 系统混音器的模拟层）
  · 优点：对老声卡/老驱动最宽容
  · 缺点：延迟最大，微软已标记为 legacy
```

**定位：兼容兜底**。只有在 WASAPI 初始化失败（罕见，通常是驱动异常）时才用。

Rust 实现：`cpal` 没有 DirectSound backend，需要直接用 `windows` crate 调 `DirectSoundCreate8`。

> 这条是本次决策的**主要新增工作量**（约 1–2 天）。
> 但因为它是最后一道兜底，可以放到 M2 末尾。

### 3.3 ASIO —— 一个必须承认的限制

> **ASIO 在绝大多数驱动下是独占的，这不是我们可以选的。**

ASIO 的设计就是"一个 client 独占设备"。Steinberg 的规范里没有"共享"概念。
所以：

| ASIO 场景 | 结果 |
|---|---|
| 没开其他 ASIO 软件 | ✅ 能用 |
| 开着 DAW（已占用 ASIO 设备） | ❌ 打不开，必须让用户选 WASAPI |
| 多个 ASIO 应用同时 | ❌ 不可能 |

**所以"不独占"对 ASIO 只能做到"我们不主动抢"，做不到"多应用共享"。**

UI 必须提示这一点：选了 ASIO 之后如果打不开，明确告诉用户
「ASIO 设备可能被其他程序占用，请关闭它或切换到 WASAPI」。

**ASIO 的定位：给接了专业声卡的用户一个可选项，不默认启用。**

Rust 实现：`cpal` 的 `asio` feature（需要 ASIO SDK 头文件做编译期依赖，但**编译产物可分发**）。

---

## 4. 对 ROADMAP 的修正

### 原计划（已废弃）

```
ASIO → WASAPI 独占 → WASAPI 共享 → DirectSound 降级链
主用 WASAPI 独占（3–5ms 已足够听辨校准）
```

### 新计划

```
默认：WASAPI 共享（10–30ms）
可选：低延迟模式（WASAPI 独占 / ASIO）
兜底：DirectSound
```

### M2 任务调整

| 任务 | 变化 |
|---|---|
| 2.2.1 设备枚举与降级链 | 降级顺序改为 `WASAPI共享 → DirectSound`；ASIO **不在降级链里**，是用户显式选的独立后端 |
| 新增 2.2.1b | DirectSound 后端（用 `windows` crate 直接调 `DirectSoundCreate8`） |
| 新增 2.2.1c | 「低延迟模式」开关（切 WASAPI 独占 / ASIO）+ 占用失败时的友好提示 |
| 2.2.3 ring buffer | 缓冲区按**最坏延迟**（DirectSound 50ms）设计，避免共享模式下 underrun |
| M2 退出条件 | 增加：三个后端都能出声；切独占失败不崩溃、能自动退回共享 |

---

## 5. 前端已经做了什么（本次）

播放链路已打通，且**为后端留好了接口**：

```ts
// client/src/timeline/audio/AudioEngine.ts
interface AudioEngine {
  load(src: string | null): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(sec: number): void;
  currentTime(): number;
  duration(): number;
  isPlaying(): boolean;
  setLoop(a: number | null, b: number | null): void;
  onTimeUpdate(cb: (sec: number) => void): void;
  // ...
}
```

现有两个实现：
- `SilentEngine` —— 无音频时静音推进（当前默认，验证时间轴）
- `WebAudioEngine` —— HTMLAudioElement（用户选本地文件时的临时方案）

**M2 只需新增 `TauriAudioEngine implements AudioEngine`，调用 Rust 的
`playTick/setLoop/getPosition`，上层组件一行不改。**

### 引擎与时间换算的分工（重要）

```
音频引擎    只关心「秒」，不知道拍号
usePlayback 用 TempoMap 做 秒 ⇄ Tick 换算
组件        只渲染 playheadTick
```

变速歌曲里"1 秒前进多少 tick"是变化的。如果引擎自己算 tick，
遇到变速段落播放头就会和音频脱节。

---

## 6. 已知限制（本阶段）

| 限制 | 影响 | 何时解决 |
|---|---|---|
| `<audio>` 定位精度约 20–50ms | 不够做 PRD A12 的采样级 A/B | M2（Rust 后端 `playTick`） |
| 波形是合成假数据 | 位置不真实 | M2（后端 ffmpeg 峰值） |
| 无采样率转换 | 设备 48k / 文件 44.1k 时音高会错 | M2（`rubato` 重采样） |
| 无设备热插拔处理 | 拔耳机可能报错 | M2 |

这些都不阻塞 M1 的交互验证，且都在 M2 的计划内。
