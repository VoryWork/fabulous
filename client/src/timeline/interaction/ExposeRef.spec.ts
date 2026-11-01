/**
 * 跨组件 expose 的 ref 解包。
 *
 * ## 踩过的坑（两次）
 *
 * `defineExpose` 出去的 `ref` / `computed`，父组件通过模板 ref 拿到的是
 * **RefImpl 对象本身**，不是它的值。于是：
 *
 * ```ts
 * const selId = timelineRef.value?.editing?.selectedId;  // RefImpl
 * if (!selId) return;              // 永远为假（对象是 truthy）
 * clips.find(c => c.id === selId); // 永远找不到（字符串 vs 对象）
 * ```
 *
 * 症状之一是「点和弦块，右侧详情一直显示未选中片段」——不报错、类型检查
 * 也过（因为读的时候声明成 `string`），只是静默失效。
 *
 * 同一个坑在 `canUndo` 上已经踩过一次（撤销按钮永不禁用），
 * 所以这里的约定是：**expose 出去的可变状态一律用 computed 解包**，
 * 父组件只读解包后的值。
 */
import { describe, it, expect } from 'vitest';
import { computed, ref } from 'vue';

describe('expose 的 ref 解包', () => {
  it('暴露 ref 本身时，父组件拿到的是对象而不是值', () => {
    const selectedId = ref<string | null>('chord-5');
    // 模拟父组件直接读 ref 属性
    const exposedNaive = { selectedId };
    const got = exposedNaive.selectedId as unknown;

    // 这就是 bug 的根源：既不是 null，也不等于字符串
    expect(got).not.toBeNull();
    expect(got).not.toBe('chord-5');
    expect(typeof got).toBe('object');
    // 而且 truthy，所以 `if (!got) return` 挡不住
    expect(Boolean(got)).toBe(true);
  });

  it('暴露 computed 后读到的是解包值', () => {
    const selectedId = ref<string | null>('chord-5');
    const exposed = { selectedIdValue: computed(() => selectedId.value) };

    // 父组件读取：这里手动 .value（模板里会自动，但 TS 里要显式）
    const got = exposed.selectedIdValue.value;
    expect(got).toBe('chord-5');
  });

  it('解包后能正确匹配到片段', () => {
    const clips = [{ id: 'chord-5' }, { id: 'chord-6' }];
    const selectedId = ref<string | null>('chord-6');

    // 错误路径
    const naive = clips.find((c) => c.id === (selectedId as unknown));
    expect(naive).toBeUndefined();

    // 正确路径
    const ok = clips.find((c) => c.id === selectedId.value);
    expect(ok?.id).toBe('chord-6');
  });

  it('解包后 null 仍然是 null（不会变成 truthy 的对象）', () => {
    const selectedId = ref<string | null>(null);
    const exposed = { selectedIdValue: computed(() => selectedId.value) };
    expect(exposed.selectedIdValue.value).toBeNull();
    expect(Boolean(exposed.selectedIdValue.value)).toBe(false);
  });
});
