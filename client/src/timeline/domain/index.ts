/**
 * 时间轴 domain 层统一导出。
 *
 * 这一层是**纯函数 + 不可变数据**，不依赖 DOM、Vue、Tauri 或任何 IO。
 *
 * 分层（PRD §4.2）：
 *   domain/       ← 本目录
 *   interaction/  ← Pointer 状态机
 *   render/       ← Canvas 渲染
 *   components/   ← Vue 组件
 *
 * 五个核心模块：
 *   Tick             整数 tick、半开区间（960 PPQ）
 *   MeterMap         拍号与小节分组（格子恒为 1 个四分音符）
 *   TempoMap         BPM 锚点，Tick ⇄ 秒
 *   TimelineGeometry Tick ⇄ 像素，含整数像素对齐
 *   SnapEngine       三类吸附源 + 像素阈值
 *   ConstraintEngine 轨道约束
 *   EditCommands     编辑事务与撤销栈
 */

export * from './Tick';
export * from './MeterMap';
export * from './TempoMap';
export * from './TimelineGeometry';
export * from './SnapEngine';
export * from './ConstraintEngine';
export * from './EditCommands';
