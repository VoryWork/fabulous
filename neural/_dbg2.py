import io
p='client/src/components/TimelineView.vue'
s=io.open(p,encoding='utf-8').read()
# 去掉调试标记
s = s.replace('''          <div v-if="keyPopFor" class="dbg-on">POP:{{ keyPopFor }}</div>\n''','',1)
# 换一种写法：先不管事件，测 reactive 本身
s = s.replace('''                  @click.stop="toggleKeyPop(t.id, $event)"''',
'''                  @click="toggleKeyPop(t.id, $event)"''',1)
io.open(p,'w',encoding='utf-8').write(s)
print('ok')
