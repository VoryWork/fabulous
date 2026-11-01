import io
p='client/src/components/TimelineView.vue'
s=io.open(p,encoding='utf-8').read()
# 临时：在轨道头上直接渲染调试标记
s = s.replace('''          <div class="header-main">''','''          <div v-if="keyPopFor" class="dbg-on">POP:{{ keyPopFor }}</div>
          <div class="header-main">''',1)
io.open(p,'w',encoding='utf-8').write(s)
print('debug marker added')
