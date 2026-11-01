# 音乐和声研究工作台｜产品需求文档（PRD）

> **版本**：v2.0 · 自研时间轴架构版  
> **日期**：2026-11-01  
> **状态**：产品与研发基线 / 可进入技术验证  
> **产品暂定名**：Harmonic Atlas（工作名称，不代表最终品牌）  
> **平台**：Windows 本地优先，桌面浏览器 UI；可按需扩展桌面打包  
> **交付对象**：产品设计、前端、后端、音频/AI 集成工程师  
> **设计依据**：前期关于五首歌日常分析、级数关系检索、MP3 回听、变速统一网格、调性重叠，以及**参考开源实现但自研时间轴**的完整讨论。

---

## 0. 本次重构的决定

本版是重新定义实现边界，不是 v1.1 的措辞更新。

| 项目 | 最终决定 | 不采用的做法 |
|---|---|---|
| 时间轴编辑器 | 自研音乐专用时间轴内核；参考成熟开源项目的状态机、拖拽与渲染思路 | 直接嵌入 `vue-timeline-editor` / React Timeline Editor，迁就它们的秒数模型 |
| 指针交互 | 使用浏览器原生 Pointer Events、自有状态机与约束引擎 | 在核心事件块上依赖第三方 Timeline/Drag-and-Drop 组件 |
| 核心时间坐标 | 960 PPQ 的**整数 Tick**；全部音乐事件共享一个逻辑网格 | 用浮点秒数表示和弦、段落、级数及歌词的编辑位置 |
| 音频同步 | Beat/Tempo Map 实现 Tick ⇄ 原始音频秒数的双向映射 | 假定整首歌固定 BPM；简单按小节编号乘固定秒数 |
| 拍号的 UI | 拍号合并显示在段落结构块；段落内特殊变拍通过局部标记操作 | 在主工作台常驻独立拍号轨 |
| 拍号的底层事实 | 独立 Meter Map，允许与段落边界不一致 | 把拍号仅作为 `section.meter` 字段存储 |
| 调性与级数 | 多个**可重叠**解释轨，一个实际和弦可同时有多个级数身份 | 全曲唯一调性，或每一时刻只能有一个和声级数 |
| 音乐 AI | 集成现成模型，AI 输出作为待校对候选 | 研发首版自训和弦/段落/BPM 识别模型 |
| 知识库 | 以可复现的和声事件及邻接关系建索引，点击回听原始音频 | 只按“借用和弦、次属和弦”等理论词语分类 |
| 内容存储 | SQLite 保存结构化事实；Markdown 保存研究记录及可再生索引 | 把 Markdown 中的自然语言当作唯一和声数据库 |

### 0.1 一句话产品定义

**一个以节拍网格为核心、集成现成 AI 分析、支持复杂转调与多重级数解释、能够把真实音乐作品沉淀为可检索并可回听的和声语料库的本地研究工具。**

### 0.2 主要价值

使用者希望每天研究约五首歌，整理和声、节奏、段落、转调和编曲思路。完成分析后，不仅得到五份 Markdown，还得到逐步增长的**可追溯音乐案例数据**：将来写到某个调外和弦，可以查询它在实际作品里经常如何进入、如何离开、如何被重新解释，并听到真实的上下文。

### 0.3 成功条件

- 从导入 MP3 到初步形成和弦/节拍/段落候选，无须重新手工扒一遍全曲。
- 转调时能继续编辑和校对，绝对和弦标签不会因换调而被覆盖。
- 拖动、伸缩、吸附、缩放、撤销等基本编辑交互具有 DAW 式的一致性。
- BPM 在曲中变化、拍号在段落间变化，所有轨道仍在同一个音乐坐标上准确对应原音频。
- `Fmaj7` 在 C 大调为 `IVmaj7`、在 F 大调为 `Imaj7` 的双重解释可**同时显示、分别保存、独立确认、关联索引**。
- 查询 `vi7 → ♭VImaj7 → V7` 后可以直接回听源 MP3 的对应片段。
- 完成一首歌的研究后，结构化信息和 Markdown 能稳定归档；重新分析不会抹掉人工劳动。

---

## 1. 用户、范围与非目标

### 1.1 目标用户

以具有一定乐理、创作、编曲和听辨基础的个人研究者为核心；主要关心 J-Pop/J-Rock、R&B/Soul、电子、Jazz、古风等作品的和声组织、节奏律动和曲式变化。用户有能力判断 AI 是否识别错误，需要的是减少机械操作并积累知识。

### 1.2 主要用户旅程

1. 导入五首音频，可选配对五份 LRC。
2. 选择和弦/段落/拍点预训练模型并批量分析，获得带时间戳的候选。
3. 系统建立一条共同的 Tick 网格，生成小节、强拍、Tempo Map；和弦、段落和歌词落到网格上。
4. 用户重点校对复杂段落、转调、临时主音化、变速位置；必要时手动拖动或伸缩块。
5. 对值得研究的和弦，增加一条或多条调性解释轨并确认级数/功能。
6. 记录具体的和声作用、声部运动、节奏与配器观察，形成单曲 Markdown。
7. 自动更新目标级数、前驱、后继、三和弦上下文、枢纽重解释等索引。
8. 日后通过查询命中案例，一键回听歌曲原本的音频区间，并跳回时间轴核查。

### 1.3 首版包含（P0）

- 导入 MP3、FLAC、WAV 与常规 LRC；本地曲库管理。
- 已有模型的和弦、段落与拍点推理适配器；允许手工填入全部数据。
- 自研 Tick 时间轴内核：绘制、编辑、吸附、拖放、左右伸缩、缩放滚动、撤销重做。
- 支持分段或逐拍变速的 Tempo Map、变拍号 Meter Map、弱起和音频时间偏移。
- 段落轨内嵌拍号；结构块分割合并、任意段落标签与重复组。
- 绝对和弦事件、可重叠调性轨与级数解释、枢纽重解释。
- 五种和声索引、原音频定位回听。
- 单曲 Markdown、自动生成索引、备份与恢复。

### 1.4 P1/P2 与非目标

- **P1**：跨作品 A/B 回听、调速不变调、根音/声部运动索引、节奏模式索引、精细逐字歌词、钢琴键盘可视化、MIDI/MusicXML 辅助导入。
- **P2**：用户自定义分析插件、协作、云同步、自动生成高级理论解释与高质量旋律转写。
- **非目标**：全功能 DAW、在线音乐平台、商业音频素材共享、从零训练大型识别模型、自动保证任何复杂作品分析完全正确。

---

## 2. 产品信息架构与页面

### 2.1 四个核心页面

| 页面 | 主要内容 | 关键动作 |
|---|---|---|
| P01 导入与 AI 分析 | 批量导入、曲目元数据、模型设置、任务队列、LRC 关联 | 创建项目、开始/重跑单项分析、打开工作台 |
| P02 多轨分析工作台 | 统一小节网格、Tempo、段落/拍号、绝对和弦、重叠级数轨、歌词、波形、属性面板 | 试听、校对、分段、拖动/伸缩、编辑分析解释 |
| P03 和声关系检索 | 条件组合、级数与邻接、枢纽、案例列表、迷你播放器 | 搜索、筛选、回听、返回原小节 |
| P04 单曲研究档案 | 曲式、转调、节奏编曲笔记、关键案例、Markdown 预览与编辑 | 保存知识、打开具体案例、导出/复制 Markdown |

### 2.2 视觉与布局规范

参考用户给出的白底工业风网页设计所体现的**信息层次和秩序感**，不直接复制网站本身：

- 主体为白底/浅灰，黑色文字，克制使用高饱和橙色作为当前选中和主要操作；不采用通篇蓝紫渐变、玻璃质感或大面积圆角卡片。
- 轨道以水平细分割线组织，强调**精确位置与信息密度**。真正有音乐意义的段落和调性关系用色块区分，而不是对每个元素都加粗框。
- 辅助性工业纹理只放在页头、空白或辅助说明区，不干扰小节标尺、波形和文本。
- 16:9 桌面优先，最小有效工作区建议 1366×768；1920×1080 为主要设计基准。
- 轨道标签列固定宽度，右侧属性面板可隐藏、调宽；鼠标位置附近常用操作不应全部藏在右侧。
- 同一层级的按钮、行高、选中态、焦点态和禁用态统一；字体小字号下需清晰，默认无衬线中文字形。
- 默认隐藏拍号独立轨；显示在段落条 `Verse A · 4/4` / `Bridge · 3/4`，不牺牲一整行。

### 2.3 P02 工作台布局建议

自上而下：

1. **顶部交通控制**：播停、上一/下一事件、当前音频时间、当前小节/拍/细分、循环、节拍器可选。
2. **工具条**：选择、绘制、切割、吸附开关与粒度、缩放、轨道显示控制、撤销/重做。
3. **小节标尺**：Bar、拍线、播放头；可固定视口。
4. **Tempo 曲线轨（折叠）**：BPM 节点/逐拍锚点的高级编辑入口。
5. **段落结构轨**：名称、重复组、继承/变化的拍号，切分合并与边界拖动。
6. **绝对和弦轨**：真实和弦标识、区间、状态（AI/确认）、区间拖动与双端缩放。
7. **和声级数轨 A..N**：每条绑定一种调性解释；彼此可以重叠、独立隐藏/锁定。
8. **歌词轨**：LRC 的歌词片段或起点标记。
9. **音频波形轨**：波形与节拍对齐展示。
10. **属性检查器**：所选事件的音名、功能、调性、起止 Tick、来源和评论。

轨序可调，主标尺和标签列不可随横向滚动离开；同一事件在绝对和弦轨及多条级数轨同步高亮。

---

## 3. 时间与音乐坐标模型（核心约束）

### 3.1 坐标定义

**所有编辑后的音乐事件使用整数 Tick 作为唯一规范位置，PPQ=960。**

```ts
const PPQ = 960; // ticks per quarter note

type Tick = number; // nonnegative safe integer; allow pickup via song origin offset

type TickRange = {
  startTick: Tick;
  endTick: Tick;   // exclusive
};
```

- 4/4 小节长度：`4×960=3840 ticks`。
- 3/4 小节长度：`3×960=2880 ticks`。
- 6/8 小节长度：`6×(960/2)=2880 ticks`；允许将节奏重音分成 3+3，作为两组附点四分音符。
- 按四分音符为 1 拍时，1/4 拍=240 ticks、1/3 拍=320 ticks、1/8 拍=120 ticks。
- 复合拍号的 UI 可显示“每小节 6 个八分音符”，但内部所有音符长度仍以四分音符 PPQ 统一度量。**不要将显示拍号的分母和网格吸附粒度混为一谈。**
- 支持吸附：1、1/2、1/3、1/4、1/6、1/8、1/12、1/16 四分拍细分；禁用吸附时仍保存整数 Tick，允许高精度定位。
- 边界使用半开区间 `[startTick,endTick)`，避免相邻和弦共用一个 Tick 时被误判为重叠。

### 3.2 Beat/Tempo Map

用户操作的是等距音乐网格，但原曲音频根据真实速度播放。Beat Map 定义严格单调的锚点：

```ts
type BeatAnchor = {
  tick: number;
  sec: number;
  kind: 'beat' | 'downbeat' | 'manual';
  provenance: 'model' | 'user' | 'import';
  confidence?: number;
};
```

两个相邻锚点 `[tick0, sec0]`、`[tick1, sec1]` 之间，首版采用单调分段线性插值：

```text
sec(tick) = sec0 + (tick - tick0) / (tick1 - tick0) × (sec1 - sec0)
tick(sec) = tick0 + (sec - sec0) / (sec1 - sec0) × (tick1 - tick0)
```

该方式支持固定 BPM、突然变速、逐拍渐快渐慢和人工演奏的微小速度漂移。局部 BPM 用相邻锚点之间的四分音符时间推导；只有在明确选择“理想化 Tempo 曲线”时，才使用拟合后的 BPM 曲线描述速度。**Beat Map 是音频对齐的权威来源，显示的 BPM 是导出结果或编辑入口。**

#### 必须支持的编辑

- 单个拍点拖动、增删拍点、对齐强拍、设置局部 BPM、段落内变速、可选 Tempo Ramp。
- Half-time / Double-time 错判修正；三连律动/附点拍层级修正。
- 首个实际重拍可能不是音频时间 0；保存 `audioOffsetSec` 和/或首个已知 Beat Anchor。
- Beat Map 必须单调：相邻 anchor 的 Tick 与秒数都严格递增；拒绝交叉或零长度区间。
- 模型识别前后的一小段无节拍音频，可显示不完整映射并提示修正；禁止静默无限外推。

#### 修改 Beat Map 的迁移语义

- 已确认的音乐事件（和弦、段落、歌词、调性解释）**保留 Tick**。Beat Map 改变后重新计算其对应秒数。
- 尚未确认的 AI/LRC 候选保留 `rawStartSec` 等数据，允许用户选择“根据原始秒数重新贴合网格”。
- 大范围 Warp 时给出预览、影响范围和可一次撤销的事务；不自动改写已确认内容。

### 3.3 Meter Map 与段落关系

拍号在**视觉呈现与编辑入口**上依附段落结构，但底层仍为独立事件：

```ts
type MeterEvent = {
  id: string;
  tick: number;                 // 默认要求小节边界
  numerator: number;
  denominator: number;
  grouping?: number[];         // 例如 6/8: [3,3]
  owningSectionId?: string;    // 有则随段首联动
};
```

- 新段落默认继承之前生效的拍号；无需重复新建 Meter Event。
- 在段落属性选择“拍号改为 3/4”时，于段首生成/更新 `MeterEvent`，段落标题显示 `Bridge · 3/4`。
- 段落中途临时 2/4 小节：仍是一个 Verse，仅在段落轨内部显示紧凑 `2/4` 变化标记；恢复 4/4 需记录另一事件。
- 小节分割/编号根据 Meter Map 推导。段落边界不等于小节边界，允许有延长、弱起以及跨小节段落，但拍号变化默认吸附到小节边界。
- 段落分割、合并或边界移动时，与段首绑定的 Meter Event 要么联动移动，要么由用户改为独立；操作界面明确提示。
- 对于弱起小节，用 Song Bar Origin / Pickup 定义小节编号，不要求音频开头就有完整第 1 小节。

### 3.4 全部轨道共享横坐标

时间轴页面默认以 **Tick 等间距**显示，X 轴不直接使用音频秒数。音频秒数用于播放、导入模型结果与 LRC 对齐。

```ts
type Viewport = {
  originTick: number;          // 内容坐标原点
  scrollX: number;             // px
  pixelsPerTick: number;
};

function tickToX(tick: number, v: Viewport): number {
  return (tick - v.originTick) * v.pixelsPerTick - v.scrollX;
}

function xToTick(x: number, v: Viewport): number {
  return v.originTick + (x + v.scrollX) / v.pixelsPerTick;
}
```

同一 `Viewport` 必须被网格、波形、事件块、歌词、播放头和悬浮辅助线复用，**禁止每一轨单独维护滚动偏移或缩放比**。

- 缩放时以鼠标所指音乐位置作为锚点，缩放前后该 Tick 的屏幕 X 尽量不变。
- 横向滚动改变 `scrollX`；不改变事件 Tick。
- 在同一布局坐标系下计算 DOM 片段和 Canvas 网格的位置，避免 transform/scroll 双重计算。
- 波形的 PCM/Peak 数据仍按音频秒数记录；绘制时对当前像素对应的 Tick 区间转换回秒区间，取峰值范围，形成视觉 Warp。**不做声音 Time Stretch。**

### 3.5 导入时间与网格量化

现有和弦模型、结构模型、LRC 均输出秒数。导入步骤：

1. 记录原始 `rawStartSec/rawEndSec`、模型版本与音频指纹。
2. 用已确认的 Beat Map 转为 `startTick/endTick`。
3. 根据轨道和当前 Snap 设置，生成**可审阅**的量化候选；不要把自动量化当作已确认分析。
4. 手工调整后，提交整数 Tick，保留原始秒数用于溯源与纠错。

默认吸附策略：和弦 1/4 拍，段落强拍/小节边界，歌词默认高精度或可关闭粗吸附。三连音或复合拍号下可以切换 1/3 拍等网格；不得因为 LRC 的演唱时间略微抢拍就强制吸附到最近四分拍。

---

## 4. 自研时间轴内核（新增的强制工程规格）

### 4.1 实现原则

**从成熟开源时间轴中学习交互模式和测试场景，不引用其完整 Timeline 编辑器，也不照搬其数据模型。**

- 核心代码全部由项目维护：Tick 几何、网格、片段渲染、交互状态机、约束验证、Undo/Redo。
- 可使用 Vue 3、浏览器 Pointer Events、Canvas 2D、标准 Web Audio/HTML Audio，以及不接管编辑逻辑的一般工具库。
- 不依赖 HTML5 原生 Drag-and-Drop（适合文件拖入，不适合精确拖动音符/和弦片段）。
- 时间轴内部不保留“浮点秒数作为事件权威位置”的兼容层。
- 引入外部库时，仅限通用型辅助功能（图标、文件导入、数据库、音频解码等），不得让外部时间轴组件决定业务约束。

### 4.2 分层设计

```text
src/timeline/
├── domain/
│   ├── Tick.ts                  # 960 PPQ、整数 Tick、半开区间
│   ├── BeatMap.ts               # Tick ⇄ 秒，单调锚点
│   ├── MeterMap.ts              # 小节、拍号、弱起、重音分组
│   ├── TimelineGeometry.ts      # Tick ⇄ X，缩放锚点
│   ├── SnapEngine.ts            # 网格/事件边界/辅助线吸附
│   ├── ConstraintEngine.ts      # 各轨可移动/缩放规则
│   ├── EditCommands.ts          # 一次编辑事务、Undo/Redo
│   └── TimelineSelection.ts     # 单选、多选、范围选择
├── interaction/
│   ├── PointerController.ts     # pointerdown/move/up/cancel
│   ├── GestureStateMachine.ts   # Move/ResizeLeft/ResizeRight/Pan
│   ├── EdgeAutoScroll.ts        # 拖动到边缘连续滚动
│   └── KeyboardShortcuts.ts
├── render/
│   ├── GridCanvas.ts            # 小节/拍线、刻度与辅助线
│   ├── WaveformCanvas.ts        # 节拍坐标下的音频波形
│   ├── VisibleRange.ts          # 仅渲染当前范围与缓冲带
│   └── TrackLayout.ts           # 轨道垂直布局
├── components/
│   ├── TimelineViewport.vue
│   ├── TimelineRuler.vue
│   ├── TimelineTrack.vue
│   ├── ChordClip.vue
│   ├── SectionClip.vue
│   ├── DegreeClip.vue
│   ├── LyricMarker.vue
│   └── TimelineInspector.vue
└── tests/
    ├── geometry.spec.ts
    ├── snapping.spec.ts
    ├── edit-constraints.spec.ts
    ├── beat-meter-map.spec.ts
    └── pointer-interactions.spec.ts
```

可按真实工程重命名文件，但职责拆分和纯逻辑可测性不可省略。

### 4.3 渲染选型

- **Canvas 2D**：网格、小节线、波形、背景、临时辅助线、选区轮廓；大量重复元素可用离屏缓存、分辨率层次抽样。
- **DOM/Vue**：和弦块、段落块、级数解释块、歌词文本、缩放手柄、悬浮菜单、检查器。复用普通浏览器文字布局与键盘可访问性。
- **统一渲染时钟**：Canvas 与 DOM 都消费同一 Viewport 快照和相同事件 revision；拖动预览通过 requestAnimationFrame 合批更新。
- **可视范围裁剪**：只生成当前视口与安全缓冲区内的 Clip DOM；长歌与多轨时避免渲染数千个不可见节点。
- **波形缓存**：预计算多分辨率 Min/Max Peaks；对 Beat View 按当前音频秒区间聚合峰值，不对完整原始 PCM 做逐帧 JS 计算。

### 4.4 指针手势状态机

```text
Idle
  ├─ pointerdown on clip body ──► PendingMove
  ├─ pointerdown on left handle ► PendingResizeLeft
  ├─ pointerdown on right handle ► PendingResizeRight
  └─ pointerdown on empty space ► PendingSelection/Pan
Pending...
  ├─ crossed drag threshold ────► ActiveGesture
  ├─ pointerup ────────────────► SelectOnly / Idle
  └─ cancel/Escape ────────────► Idle
ActiveGesture
  ├─ pointermove ─► Calculate → Snap → Validate → Preview
  ├─ pointerup ───► Commit One Transaction → Idle
  └─ cancel/Escape/blur ─► Restore Snapshot → Idle
```

**具体要求：**

1. Pointer Down 时记录源事件初态、鼠标初始 X、初始 Scroll、初始 Viewport、Pointer ID、手柄方向，调用 `setPointerCapture()`。
2. Pointer Move 不累计增量误差：始终从**按下时的快照 + 当前鼠标位置与当前滚动**计算候选 Tick。
3. 根据手势模式生成候选区间，调用 `SnapEngine`，再调用独立的 `ConstraintEngine`。
4. 拖动中的 DOM 是临时预览，**不在每次 pointermove 写 SQLite、Markdown 或 Undo 历史**。
5. Pointer Up 只提交一次事务，作为一条可撤销命令；提交失败恢复初始状态并说明冲突。
6. 必须处理 `pointercancel`、`lostpointercapture`、Escape、窗口失焦、滚动容器消失、触摸/触控笔输入。
7. 片段身体的移动和左右手柄的 Resize 是独立状态，事件判定必须互斥。

### 4.5 Snap 引擎

吸附来源分三类，显示不同辅助线：

1. **节拍网格**：1/2、1/3、1/4、1/8 等步长，以整数 Tick 表示。
2. **事件边界**：其他和弦/段落/调性区间的起止边界。
3. **音乐标记**：小节强拍、循环点、转调标记、人工 Anchor。

建议优先级可配置：强制网格 > 用户指定辅助线 > 临近事件边界；对于“最近对象”的选择必须使用**屏幕像素阈值**，避免不同 Zoom 下手感发生明显变化。Alt 暂时取消吸附；吸附目标应有可见反馈。

```ts
function quantize(tick: number, step: number): number {
  return Math.round(tick / step) * step;
}

// 核心过程示意，真实项目需处理拖动方向、跨边界和负值限制
function proposeMove(initialStartTick: number, deltaTick: number, snapStep: number) {
  return quantize(initialStartTick + deltaTick, snapStep);
}
```

不应在绘制层自行吸附；所有编辑入口共享同一纯函数行为。

### 4.6 缩放、滚动与自动滚动

- Zoom 的锚点是鼠标下方 Tick，缩放后该 Tick 在屏幕上的 X 位置保持不变；最小/最大缩放由可读性确定。
- 左侧轨名和顶部标尺固定，横向只滚动内容区；横向滚动不影响纵向轨道布局。
- 片段拖至视口左右边缘时自动滚动；按距离边缘的像素计算滚速并设置上限，不触发指针跳跃。
- Auto-scroll 每帧使用**当前 Scroll + 当前指针 X**重新计算预览 Tick；边缘停止时不得再次提交多余变更。
- 水平 Scrollbar、触控板、Shift+Wheel 等输入走同一 viewport store；禁止各轨自行控制 scrollLeft。
- 滚动/Zoom 大幅变化时仅重绘可见 Clip，并保留选中与临时操作状态。

### 4.7 轨道约束策略

| 轨道 | 是否可移动 | 双端缩放 | 同轨重叠 | 特殊规则 |
|---|---|---|---|---|
| 绝对和弦 | 是 | 是 | 默认禁止 | `N` 无和弦亦视为事件；移动不得破坏已确认相邻事件 |
| 段落结构 | 是（边界操作） | 是 | 同一结构层默认禁止 | 相邻边界可联动；段首附属 Meter Event 需协同更新 |
| 调性上下文 | 是 | 是 | **跨分析层允许** | 同一层默认一个主解释；并列假说放不同层 |
| 和声级数解释 | 不直接作为独立音响移动 | 有效范围取决于父事件/上下文 | **允许多个层同时显示** | 修改解释文本不会移动父和弦；事件调整后投影重算 |
| 歌词 | 是 | 按句可选 | 可允许 | 不能强制粗量化；优先保证与实际演唱对齐 |
| Tempo/Beat Anchor | 受限 | 不适用 | 不允许时间倒序 | 严格单调，改变后对整个有效区间重新映射 |
| 波形 | 否 | 否 | 不适用 | 只读；位置由 Beat Map 变换 |

这些约束由 `ConstraintEngine` 负责，组件层不得散落一套相互矛盾的检查规则。

### 4.8 编辑事务与历史

- **单一命令**：例如 `MoveChord`、`ResizeChord`、`SplitSection`、`SetSectionMeter`、`MoveBeatAnchor`、`AddDegreeInterpretation`。
- 一条命令包含前置校验、受影响实体、`before/after` 快照和可逆操作；批量移动或附属拍号变化须原子提交。
- Undo/Redo 保持至少 100 个可用步骤；重做链遇到新提交时按常规编辑器规则失效。
- 自动保存和命令提交是两个层次：先更新可靠的内存状态/本地事务，再节流持久化；异常退出需不丢失已确认提交。
- AI 重跑、新索引重建等后台任务不得插入或破坏用户正在进行的拖动事务。

### 4.9 不在此层实现的逻辑

Tick UI 内核不懂和弦性质、次属功能、模型词表、Markdown 模板，也不决定什么是“正确转调”。它只知道 `Track`、`Clip`、`TickRange`、`ConstraintPolicy`、`Viewport`。音乐业务通过适配器连接，降低未来替换技术栈的成本。

---

## 5. 和声、调性、转调与索引

### 5.1 三类独立实体

```ts
type ChordEvent = {
  id: string;
  recordingId: string;
  startTick: number;
  endTick: number;
  symbol: string;                // Fmaj7，独立于调性
  status: 'draft' | 'reviewed' | 'confirmed' | 'rejected';
  rawStartSec?: number;
  rawEndSec?: number;
};

type TonalContext = {
  id: string;
  recordingId: string;
  layerId: string;
  startTick: number;
  endTick: number;
  tonic: string;                 // C / F ... 保留音名拼写
  mode: string;                  // major/minor/other
};

type DegreeInterpretation = {
  id: string;
  chordEventId: string;
  contextId: string;
  degree: string;                // IVmaj7 / Imaj7
  functionTags: string[];        // borrowed / pivot / V-of-V...
  notesMd?: string;
  status: 'draft' | 'reviewed' | 'confirmed';
};
```

**重要：一个 ChordEvent 只存一次；可以被多个 DegreeInterpretation 引用。** 调性上下文重叠不是两个和弦事件重叠。

### 5.2 一次枢纽和弦的双重解释

例如：

```text
Actual chord event: Fmaj7
Old lens (C major): IVmaj7
New lens (F major): Imaj7
Pivot link: old interpretation ──reinterpret──► new interpretation
```

- 两条和声级数轨可同时覆盖同一 Tick 区间。
- 切换、隐藏、锁定某条轨道不影响另一条轨道的确认状态。
- 用户可以手工指定一个级数或功能标签，自动候选不能覆盖。
- Pivot Link 独立保存旧/新解释 ID、转调说明、证据与对应音频范围；不是仅靠两个调性重叠就自动认定为枢纽。
- 允许不确定性：两个并列候选可处于 `reviewed`，待确认为何时真正转调；正式索引只纳入 `confirmed`。

### 5.3 罗马数字与音名标准化

- 绝对和弦包含根音、和弦性质、扩展音、变化音、Slash Bass；保留原模型原文与用户最终修订符号。
- 级数可表示根音音级 + 和弦性质（如 `♭VImaj7`、`iv7`、`II7`），功能解释独立存储（如 `V7/V`、调式借用、三全音替代）。
- 考虑同音异名与调式中的级数拼写；不要无条件把 `C♯` 与 `D♭` 混成同一个乐理标签。可建立音高类（pitch class）用于宽松检索。
- 调外判定依赖某条确定的调性/调式上下文，不能根据全曲开头的 Key 判定。

### 5.4 五大关系索引

| 索引 | 关键查询 | 输出 |
|---|---|---|
| 目标级数 | `♭VImaj7` | 它出现在什么歌曲、哪一小节、什么调性视角 |
| 前置关系 | `vi7 → ♭VImaj7` | 调外和弦的进入方式 |
| 后续关系 | `♭VImaj7 → V7` | 调外和弦的离开方式 |
| 完整邻接 | `vi7 → ♭VImaj7 → V7` | 三和弦上下文及音频比较 |
| 枢纽重解释 | `IVmaj7 (旧调) → Imaj7 (新调)` | 同一和弦跨调性角色变化与目标调 |

**邻接算法：** 以同一录音、绝对和弦事件的 Tick 顺序决定真正的“前一个”和“后一个”；对检索级数的解释则必须绑定清晰的**分析视角**，不能从两条调性轨随意拼出本来不存在的级数序列。

为支持“目标和弦前后的声音是什么”，对单个目标解释可在**同一调性视角**下重新投影相邻绝对和弦，即使邻接事件略超出该调性轨覆盖范围，也应标记 `contextualProjection=true`；跨调关系另有经确认的解释路径。索引 UI 允许按“仅在调性上下文内”“包含临近跨界投影”“显式跨调路径”切换。

“没有和弦”的 N 区间默认断开邻接；提供可选“跳过 N”。

**统计明确区分**：音响事件数、解释实例数、唯一录音数和符合条件的连续序列数，避免一个枢纽和弦因为双解释被重复记为两首案例。

### 5.5 试听案例

案例数据应该至少关联：

```json
{
  "caseId": "hc-001",
  "recordingId": "rec-001",
  "chordEventIds": ["c-008", "c-009", "c-010"],
  "targetChordId": "c-009",
  "interpretationId": "interp-c-009",
  "pivotLinkId": "pivot-001",
  "contextStartTick": 26900,
  "contextEndTick": 38300,
  "userNotesMd": "枢纽和弦的双重解释及前后声部运动。"
}
```

数据为示意，非实际歌曲。音频区间通过 Beat Map 在播放时得到秒数；原始文件只存一份。默认“前一个小节 + 目标区间 + 后一个小节”，可以手动编辑回听窗口。

---

## 6. AI、导入及人工校对

### 6.1 AI 适配器职责

模型仅承担已有能力：

| 任务 | 候选项目 | 标准化输出 | 关键风险 |
|---|---|---|---|
| 和弦识别 | `lv-chordia`，可选其他成熟开源模型 | 绝对和弦符号与秒数起止 | 转调、扩展和弦、Slash Bass、复杂混音 |
| 段落识别 | `all-in-one-infer` | 段落时间区间及功能候选 | Pre-Chorus/Build-up 类别缺失，边界错检 |
| 拍点/强拍 | `all-in-one-infer` 或 `Beat This!` | Beat/Downbeat 秒数与置信度 | 半速倍速、变速、复合拍号与弱起 |

**本表是可验证候选，不构成模型准确率或许可证承诺。** 开发前核对代码及权重的许可证、依赖版本、可用设备、输入输出契约与 Windows 离线运行表现；使用 10–20 首复杂样本比较实际人工校对耗时。

### 6.2 标准化原始输出

```ts
type ModelRun = {
  id: string;
  recordingId: string;
  modelId: string;
  modelVersion: string;
  sourceAudioHash: string;
  status: 'queued'|'running'|'completed'|'failed'|'canceled';
  originalArtifactPath?: string;
};

type RawChordCandidate = {
  startSec: number;
  endSec: number;
  rawLabel: string;
  confidence?: number;
};
```

- 保存模型原始 JSON 以便复盘；映射到 Tick 后进入 `draft` 轨，不直接覆盖已确认和弦。
- 不同 AI 模型独立失败，不阻断工作台；同一歌曲可以重新运行单一模型并与之前候选比较。
- 阶段性结果可显示，但在用户选择“应用候选”前不应修改正式数据。
- 模型处理使用独立 Python Worker；Bun 负责进程启动、状态、取消、媒体文件管理。

### 6.3 歌词 LRC 导入

- 读取标准 `[mm:ss.xx]`、`[offset:]`、同一行多个时间戳、元信息标记。
- 每句保留源时间戳；与原音频时间基校对后映射到 Tick。
- 歌词句可独立移动，不默认强吸附到 1/4 拍；若用户打开吸附，按设定粒度定位。
- 对于未提供结束时间的句子，显示下一句开始前的区间或仅开始点；不能推断演唱一定持续到下一句。
- 后期可加入逐字同步 LRC，P0 无需音素识别。

### 6.4 段落识别与段落轨

- AI 提供边界与标签候选，用户可更名 `Intro/Verse/Pre-Chorus/Chorus/Bridge/Solo/Interlude/Outro/Custom`。
- 支持多次出现的相同段落 `Verse A`、`Chorus A` 通过 `repeatGroupId` 关联，但每次出现都是独立的 Section 实例。
- 结构轨显示拍号、段落重复组与必要的内部变拍小标记。
- 段落模型与拍点模型可以不同；边界到最近小节强拍的吸附是可撤销、可关闭的人工辅助。

### 6.5 校对状态

`draft → mapped → reviewed → confirmed`，并支持 `rejected` 与返回修改。绝对和弦、Beat Map、段落和级数解释应**分别确认**；仅确认绝对和弦不能自动视为确认其调外功能。

---

## 7. Markdown 知识库与本地资料

### 7.1 存储原则

- **SQLite**：结构化权威事实（曲目、录音、Tick、节拍、调性、级数解释与关系）。
- **Markdown**：单曲研究内容、今日学习摘要、可再生的索引页。
- **原始音频**：保留源 MP3/FLAC 的一份文件，既可引用原路径，也可纳入受管目录。
- **生成的 Markdown 索引禁止直接回写结构化数据库**；编辑手工笔记与重建索引必须安全隔离，避免覆盖。

### 7.2 推荐目录

```text
Music-Research/
├── README.md
├── songs/
│   ├── song-0001.md
│   └── song-0002.md
├── indices/
│   ├── degrees/
│   ├── incoming/
│   ├── outgoing/
│   ├── progressions-3/
│   └── pivot-reinterpretations/
├── daily/
│   └── 2026-11-01.md
├── audio/                  # 可选：托管音频
├── models/                 # 结果缓存/可选独立目录
└── data/
    └── research.sqlite
```

### 7.3 单曲 Markdown 示例

```markdown
---
song_id: song-0001
recording_id: rec-0001
title: 示例曲目
analysis_date: 2026-11-01
---

# 示例曲目

## 段落结构
- Verse A：1–16 小节，4/4
- Bridge：17–24 小节，3/4

## 调性与转调
- 第 17 小节：Fmaj7 在 C 大调为 IVmaj7，在 F 大调为 Imaj7。

## 重要和声事件
- [事件 c-009](harmonic-atlas://song/song-0001?event=c-009)
- 录音：rec-0001 / 第 17 小节 / 试听范围：前后各 1 小节

## 节奏、编曲与声部观察
...

## 今天学到的东西
...

## 待验证问题
- [ ] ...
```

**说明**：上述 `harmonic-atlas://` 是拟定的应用内深链，不保证通用 Markdown 编辑器都能直接跳到 MP3 秒数。导出时同时保留稳定事件 ID、相对音频路径（若已托管）和明确时间段；在本地应用内保证点击即回听。

### 7.4 索引管理

- 自动索引每项包含：调性视角、实际和弦、前后级数、作品/段落、Tick 范围、事件 ID、音频定位。
- 重算结果必须可复现，支持全量重建与差量更新。
- 人工笔记保留历史；模型重跑、换调、重建索引不能导致已有笔记丢失。
- 允许以本地 Git 仓库备份 Markdown，但不作为运行前置条件。

### 7.5 每日学习验收（可配置，非强制打卡）

默认目标 5 首：4 首结构化速览 + 1 首重点；每天完成标准为**已形成可查记录并保存核心收获**。难题可以进待验证队列，不要求当天全部解决；没有值得录入的新和声案例也允许真实记为“本曲暂无新增案例”。

---

## 8. 结构化数据与本地 API

### 8.1 SQLite 表概览

| 表 | 关键字段 | 作用 |
|---|---|---|
| `songs` | `id,title,artists,genres` | 作品主体 |
| `recordings` | `id,song_id,path,hash,duration_sec,audio_offset_sec` | 录音版本与媒体指纹 |
| `beat_anchors` | `recording_id,tick,sec,kind,source,confidence` | 统一 Tick↔秒映射 |
| `meter_events` | `recording_id,tick,numerator,denominator,grouping,owning_section_id` | 小节与拍号事实 |
| `sections` | `id,recording_id,start_tick,end_tick,type,label,repeat_group_id,status` | 段落实例 |
| `chord_events` | `id,recording_id,start_tick,end_tick,symbol,status,raw_start_sec,raw_end_sec` | 唯一绝对和弦事件 |
| `analysis_layers` | `id,recording_id,name,color,visible,locked,display_order` | 并行和声级数轨 |
| `tonal_contexts` | `id,layer_id,recording_id,start_tick,end_tick,tonic,mode,status` | 可跨层重叠的调性范围 |
| `degree_interpretations` | `id,chord_event_id,context_id,degree,tags,status,notes_md` | 一个和弦的多重分析 |
| `pivot_links` | `id,old_interp_id,new_interp_id,notes_md` | 显式转调重解释 |
| `lyrics` | `id,recording_id,start_tick,end_tick,text,raw_sec` | LRC 句子与原始时间 |
| `model_runs` | `id,recording_id,model_id,version,status,artifact_path` | 推理溯源 |
| `song_notes` | `song_id,markdown_path,revision` | 手工 Markdown 入口 |
| `edit_transactions` | `id,recording_id,command,entity_changes,created_at` | Undo/Redo 与可靠持久化 |

**数据库约束：**

- `end_tick > start_tick`；Tick 为整数；同一录音 Beat Anchor 的 Tick 唯一且秒严格单调。
- 绝对和弦轨上禁止不经确认的同轨区间冲突。
- `tonal_contexts` 不设置全局“禁止重叠”约束；同一层有冲突时由该轨策略决定。
- 用外键和级联策略保证删除实体之前给出关联影响提示；删除一条和弦时不能留下失效解释索引。
- 保留各模型原始输出与人工修改记录，支持未来替换模型。

### 8.2 本地 API 草案

```text
POST   /api/recordings/import
GET    /api/recordings/:id
POST   /api/model-runs
GET    /api/model-runs/:id
POST   /api/model-runs/:id/cancel
GET    /api/recordings/:id/timeline
PATCH  /api/recordings/:id/beat-map
PATCH  /api/recordings/:id/meter-map
POST   /api/timeline/commands            # 事务式提交编辑命令
GET    /api/harmony/search
GET    /api/harmony/cases/:id
GET    /api/recordings/:id/audio         # Range 支持
GET    /api/recordings/:id/waveform-peaks
POST   /api/export/markdown
POST   /api/backup
```

接口版本、字段和传输方式属于内部拟定设计；所有修改命令携带期望 `revision`，避免异步 AI 结果与人工编辑覆盖冲突。默认本地 loopback 服务，不对公网开放。

---

## 9. 技术选型与执行边界

### 9.1 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | Vue 3 + Vite + TypeScript + Pinia | 适合自研时间轴组件与共享状态 |
| 编辑器交互 | Pointer Events + TypeScript 纯函数 + Canvas 2D/DOM | 直接控制 Tick、Snap、Resize、约束和渲染 |
| 播放 | HTML Audio（P0），可按需 Web Audio | 先满足本地定位回听，不从零做 DAW 音频引擎 |
| 本地 API | Bun | 本地服务、文件读写与模型 Worker 调度 |
| 数据 | SQLite + Markdown | 可检索、可迁移、可人工查看 |
| AI 推理 | Python Worker + 现成模型 | 与前端时间轴解耦、可替换 |
| 音频预处理 | FFmpeg / ffprobe | 解码、时长、重采样与波形峰值缓存 |
| 自动测试 | Vitest + Playwright | 纯逻辑测试与真实浏览器拖拽回归 |

### 9.2 不引用现成 Timeline 编辑器

允许在内部研发阶段参考以下项目的**公开架构思想**，但需要逐项核查协议并独立实现适合音乐 Tick 模型的代码：

- [React Timeline Editor](https://github.com/xzdarcy/react-timeline-editor)：轨道、片段操作、拖拽/缩放与自动滚动边界案例。
- [vue-timeline-editor](https://github.com/CuiMuxuan/vue-timeline-editor)：Vue 项目如何组织轨道与片段组件。
- [Interact.js](https://interactjs.io/)：拖拽、缩放、吸附行为的交互参考；不作为 P0 的核心依赖。
- [WaveSurfer.js](https://wavesurfer.xyz/)：波形与播放交互参考；是否引用其音频显示能力由实验决定，Beat View Warp 仍由自研渲染负责。

**AI 编程的实施指令：** 不允许整段复制第三方交互源代码；不允许将内核实现替换成 iframe、外部 Timeline 组件或具有秒数坐标假设的第三方拖动库。应以明确定义的 Tick 契约实现，经过自动化测试后再扩展业务。

### 9.3 组件引用边界

UI 库可以负责菜单、弹窗、Tab、输入控件、图标、快捷提示等通用界面；**时间轴内容绘制、轨道片段、Viewport、拖动/缩放、ConstraintEngine 必须归本项目维护**。这避免使用某组件库后出现与用户期望的“方正、扁平、克制”视觉相冲突的问题。

---

## 10. 交互与边界案例（研发不可省略）

### 10.1 拖动与 Resize

- 手柄抓取范围与事件块正文分开；极窄片段仍应能选中与编辑，缩小时用详情面板/快捷操作替代不可点击的手柄。
- Resize Left 不应改变右端；Resize Right 不应改变左端；Move 保持时长不变。
- 碰到相邻事件时按轨道策略停止、联动、覆盖预览或阻止提交；默认禁止无提示覆盖。
- 拖动可临时取消吸附；从未被确认的 AI 事件拖动后应保留来源与用户修正标记。
- 多个关联级数显示块跟随对应和弦移动，但不各自触发独立保存。

### 10.2 BPM / 拍号 / 弱起

- BPM 在和弦中途变化，和弦仍保持原 Tick 区间，音频秒数对应重新映射。
- 3/4 小节后接 4/4 时，小节线与 Bar 编号正确，事件不能平移到别的小节。
- 拍号在段落中间变化时显示局部标记，不强制切开段落。
- 首拍不在 0 秒或弱起时，标尺可显示弱起及第一完整小节，导入结果仍需正确对齐。
- Beat Tracker 漏掉一次强拍时，可人工补点并局部重建映射，不重置全曲确认状态。

### 10.3 和声解释

- 双重解释：`Fmaj7` 的 C Major `IVmaj7` 与 F Major `Imaj7` 在两轨同时显示且有独立状态。
- 对第二条解释改名/变调不应改变 Fmaj7 或第一条解释。
- 枢纽关联可手动创建、撤销、修改方向，避免“调性区间碰巧重叠就自动判断发生转调”。
- 同一事件先有两个未确认假说，正式索引不能把两者当作确定案例。
- 邻接统计不能把不同调性解释路径任意拼接成不真实的连续进行。

### 10.4 资源、错误与数据

- 音频文件被移动后能通过指纹/用户重新选择恢复关联。
- 模型 GPU/CPU 推理失败后，手动时间轴继续可用。
- 某次导出因文件写入失败，数据库已经确认的修改不能丢失；索引显示待重建状态。
- Markdown 全量重建不能覆盖人工笔记和待验证项目。
- 一个曲目存在现场版、专辑版、翻唱版时，录音版本 ID 不得混淆不同实际时间线。

---

## 11. 验收标准（Definition of Done）

### A. 时间轴基础（阻塞级 P0）

| 编号 | 场景 | 可测条件 |
|---|---|---|
| A01 | 基础坐标 | 4/4 中第 3 小节起点 = 7680 Tick；所有事件存整数 Tick |
| A02 | 变速映射 | 0–4 秒 120 BPM，4 秒后 90 BPM；Tick 7680 → 4.000 秒，Tick 11520 → 约 6.667 秒 |
| A03 | 映射可逆 | 有效映射范围随机 1000 点，`tick→sec→tick` 误差 ≤ 1 Tick |
| A04 | 三连网格 | 1/3 拍 = 320 Tick；拖动/左右伸缩后首尾正确吸附 |
| A05 | Resize | 改左边界不动右边界、改右边界不动左边界；事件时长始终为正 |
| A06 | Zoom 锚点 | 鼠标位置缩放后，同一 Tick 屏幕 X 偏差 ≤ 1px |
| A07 | 自动滚动 | 拖片段到左右边缘可连续滚动，不丢指针、不跳格、不重复提交 |
| A08 | 取消/撤销 | Escape、pointercancel 可恢复操作前快照；一次拖动只生成一条 Undo |
| A09 | 轨间对齐 | Canvas 小节线、DOM 和弦边界、波形光标与播放头同位置偏差 ≤ 1px（普通 DPR 条件） |
| A10 | 拍号内嵌 | 将 Bridge 改 3/4 只改变段落显示与 Meter Map；默认界面不存在独立拍号轨 |
| A11 | 临时变拍 | Verse 内出现单小节 2/4，可随后恢复 4/4；段落依然是一段 Verse |
| A12 | Beat Warp | 修改某个锚点后，已确认和弦 Tick 保持不变，试听位置按新映射更新 |

### B. 业务闭环

| 编号 | 场景 | 可测条件 |
|---|---|---|
| B01 | 导入 LRC | 时间戳映射 Tick、保留原始秒数；可人工移位与关闭吸附 |
| B02 | AI 独立性 | 任意一个模型失败，其他轨与人工编辑依旧可用 |
| B03 | 人工确认保护 | 重跑 AI 不覆盖已确认和弦、段落与双重解释 |
| B04 | 和声双重解释 | 一条 Fmaj7 同时挂两个有效级数轨并可独立确认 |
| B05 | 五类索引 | 目标、前置、后续、三和弦、重解释均能返回正确结果 |
| B06 | 反向试听 | 点击案例播放源 MP3 对应片段（前后各一小节默认），无重复 MP3 文件 |
| B07 | 数据去重 | 同一枢纽和弦统计独立音响事件数 = 1；解释实例数 = 2 |
| B08 | 文档保留 | Markdown 全量重建后个人分析笔记和稳定事件链接不丢失 |
| B09 | 版本区分 | 同一作品不同录音分别保存各自 Beat Map、和弦、段落 |
| B10 | 重启恢复 | 保存退出再次打开，全部事件及视角、人工笔记、索引可恢复 |

### C. 性能与工程质量（初始目标，原型测试后定案）

- Windows 中档开发机，4 分钟、约 100 小节、有 8–12 条可视轨道的普通编辑，滚动/拖动目标 60 FPS；测试报告需说明机器与 DPR。
- 1,000 首录音、约 100,000 个和弦事件，常见 SQLite 索引检索争取 300ms 内出首屏；不包含音频加载和 AI 推理时间。
- Vitest 覆盖数学/约束核心；Playwright 至少覆盖拖动、双端 Resize、吸附切换、Auto-scroll、Zoom 锚点、拍号更改、Undo/Redo。
- 随机化（Property-based）测试 `Tick↔秒` 的严格单调与逆向误差，以及所有事件 `endTick>startTick` 不变量。
- 所有 UI 交互不应因 AI 运行阻塞主线程；波形大数据和 AI 任务在独立 Worker/进程处理。

---

## 12. 研发分期与开发任务拆分

### Phase 0：时间轴 Spike（必须先完成）

**目标**：不接 AI、不接数据库，构建纯前端 Demo，证明自研交互可靠。

1. `Tick/MeterMap/BeatMap/Geometry` 数学工具及其单元测试。
2. Canvas 小节标尺/网格；DOM 的 3 轨片段（和弦、段落、调性解释）。
3. Move、Resize Left、Resize Right、吸附粒度切换、Alt 取消吸附。
4. 鼠标锚点 Zoom、横向 Scroll、边缘自动滚动、Pointer Capture、Cancel。
5. 变速 120→90、4/4→3/4、两个重叠级数轨的静态测试数据。
6. Undo/Redo、Playwright 浏览器真实拖拽与位置断言。

**退出条件**：A01–A12 通过；未通过不启动大规模业务页面开发。

### Phase 1：音乐基础数据与播放

- SQLite 录音/事件库、Bun API、FFmpeg 解码和峰值缓存。
- MP3/FLAC 加载、本地 Playback、Tick→秒定位、选区循环与自动保存。
- 可编辑 Beat Map，波形按音乐网格重映射；Meter Map 与段落内嵌拍号联动。
- LRC 导入、时间偏移与人工校对。

### Phase 2：AI 候选导入与人工校对

- Python Worker/模型适配器，分别接入和弦、段落、拍点识别。
- 模型结果先存原始秒数，再映射 Tick；AI 候选状态、确认、拒绝、修订与重跑对比。
- 基于 10–20 首复杂作品测量人工校对耗时和变速/转调区误差。

### Phase 3：多重和声解释与检索

- 调性区间与分析层、重复组、级数自动候选、手工修订与 Pivot Link。
- 五种关系索引、按上下文分组、去重统计、跨调解释路径规则。
- 案例详细信息、片段回听、从检索反向定位工作台。

### Phase 4：Markdown 与完整日常工作流

- 单曲研究档案、可编辑笔记、自动生成索引和每日汇总。
- 全量重建、增量更新、数据备份/恢复、缺失音频重新定位。
- 性能回归、键盘快捷键完善、Windows 启动与打包方案。

### 建议的 AI 编程协作方式

- 每个 Phase 再切分为**纯函数契约 → 无 UI 测试 → 单交互组件 → 浏览器端到端测试**。
- 不要求 AI“一次生成完整工作台”；每个交互必须给出可自动验证的预期坐标和状态。
- UI 设计稿只代表视觉方向，不是可复制的时间轴逻辑。先确定真实坐标模型与行为，再实现样式。
- 借鉴开源实现时先提炼行为和测试条件，避免大段移植第三方组件。

---

## 13. 技术与产品风险

| 风险 | 应对 |
|---|---|
| 自研时间轴交互质量不稳定 | 先做 Phase 0 Spike；统一 Pointer State Machine/Viewport；大量真实拖拽回归 |
| 复杂 BPM 与模型误拍导致全轨漂移 | Beat Map 可人工修正、Half/Double-time 选择、带来源的原始秒数、影响预览 |
| 乐谱拍号与段落分界并不总一致 | UI 段落内嵌、数据独立 Meter Map、段内变拍例外标记 |
| LRC 节奏抢拍被错误吸附 | 歌词默认高精度/弱吸附，保留原始秒数，人工选择吸附粒度 |
| 转调分析被单调性模型破坏 | 绝对和弦独立；多个可重叠分析轨；Pivot 显式确认 |
| AI 词表不足以覆盖复杂和弦 | 候选可人工改写，原始模型标签留存，先验证人工修正成本 |
| Markdown 与 SQLite 冲突 | SQLite 为事实权威，手工笔记与生成索引隔离，提供 Diff/备份 |
| 音频资源路径变化或版权问题 | 本地优先、文件指纹重连，不默认上传或分享受保护的音频 |
| 开源项目及模型权重许可证 | Phase 0 逐项确认代码、权重、依赖与商用/再分发许可 |
| 超长作品或高分辨率多轨性能下降 | 可视区虚拟化、波形峰值缓存、Worker、Canvas/DOM 混合渲染 |

---

## 14. 最小发布闭环

只要产品能稳定完成以下流程，就值得作为首版投入日常使用：

1. 将一首音频与可选 LRC 导入曲库。
2. 生成或人工录入 Beat Map，支持中途变 BPM 与段落内的拍号变更。
3. 在**自研的 Tick 时间轴**上查看/拖动/伸缩/量化所有相关事件，具备稳定 Undo/Redo。
4. 用现成 AI 获得和弦和段落候选并完成校对。
5. 对同一和弦建立 C 大调 `IVmaj7`、F 大调 `Imaj7` 两条重叠级数解释并确认。
6. 在和声检索中查询前置、后续或 `IVmaj7 → Imaj7` 重解释，点击回听真实 MP3。
7. 保存单曲 Markdown、生成索引，重启后完整恢复。

**质量门槛：时间轴首先必须准确、可编辑、可撤销；模型功能和知识库功能在此基础上逐层接入。**

---

## 15. 公开技术参考与来源边界

以下为**研发参考候选**，不是强制依赖清单；接口、许可与权重可用性以实施时复核结果为准。

- [React Timeline Editor](https://github.com/xzdarcy/react-timeline-editor) — 参考多轨片段、拖拽缩放、边缘自动滚动的状态控制方式。
- [Vue Timeline Editor](https://github.com/CuiMuxuan/vue-timeline-editor) — 参考 Vue 下轨道与片段的组件组织。
- [Interact.js](https://interactjs.io/) — 参考交互中的拖动、缩放、辅助线吸附行为。
- [WaveSurfer.js](https://wavesurfer.xyz/) — 参考音频波形与播放控制设计。
- [lv-chordia](https://github.com/openmirlab/lv-chordia) — 现成和弦模型候选。
- [All-In-One-Infer](https://github.com/openmirlab/all-in-one-infer) — 现成段落、节拍识别候选。
- [Beat This!](https://github.com/CPJKU/beat_this) — 变速及复杂节奏的拍点识别候选。
- [MDN Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) — 原生指针事件与 Pointer Capture 规范。

**文档结束。**
