/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 模拟 DOM 测客户端脚本：拖动、缩放、折叠、边界钳制、状态持久化。
 * 不碰真实浏览器，但事件序列是按 pointer 事件规范模拟的。
 */
import { makeDom, bootBar, settle } from './mock-dom.mjs'

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`)
  ok ? pass++ : fail++
}

const boot = (dom, state, store = {}, cfgResp = null) => bootBar(dom, state, store, cfgResp)
const STATE = { spentCny: 3.42, capCny: 5, tier: 0, tierCount: 6, exhausted: false, dryRun: false, resumeAt: '10:00' }

console.log('=== 消费口径与回退说明 ===')
{
  const dom = makeDom()
  const bar = await boot(dom, { ...STATE, spendSource: { requested: 'observed', effective: 'observed', window: 'tier' } }, {}, {
    body: { effective: { spendSource: 'observed', quotaMode: 'total', ladder: [{ until: '24:00', cap: 5 }] }, override: {} }, puts: [],
  })
  await settle(30)
  check('余额模式标明本档口径', bar.querySelector('#dsh-cb-source').textContent, '本档余额消费')
  check('余额模式不误称当日累计', bar.querySelector('#dsh-cb-title').title.includes('本档余额消费上限'), true)
  bar.querySelector('#dsh-cb-cfg').fire('click', { stopPropagation() {} })
  await settle(30)
  check('余额配置面板明确窗口口径', dom.doc.body.querySelector('#dsh-cb-laddertitle').textContent, '阶梯额度（本档余额消费上限）')
  check('余额配置面板说明回退为当日 token', dom.doc.body.querySelector('#dsh-cb-ladderhint').textContent.includes('按当日 token 估算'), true)
}
{
  const dom = makeDom()
  const bar = await boot(dom, { ...STATE, spendSource: { requested: 'observed', effective: 'estimated', window: 'day', fallback: 'stale-samples' } })
  await settle(30)
  check('数据过期时标明实际口径和回退原因', bar.querySelector('#dsh-cb-source').textContent, '当日 token 估算 · 已回退：余额数据已过期')
  check('回退后的额度说明按当日估算', bar.querySelector('#dsh-cb-title').title.includes('当天累计估算'), true)
}

// ── 0. ⚙ 配置按钮必须在默认宽度下就可见 ────────────────────────────────────
// 真实故障：标题/金额的 min-content 宽度把 ⚙ 挤出了面板，用户得手动拉大
// 面板才点得到。模拟 DOM 量不出文字宽度，所以断言"让它不可能溢出"的 CSS 约束。
console.log('=== 0. ⚙ 按钮可见性（不再被挤出面板）===')
{
  const dom = makeDom()
  const bar = await boot(dom, STATE)
  await settle(30)
  // 客户端把 CSS 写在 <style>.textContent 上（不是 innerHTML）
  const css = (dom.doc.head.children || []).map((c) => c.textContent || c._html || '').join('')

  check('⚙ 存在于 header 里', !!bar._q['#dsh-cb-cfg'], true)
  // 不可压缩：flex:0 0 auto
  check('⚙ 不可被压缩 (flex:0 0 auto)', /#dsh-cb-cfg\{[^}]*flex:0 0 auto/.test(css), true)
  // 标题可收缩 + 省略：否则它的 min-content 会顶出 ⚙
  check('标题可收缩 (min-width:0)', /#dsh-cb-title\{[^}]*min-width:0/.test(css), true)
  check('标题溢出用省略号', /#dsh-cb-title\{[^}]*text-overflow:ellipsis/.test(css), true)
  check('标题可被 flex 压缩 (flex:0 1 auto)', /#dsh-cb-title\{[^}]*flex:0 1 auto/.test(css), true)
  // 金额同理
  check('金额可收缩 (min-width:0)', /#dsh-cb-num\{[^}]*min-width:0/.test(css), true)
  // 输入区必须显式声明"可选/可编辑"：否则一旦某个祖先设了 user-select:none，
  // 表现就是"能聚焦、能打字，但没法用鼠标定位光标或选中已有内容"。
  check('输入区显式 user-select:text', /#dsh-cb-panel input,#dsh-cb-panel textarea\{[^}]*user-select:text/.test(css), true)
  check('输入区带 -webkit- 前缀', /#dsh-cb-panel input,#dsh-cb-panel textarea\{[^}]*-webkit-user-select:text/.test(css), true)
  check('输入区光标为 text', /#dsh-cb-panel input,#dsh-cb-panel textarea\{[^}]*cursor:text/.test(css), true)
  // 只读展示行不该可选（它是标签，不是内容）
  check('只读角标存在样式', /#dsh-cb-ro\{/.test(css), true)
  check('只读行用 flex 布局', /\.dsh-cb-ro\{[^}]*display:flex/.test(css), true)
  check('金额溢出用省略号', /#dsh-cb-num\{[^}]*text-overflow:ellipsis/.test(css), true)
  // header 容器允许收缩
  check('header 允许收缩 (min-width:0)', /#dsh-cb-head\{[^}]*min-width:0/.test(css), true)
}

// ── 1. 默认位置在右上角（不再挡左下角的设置）──────────────────────────────
console.log('=== 1. 默认位置：右上角 ===')
{
  const dom = makeDom()
  const bar = boot(dom, STATE)
  check('默认不写死 left', bar.style.left, 'auto')
  check('默认 top = 16px', bar.style.top, '16px')
  check('默认靠右定位', typeof bar.style.right === 'string' && bar.style.right.endsWith('px'), true)
  console.log(`        right=${bar.style.right}（视口 1600 宽）`)
  check('默认不带 bottom（不再贴左下）', bar.style.bottom, 'auto')
}

// ── 2. 拖动：按下 → 移动 → 松开 ─────────────────────────────────────────────
console.log('\n=== 2. 拖动改位置 ===')
{
  const dom = makeDom()
  const store = {}
  const bar = boot(dom, STATE, store)
  const head = bar.querySelector('#dsh-cb-head')
  head.fire('pointerdown', { clientX: 100, clientY: 20, pointerId: 1 })
  check('拖动中加 dragging 类', bar.classList.contains('dragging'), true)
  head.fire('pointermove', { clientX: 500, clientY: 300, pointerId: 1 })
  head.fire('pointerup', { clientX: 500, clientY: 300, pointerId: 1 })
  check('拖动后去掉 dragging 类', bar.classList.contains('dragging'), false)
  console.log(`        位置 → left=${bar.style.left} top=${bar.style.top}`)
  check('位置已写死为 left/top', bar.style.right, 'auto')
  check('位置已持久化到 localStorage', JSON.parse(store['dsh-cb-pos'] ?? 'null') !== null, true)
  console.log(`        持久化值: ${store['dsh-cb-pos']}`)
}

// ── 3. 小抖动不应触发拖动 ───────────────────────────────────────────────────
console.log('\n=== 3. 抖动容差（点击折叠时不能误判为拖动）===')
{
  const dom = makeDom()
  const store = {}
  const bar = boot(dom, STATE, store)
  const head = bar.querySelector('#dsh-cb-head')
  head.fire('pointerdown', { clientX: 100, clientY: 20, pointerId: 1 })
  head.fire('pointermove', { clientX: 101, clientY: 20, pointerId: 1 })  // 1px 抖动
  head.fire('pointerup', { clientX: 101, clientY: 20, pointerId: 1 })
  check('1px 抖动不写位置', store['dsh-cb-pos'], undefined)
}

// ── 4. 边界钳制：不能拖出视口 ───────────────────────────────────────────────
console.log('\n=== 4. 边界钳制（拖出视口要被拉回）===')
{
  const dom = makeDom()
  const store = {}
  const bar = boot(dom, STATE, store)
  const head = bar.querySelector('#dsh-cb-head')
  head.fire('pointerdown', { clientX: 100, clientY: 20, pointerId: 1 })
  head.fire('pointermove', { clientX: -5000, clientY: -5000, pointerId: 1 })  // 拖到左上角外面
  head.fire('pointerup', { clientX: -5000, clientY: -5000, pointerId: 1 })
  const pos = JSON.parse(store['dsh-cb-pos'])
  console.log(`        拖到 (-5000,-5000) → 实际 ${JSON.stringify(pos)}`)
  check('x 被钳到 >= 0', pos.x >= 0, true)
  check('y 被钳到 >= 0', pos.y >= 0, true)

  head.fire('pointerdown', { clientX: 100, clientY: 20, pointerId: 2 })
  head.fire('pointermove', { clientX: 99999, clientY: 99999, pointerId: 2 })
  head.fire('pointerup', { clientX: 99999, clientY: 99999, pointerId: 2 })
  const pos2 = JSON.parse(store['dsh-cb-pos'])
  console.log(`        拖到 (99999,99999) → 实际 ${JSON.stringify(pos2)}`)
  check('x 被钳在视口内', pos2.x <= 1600, true)
  check('y 被钳在视口内', pos2.y <= 900, true)
}

// ── 5. 折叠只由标题触发，且落盘 ─────────────────────────────────────────────
console.log('\n=== 5. 折叠 ===')
{
  const dom = makeDom()
  const store = {}
  const bar = boot(dom, STATE, store)
  bar.querySelector('#dsh-cb-title').fire('click', {})
  check('标题点击 → 折叠', bar.classList.contains('collapsed'), true)
  check('折叠状态已落盘', store['dsh-cb-collapsed'], '1')
  bar.querySelector('#dsh-cb-title').fire('click', {})
  check('再点 → 展开', bar.classList.contains('collapsed'), false)
}

// ── 6. 拖动时按住标题不应拖动（标题让给折叠）────────────────────────────────
console.log('\n=== 6. 标题区域不参与拖动 ===')
{
  const dom = makeDom()
  const store = {}
  const bar = boot(dom, STATE, store)
  const head = bar.querySelector('#dsh-cb-head')
  head.fire('pointerdown', { clientX: 100, clientY: 20, pointerId: 1, target: bar.querySelector('#dsh-cb-title') })
  head.fire('pointermove', { clientX: 600, clientY: 400, pointerId: 1 })
  head.fire('pointerup', { clientX: 600, clientY: 400, pointerId: 1 })
  check('按住标题不产生位置', store['dsh-cb-pos'], undefined)
}

// ── 7. 缩放 ─────────────────────────────────────────────────────────────────
console.log('\n=== 7. 缩放 ===')
{
  const dom = makeDom()
  const store = {}
  const bar = boot(dom, STATE, store)
  const grip = bar.querySelector('#dsh-cb-resize')
  grip.fire('pointerdown', { clientX: 200, clientY: 100, pointerId: 1 })
  check('缩放中加 resizing 类', bar.classList.contains('resizing'), true)
  grip.fire('pointermove', { clientX: 320, clientY: 160, pointerId: 1 })
  grip.fire('pointerup', { clientX: 320, clientY: 160, pointerId: 1 })
  console.log(`        尺寸 → ${bar.style.width} x ${bar.style.height}`)
  check('宽度已更新', bar.style.width, '330px')
  check('高度已更新', bar.style.height, '120px')
  check('尺寸已落盘', JSON.parse(store['dsh-cb-size'] ?? 'null') !== null, true)
}

// ── 8. 缩放不能缩到不可读 ───────────────────────────────────────────────────
console.log('\n=== 8. 缩放上下限 ===')
{
  const dom = makeDom()
  const store = {}
  const bar = boot(dom, STATE, store)
  const grip = bar.querySelector('#dsh-cb-resize')
  grip.fire('pointerdown', { clientX: 200, clientY: 100, pointerId: 1 })
  grip.fire('pointermove', { clientX: -9999, clientY: -9999, pointerId: 1 })
  check('宽度不小于 150', parseFloat(bar.style.width) >= 150, true)
  check('高度不小于 64', parseFloat(bar.style.height) >= 64, true)
  grip.fire('pointermove', { clientX: 99999, clientY: 99999, pointerId: 1 })
  check('宽度不大于 520', parseFloat(bar.style.width) <= 520, true)
  check('高度不大于 320', parseFloat(bar.style.height) <= 320, true)
}

// ── 9. 重启后位置被记住 ─────────────────────────────────────────────────────
console.log('\n=== 9. 位置持久化（刷新页面后回到原处）===')
{
  const dom = makeDom()
  const store = { 'dsh-cb-pos': JSON.stringify({ x: 777, y: 333 }) }
  const bar = boot(dom, STATE, store)
  check('恢复上次位置 left', bar.style.left, '777px')
  check('恢复上次位置 top', bar.style.top, '333px')
}

// ── 10. 越界的历史位置会被拉回 ──────────────────────────────────────────────
console.log('\n=== 10. 历史位置越界时自动拉回 ===')
{
  const dom = makeDom(800, 600)
  const store = { 'dsh-cb-pos': JSON.stringify({ x: 5000, y: 5000 }) }
  const bar = boot(dom, STATE, store)
  console.log(`        存储 (5000,5000)，视口 800x600 → left=${bar.style.left} top=${bar.style.top}`)
  check('left 被拉回视口内', parseFloat(bar.style.left) <= 800, true)
  check('top 被拉回视口内', parseFloat(bar.style.top) <= 600, true)
}

// ── 11. 双击空白复位 ────────────────────────────────────────────────────────
console.log('\n=== 11. 双击复位 ===')
{
  const dom = makeDom()
  const store = { 'dsh-cb-pos': JSON.stringify({ x: 777, y: 333 }) }
  const bar = boot(dom, STATE, store)
  bar.fire('dblclick', {})
  check('位置记录已清空', store['dsh-cb-pos'], undefined)
  check('回到右侧默认位', bar.style.right !== 'auto', true)
}

// ── 12. 渲染仍然正确 ────────────────────────────────────────────────────────
console.log('\n=== 12. 渲染未受影响 ===')
{
  const dom = makeDom()
  const bar = await boot(dom, STATE)
  await new Promise((r) => setTimeout(r, 50))
  check('数值显示', bar._q['#dsh-cb-num']?.textContent, '¥3.42 / ¥5.00')
  check('进度宽度', bar._q['#dsh-cb-fill']?.style.width, '68.4%')
  check('档位', bar._q['#dsh-cb-l']?.textContent, '第 1/6 档')
}

console.log('\n=== 13. 标题措辞：是"当前预算"而非"今日预算" ===')
{
  // 显示的是**当前档位**的额度（第 1 档 ¥5，跨档后变 ¥10），不是全天额度，
  // 所以不能叫"今日预算"。
  const dom = makeDom()
  const bar = await boot(dom, STATE)
  await new Promise((r) => setTimeout(r, 50))
  check('标题文字', bar._q['#dsh-cb-title']?.textContent, '当前预算')
  const tip = bar._q['#dsh-cb-title']?.title ?? ''
  console.log(`        tooltip: ${tip.replace(/\n/g, ' | ')}`)
  check('tooltip 说明是哪个档位', /当前档位/.test(tip), true)
  check('tooltip 含该档上限', /¥5\.00/.test(tip), true)
  check('tooltip 含边界时刻', /10:00/.test(tip), true)
}

console.log('\n=== 14. 配置面板：打开、回显、保存 ===')
{
  const dom = makeDom()
  const cfg = {
    body: {
      effective: {
        quotaMode: 'group',
        ladder: [{ until: '10:00', cap: 5 }, { until: '24:00', cap: 40 }],
        providerGroups: { official: ['deepseek-official'], internal: ['example-gateway'] },
        groupCapScale: { internal: 0.5 },
        peakHours: [[9, 12], [14, 18]],
        holidays: ['2026-10-01'],
        valleyDays: [],
        calendarUrl: '',
        dryRun: true,
        resumeMinHeadroomPct: 15,
        availableProviders: ['deepseek-official', 'example-gateway'],
        // ★ peakNow 在 effective **内部**（与真实 config.json 一致）。
        //   夹具曾经把它放在顶层，于是 loadConfig 里写错的 j.peakNow
        //   也能"测过" —— 实际界面上那一行永远是 "--"。
        peakNow: { peak: true, hour: 10, day: '2026-09-21', reason: '工作日上午·下午峰时', nextAt: '12:00 转谷价', rest: false, makeup: false },
      },
      override: { quotaMode: 'group' },
    },
    puts: [],
  }
  const bar = await boot(dom, STATE, {}, cfg)
  await settle()

  check('齿轮按钮存在', !!bar._q['#dsh-cb-cfg'], true)
  check('未点击时没有面板', dom.all.some((e) => e.id === 'dsh-cb-panel'), false)

  // ★ 必须走真实的"按下→抬起→点击"（含冒泡），不能裸 fire('click')。
  //   齿轮在 #dsh-cb-head 内部，拖动逻辑的 pointerdown 会 preventDefault，
  //   而**被 preventDefault 的 pointerdown 不产生 click** —— 曾经因此
  //   配置面板永远打不开，而裸 fire('click') 的写法完全测不出来。
  const cfgEl = bar._q['#dsh-cb-cfg']
  const head = bar.querySelector('#dsh-cb-head')
  const onDown = head.fire('pointerdown', {
    detail: { clientX: 10, clientY: 10, extra: { target: cfgEl } },
  })
  check('点齿轮时 pointerdown 未被 preventDefault（否则 click 会被抑制）', onDown.prevented, false)
  check('点齿轮不进入拖动状态', bar.classList.contains('dragging'), false)

  // 齿轮自己在 head 内部 → 事件从齿轮冒泡到 head
  const res = cfgEl.press()
  check('齿轮的点击未被抑制', res.clickSuppressed, false)
  await settle()

  const panel = dom.all.find((e) => e.id === 'dsh-cb-panel')
  check('点击后面板已创建', !!panel, true)
  check('面板含模式选择', !!panel._q['#dsh-cb-mode'], true)
  check('面板含分组区', !!panel._q['#dsh-cb-groupsbox'], true)
  check('面板含试跑勾选框', !!panel._q['#dsh-cb-dry'], true)
  check('面板含保存按钮', !!panel._q['#dsh-cb-save'], true)

  console.log('        —— provider 必须是勾选，不能是手打（拼错会静默失效）——')
  check('旧的自由输入框已移除', !!panel._q['#dsh-cb-groups'], false)
  check('旧的倍率文本框已移除', !!panel._q['#dsh-cb-scale'], false)
  const grows = panel._q['#dsh-cb-grouplist']?.querySelectorAll('.dsh-cb-group') || []
  check('渲染出 2 个组', grows.length, 2)
  const picks = panel._q['#dsh-cb-grouplist'].querySelectorAll('.dsh-cb-gpick')
  // 2 个组 × 2 个可选项 = 4 个勾选框。每个组都要能看到**全部** provider，
  // 否则没法把某个 provider 从 A 组挪到 B 组。
  check('provider 渲染成勾选框', picks.length, 4)
  const pickVals = [...new Set(picks.map((p) => p.value))].sort()
  check('勾选项来自服务端名单', pickVals, ['deepseek-official', 'example-gateway'])
  // 每个组各自持有一份完整名单
  for (const g of grows) {
    const vals = g.querySelectorAll('.dsh-cb-gpick').map((p) => p.value).sort()
    check(`组内可选项完整 (${g.querySelector('.dsh-cb-gname')?.value})`, vals, ['deepseek-official', 'example-gateway'])
  }

  console.log('        —— 峰谷只显示"当前时段"，不铺规则表 ——')
  for (const gone of ['#dsh-cb-peak', '#dsh-cb-holidays', '#dsh-cb-calurl',
    '#dsh-cb-peakshow', '#dsh-cb-holshow', '#dsh-cb-calshow']) {
    check(`已移除 ${gone}`, !!panel._q[gone], false)
  }
  check('有"当前时段"一行', !!panel._q['#dsh-cb-peaknow'], true)
  // ★ 必须断言**渲染出了内容**：只查元素存在的话，
  //   loadConfig 读错层级（j.peakNow vs e.peakNow）也会"通过"，
  //   而真实界面上那一行是空的 / 只显示 "--"。
  {
    const html = panel._q['#dsh-cb-peaknow']?.innerHTML || ''
    check('时段行渲染出了峰价标记', /dsh-cb-peak/.test(html), true)
    check('时段行渲染出了原因', /工作日上午/.test(html), true)
    check('时段行渲染出了切换时刻', /12:00 转谷价/.test(html), true)
    check('时段行不是退化的 "--"', html.length > 20 && !/^<span class="dsh-cb-hint">--/.test(html), true)
  }

  console.log('        —— 回显（应反映服务器当前生效值）——')
  check('模式回显 group', panel._q['#dsh-cb-mode']?.value, 'group')
  check('试跑勾选回显', panel._q['#dsh-cb-dry']?.checked, true)
  check('余量回显', panel._q['#dsh-cb-headroom']?.value, 15)
  const gA = grows.find((r) => /^official$/.test(r.querySelector('.dsh-cb-gname')?.value || ''))
  check('official 组回显出来了', !!gA, true)
  const gI = grows.find((r) => /^internal$/.test(r.querySelector('.dsh-cb-gname')?.value || ''))
  check('internal 组回显出来了', !!gI, true)
  check('internal 的倍率回显 = 0.5', gI?.querySelector('.dsh-cb-gscale')?.value, '0.5')
  const checkedInA = gA ? gA.querySelectorAll('.dsh-cb-gpick').filter((c) => c.checked).map((c) => c.value) : []
  check('official 组勾选了 deepseek-official', checkedInA, ['deepseek-official'])

  console.log('        —— 模式切换要有可见变化 ——')
  check('group 模式下分组设置可见', panel._q['#dsh-cb-groupsbox']?.style.display, 'block')
  check('group 模式提示说明了算法', /各自一套阶梯/.test(panel._q['#dsh-cb-modehint']?.textContent || ''), true)
  panel._q['#dsh-cb-mode'].value = 'total'
  panel._q['#dsh-cb-mode'].fire('change', {})
  check('切到 total 后分组设置隐藏', panel._q['#dsh-cb-groupsbox']?.style.display, 'none')
  check('total 模式提示说明了合并算法', /合并成一个额度/.test(panel._q['#dsh-cb-modehint']?.textContent || ''), true)
  // 切回 group 继续后面的保存测试
  panel._q['#dsh-cb-mode'].value = 'group'
  panel._q['#dsh-cb-mode'].fire('change', {})

  // 面板里应有 2 个档位行（用 querySelectorAll 找，并确认行内 input 可读）
  const rows = panel._q['#dsh-cb-ladder'].querySelectorAll('.dsh-cb-tier')
  check('档位行数 = 2', rows.length, 2)
  check('行内可读到 until 值', rows[0]?.querySelector('.dsh-cb-until')?.value, '10:00')
  check('行内可读到 cap 值', rows[0]?.querySelector('.dsh-cb-cap')?.value, '5')

  // 保存：应发出一次 PUT，body 是白名单结构
  panel._q['#dsh-cb-save'].fire('click', {})
  await settle()
  check('保存发出了 1 次 PUT', cfg.puts.length, 1)
  const sent = cfg.puts[0] || {}
  check('PUT 含 quotaMode', sent.quotaMode, 'group')
  check('PUT 含 ladder 数组', Array.isArray(sent.ladder), true)
  check('PUT 含 providerGroups', JSON.stringify(sent.providerGroups), JSON.stringify({ official: ['deepseek-official'], internal: ['example-gateway'] }))
  check('PUT 含 groupCapScale', sent.groupCapScale?.internal, 0.5)
  // ★ 只读字段绝不能回传：否则会把界面上那份快照固化进覆盖层
  for (const k of ['peakHours', 'holidays', 'valleyDays', 'calendarUrl']) {
    check(`PUT 不含只读键 ${k}`, k in sent, false)
  }
  check('PUT 含 dryRun', sent.dryRun, true)
  console.log(`        PUT body: ${JSON.stringify(sent)}`)
}

// ── 分组额度可视化 ────────────────────────────────────────────────────────
// 用户的原始反馈："我设置成了各组的额度，但是可视化面板完全看不出来"。
// 所以这里断言的是**看得见**：每个组一条、带倍率、带金额、超限变红。
// 只断言元素存在是不够的 —— 那种写法在 renderGroups 整个没被调用时也通过。
console.log('\n=== 分组额度条（设置必须看得见）===')
{
  const dom = makeDom()
  const grouped = {
    ...STATE,
    quotaMode: 'group',
    spentCny: 30,
    capCny: 30,
    tier: 5,
    groups: [
      { name: 'default', spentCny: 0, effSpentCny: 0, capCny: 30, scale: 1, allowed: true },
      { name: 'A', spentCny: 12.5, effSpentCny: 12.5, capCny: 22.5, scale: 0.75, allowed: true },
      { name: 'B', spentCny: 17.5, effSpentCny: 17.5, capCny: 18, scale: 0.6, allowed: true },
    ],
  }
  const bar = await boot(dom, grouped)
  await settle(60)
  const bars = bar._q['#dsh-cb-groupbars']
  check('分组条容器存在', !!bars, true)

  const rows = bars.querySelectorAll('.dsh-cb-grow')
  check('每个组一条', rows.length, 3)

  const html = bars.innerHTML || ''
  check('显示了 A 组', /A/.test(html), true)
  check('显示了 B 组', /B/.test(html), true)
  // 倍率必须露出来 —— 这正是"设了却看不出来"的地方
  check('A 组显示了倍率 ×0.75', /×0\.75/.test(html), true)
  check('B 组显示了倍率 ×0.6', /×0\.6/.test(html), true)
  check('scale=1 的组不显示多余的 ×1', bars.querySelectorAll('.dsh-cb-glabel').some((label) => /default\s*×1(?!\d)/.test(label.textContent)), false)
  check('A 组显示真实消费及倍率后的额度 ¥12.50/¥22.50', /12\.50\/22\.50/.test(html.replace(/\u00a5/g, '')), true)
  check('B 组显示真实消费及倍率后的额度 ¥17.50/¥18.00', /17\.50\/18\.00/.test(html.replace(/\u00a5/g, '')), true)
  check('A 组进度条约 55.6%', /width:55\.6%/.test(html), true)
  check('B 组进度条约 97.2%', /width:97\.2%/.test(html), true)
  check('group 顶部只标累计消费', bar._q['#dsh-cb-num'].textContent, '累计 ¥30.00')
  check('group 总进度按占比最高组显示', bar._q['#dsh-cb-fill'].style.width, '97.2%')
  check('group 标题说明各组额度的含义', bar._q['#dsh-cb-title'].title.includes('各组上限为基准额度 ¥30.00 × 各组倍率'), true)
  check('body 里的容器可见', bars.style.display, 'block')
}

console.log('\n=== 各组消费之和不应被当作单组触顶 ===')
{
  const dom = makeDom()
  const bar = await boot(dom, {
    ...STATE, quotaMode: 'group', spentCny: 40, capCny: 40,
    groups: [
      { name: 'half', spentCny: 10, effSpentCny: 10, capCny: 20, scale: 0.5, allowed: true },
      { name: 'double', spentCny: 30, effSpentCny: 30, capCny: 80, scale: 2, allowed: true },
    ],
  })
  await settle(60)
  check('总消费等于基准额度时，顶部仍展示实际最紧组占用 50%', bar._q['#dsh-cb-fill'].style.width, '50.0%')
  check('总消费达到基准额度不造成错误告警色', bar._q['#dsh-cb-fill'].style.background, '#22c55e')
  check('累计消费金额完整显示', bar._q['#dsh-cb-num'].textContent, '累计 ¥40.00')
}

console.log('\n=== 分组条的告警/超限配色 ===')
{
  const dom = makeDom()
  const bar = await boot(dom, {
    ...STATE, quotaMode: 'group', spentCny: 30, capCny: 30,
    groups: [
      { name: 'safe', spentCny: 1, effSpentCny: 1, capCny: 30, scale: 1, allowed: true },
      { name: 'nearly', spentCny: 26, effSpentCny: 26, capCny: 30, scale: 1, allowed: true },
      { name: 'blown', spentCny: 40, effSpentCny: 40, capCny: 30, scale: 1, allowed: false },
    ],
  })
  await settle(60)
  const html = bar._q['#dsh-cb-groupbars'].innerHTML || ''
  // 从 HTML 里按组名取出那一行的 class（模拟 DOM 不会解析每行的子节点）
  const clsOf = (name) => {
    const m = new RegExp('class="(dsh-cb-grow[^"]*)"[^>]*>\\s*<span class="dsh-cb-glabel"[^>]*>' + name + '</span>').exec(html)
    return m ? m[1] : null
  }
  check('safe 行渲染出来了', clsOf('safe'), 'dsh-cb-grow')
  check('≥80% 的组标 warn', /(^|\s)warn(\s|$)/.test(clsOf('nearly') || ''), true)
  check('超限的组标 over', /(^|\s)over(\s|$)/.test(clsOf('blown') || ''), true)
  const css = (dom.doc.head.children || []).map((c) => c.textContent || c._html || '').join('')
  check('超限组金额用红色（over 类）', /dsh-cb-grow\.over \.dsh-cb-glabel\{color:#f87171/.test(css), true)
  check('warn 用琥珀色', /dsh-cb-grow\.warn \.dsh-cb-gfill\{background:#f59e0b/.test(css), true)
  check('over 用红色条', /dsh-cb-grow\.over \.dsh-cb-gfill\{background:#ef4444/.test(css), true)
}

console.log('\n=== total 隐藏分组；group 即使单组也保留组名 ===')
{
  const dom = makeDom()
  const bar = await boot(dom, { ...STATE, quotaMode: 'total', spentCny: 3.42, capCny: 5 })
  await settle(60)
  check('total 模式下分组条隐藏', bar._q['#dsh-cb-groupbars'].style.display, 'none')
}
{
  const dom = makeDom()
  const bar = await boot(dom, {
    ...STATE, quotaMode: 'group',
    groups: [{ name: 'official', spentCny: 3, effSpentCny: 3, capCny: 5, scale: 1, allowed: true }],
  })
  await settle(60)
  const bars = bar._q['#dsh-cb-groupbars']
  check('只有一组时依然显示分组条', bars.style.display, 'block')
  check('单组显示具名分组 official', /official/.test(bars.innerHTML), true)
  check('单组只有一行', bars.querySelectorAll('.dsh-cb-grow').length, 1)
}
{
  const dom = makeDom()
  const cfg = { puts: [], onState: async () => ({ ok: true, json: async () => ({ ...STATE, quotaMode: 'group', groups: [] }) }) }
  const bar = await boot(dom, STATE, {}, cfg)
  await settle()
  const bars = bar._q['#dsh-cb-groupbars']
  check('无组仍标明分组模式', bars.style.display, 'block')
  check('无组时提示配置入口', /暂无分组消费.*设置 API 分组/.test(bars.innerHTML), true)
  cfg.onState = async () => ({ ok: true, json: async () => ({ ...STATE, quotaMode: 'total' }) })
  await dom.poll()
  check('切换 total 后隐藏并清理分组内容', [bars.style.display, bars.innerHTML], ['none', ''])
}

// 用可控响应验证真实时序：必须先更新条形图，再报告已生效。
const response = (body, ok = true) => ({ ok, json: async () => body })
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const editFixture = () => ({
  body: { effective: {
    quotaMode: 'group', ladder: [{ until: '24:00', cap: 5 }],
    providerGroups: { A: ['p-a'], B: ['p-b'] }, groupCapScale: { A: 1, B: 0.5 },
    availableProviders: ['p-a', 'p-b'], dryRun: false, resumeMinHeadroomPct: 15,
  }, override: {} }, puts: [],
})
const oldGrouped = { ...STATE, quotaMode: 'group', groups: [
  { name: 'A', effSpentCny: 1, capCny: 5, scale: 1, allowed: true },
  { name: 'B', effSpentCny: 2, capCny: 5, scale: 0.5, allowed: true },
] }
const newGrouped = { ...STATE, quotaMode: 'group', groups: [
  { name: 'merged', effSpentCny: 2.25, capCny: 5, scale: 0.75, allowed: true },
] }
const openConfig = async (dom, bar) => {
  bar._q['#dsh-cb-cfg'].press()
  await settle()
  return dom.all.find((e) => e.id === 'dsh-cb-panel')
}

console.log('\n=== 保存立即重画、删除不残留、旧轮询不能覆盖 ===')
{
  const dom = makeDom(), cfg = editFixture()
  const oldPoll = deferred(), savedReply = deferred()
  let stateReads = 0
  cfg.onState = () => ++stateReads === 1 ? response(oldGrouped) : oldPoll.promise
  cfg.onPut = () => savedReply.promise
  const bar = await boot(dom, oldGrouped, {}, cfg)
  const panel = await openConfig(dom, bar)
  const bars = bar._q['#dsh-cb-groupbars']
  check('保存前有两组', bars.querySelectorAll('.dsh-cb-grow').length, 2)
  const rows = panel._q['#dsh-cb-grouplist'].querySelectorAll('.dsh-cb-group')
  rows[0].querySelector('.dsh-cb-gname').value = 'merged'
  rows[0].querySelector('.dsh-cb-gscale').value = '0.75'
  rows[0].querySelectorAll('.dsh-cb-gpick').forEach((p) => { p.checked = true })
  rows[1].querySelector('.dsh-cb-del').press()
  check('删除行后编辑器只剩一组', panel._q['#dsh-cb-grouplist'].querySelectorAll('.dsh-cb-group').length, 1)
  const pendingOldPoll = dom.poll()
  panel._q['#dsh-cb-save'].press()
  await settle()
  check('保存中显示等待反馈', panel._q['#dsh-cb-msg'].textContent, '保存中…')
  check('保存期间禁用保存按钮', panel._q['#dsh-cb-save'].disabled, true)
  panel._q['#dsh-cb-save'].fire('click', {})
  await dom.poll()
  check('保存中不重复 PUT', cfg.puts.length, 1)
  check('保存中定时轮询暂停', stateReads, 2)
  check('删除组和新 provider 归属已提交', cfg.puts[0].providerGroups, { merged: ['p-a', 'p-b'] })
  savedReply.resolve(response({ ok: true, applied: cfg.puts[0], state: newGrouped }))
  await settle()
  check('PUT 返回的单组立即渲染', bars.querySelectorAll('.dsh-cb-grow').length, 1)
  check('新组名和倍率都可见', /merged ×0\.75/.test(bars.innerHTML), true)
  check('已删组不残留', bars.querySelectorAll('.dsh-cb-glabel').some((label) => label.textContent === 'B'), false)
  check('直接使用响应状态，无额外轮询', stateReads, 2)
  check('已生效摘要含组名、倍率和 provider', /已生效：分组模式.*merged ×0\.75 \[p-a, p-b\]/.test(panel._q['#dsh-cb-msg'].textContent), true)
  check('保存完成按钮恢复可用', panel._q['#dsh-cb-save'].disabled, false)
  oldPoll.resolve(response(oldGrouped))
  await pendingOldPoll
  check('保存前发出的迟到轮询不能还原旧组', /merged ×0\.75/.test(bars.innerHTML), true)
  check('迟到轮询不能恢复被删除行', bars.querySelectorAll('.dsh-cb-grow').length, 1)
}

console.log('\n=== 兼容无 state 的保存响应：等状态刷新后才确认 ===')
{
  const dom = makeDom(), cfg = editFixture(), refreshed = deferred()
  let stateReads = 0
  cfg.onState = () => ++stateReads === 1 ? response(oldGrouped) : refreshed.promise
  cfg.onPut = (sent) => response({ ok: true, applied: sent })
  const bar = await boot(dom, oldGrouped, {}, cfg)
  const panel = await openConfig(dom, bar)
  panel._q['#dsh-cb-save'].press()
  await settle()
  check('兼容路径立即请求状态', stateReads, 2)
  check('状态尚未返回时不提前报告已生效', panel._q['#dsh-cb-msg'].textContent, '保存中…')
  refreshed.resolve(response(newGrouped))
  await settle()
  check('状态返回后更新条形图', /merged/.test(bar._q['#dsh-cb-groupbars'].innerHTML), true)
  check('状态更新后报告已生效', /^已生效：/.test(panel._q['#dsh-cb-msg'].textContent), true)
}

console.log('\n=== 保存失败和保存后刷新失败分别反馈 ===')
{
  const dom = makeDom(), cfg = editFixture()
  cfg.onPut = () => response({ ok: false, error: '配置校验失败' }, false)
  const bar = await boot(dom, oldGrouped, {}, cfg)
  const panel = await openConfig(dom, bar)
  panel._q['#dsh-cb-save'].press()
  await settle()
  check('保存失败说明服务端原因', panel._q['#dsh-cb-msg'].textContent, '保存失败: 配置校验失败')
  check('保存失败保持原状态', bar._q['#dsh-cb-groupbars'].querySelectorAll('.dsh-cb-grow').length, 2)
  check('失败后可重试', panel._q['#dsh-cb-save'].disabled, false)
  cfg.onPut = (sent) => response({ ok: true, applied: sent })
  cfg.onState = () => response(null, false)
  panel._q['#dsh-cb-save'].press()
  await settle()
  check('保存成功但刷新失败不冒充已生效', panel._q['#dsh-cb-msg'].textContent, '配置已保存，状态刷新失败；稍后自动重试')
  check('刷新失败显示错误样式', panel._q['#dsh-cb-msg'].className, 'dsh-cb-err')
  panel._q['#dsh-cb-grouplist'].querySelectorAll('.dsh-cb-group').forEach((row) => row.querySelector('.dsh-cb-del').press())
  cfg.onPut = (sent) => response({ ok: true, applied: sent, state: { ...STATE, quotaMode: 'group', groups: [] } })
  panel._q['#dsh-cb-save'].press()
  await settle()
  check('未配置具名组时说明 API 各自独立计额', panel._q['#dsh-cb-msg'].textContent,
    '已生效：分组模式 · 未设置具名分组，未分组的 API 各自独立计额（无需重启）')
}

console.log('\n=== 历史小高度切分组时临时展开，长列表滚动，折叠和缩放偏好保留 ===')
{
  const dom = makeDom()
  const store = { 'dsh-cb-size': JSON.stringify({ w: 240, h: 80 }) }
  const savedSize = store['dsh-cb-size']
  let current = { ...STATE, quotaMode: 'total' }
  const cfg = { puts: [], onState: () => response(current) }
  const bar = await boot(dom, current, store, cfg)
  await settle()
  check('total 恢复历史小高度', bar.style.height, '80px')
  const one = { name: 'very-long-provider-group-name', effSpentCny: 2, capCny: 5, scale: 0.75, allowed: true }
  current = { ...STATE, quotaMode: 'group', groups: [one] }
  await dom.poll()
  const singleMinHeight = parseFloat(bar.style.minHeight)
  check('单组显示高度超出旧的 80px，避免内容被裁切', singleMinHeight > 80, true)
  const bars = bar._q['#dsh-cb-groupbars']
  check('省略标签悬停可见完整组名及倍率', bars.querySelector('.dsh-cb-glabel').title, 'very-long-provider-group-name ×0.75')
  current = { ...current, groups: [one, { ...one, name: 'B' }, { ...one, name: 'C' }] }
  await dom.poll()
  check('增加组数后继续为内容展开', parseFloat(bar.style.minHeight) > singleMinHeight, true)
  check('多组全部仍在列表中', bars.querySelectorAll('.dsh-cb-grow').length, 3)
  current = { ...current, groups: Array.from({ length: 30 }, (_, i) => ({ ...one, name: 'group-' + i })) }
  await dom.poll()
  check('大量分组不会撑出 MAX_H', parseFloat(bar.style.minHeight) <= 320, true)
  check('大量分组有受限的滚动区', parseFloat(bars.style.maxHeight) > 0 && parseFloat(bars.style.maxHeight) < 320, true)
  const css = dom.doc.head.children.map((c) => c.textContent || '').join('')
  check('分组列表超长时允许垂直滚动', /#dsh-cb-groupbars\{[^}]*overflow-y:auto/.test(css), true)
  bar._q['#dsh-cb-title'].press()
  check('分组展开后仍可折叠', bar.classList.contains('collapsed'), true)
  check('折叠覆盖历史高度与分组最小高度', /#dsh-cb-bar\.collapsed\{[^}]*height:auto !important;min-height:0 !important/.test(css), true)
  check('折叠时内容区仍隐藏', /#dsh-cb-bar\.collapsed #dsh-cb-body[^}]*display:none/.test(css), true)
  current = { ...STATE, quotaMode: 'total' }
  await dom.poll()
  bar._q['#dsh-cb-title'].press()
  check('切回 total 清除临时高度并恢复原偏好', [bar.style.minHeight, bar.style.height, bar.classList.contains('collapsed')], ['', '80px', false])
  check('自动展开没有覆盖持久化缩放偏好', store['dsh-cb-size'], savedSize)
}

console.log('\n=== 分组名称和 provider 按字面量往返，特殊对象键不丢失或误选 ===')
{
  const dom = makeDom(), cfg = editFixture()
  const literalName = 'A&amp;B " <team>'
  const literalProvider = 'upstream &quot; checked <img class="injected">'
  cfg.body.effective.providerGroups = Object.fromEntries([
    ['__proto__', [literalProvider]], ['constructor', ['toString']], [literalName, ['p-a']],
  ])
  cfg.body.effective.groupCapScale = JSON.parse('{"__proto__":0.5}')
  cfg.body.effective.availableProviders = [literalProvider, 'p-a', '__proto__', 'constructor', 'toString']
  cfg.onPut = (sent) => response({ ok: true, applied: sent, state: oldGrouped })
  const bar = await boot(dom, oldGrouped, {}, cfg)
  const panel = await openConfig(dom, bar)
  const rows = panel._q['#dsh-cb-grouplist'].querySelectorAll('.dsh-cb-group')
  check('字符实体、引号和尖括号组名原样回显', rows.map((row) => row.querySelector('.dsh-cb-gname').value),
    ['__proto__', 'constructor', literalName])
  check('provider 内容不创建 HTML 元素', panel.querySelectorAll('.injected').length, 0)
  check('provider 的标签文本和属性均转义', rows[0].innerHTML.includes('&lt;img class=&quot;injected&quot;&gt;'), true)
  for (let i = 0; i < rows.length; i++) {
    const picks = rows[i].querySelectorAll('.dsh-cb-gpick')
    check('特殊 provider 候选值原样回显 ' + i, picks.map((pick) => pick.value), cfg.body.effective.availableProviders)
    check('只勾选属于本组的 provider ' + i, picks.filter((pick) => pick.checked).map((pick) => pick.value),
      Object.values(cfg.body.effective.providerGroups)[i])
  }
  check('constructor 没有配置倍率时仍使用默认 1.0', rows[1].querySelector('.dsh-cb-gscale').value, '1.0')
  panel._q['#dsh-cb-save'].press()
  await settle()
  check('特殊组名和 provider 保存后仍完整', cfg.puts[0]?.providerGroups, cfg.body.effective.providerGroups)
  check('__proto__ 组倍率完整保存', Object.getOwnPropertyDescriptor(cfg.puts[0]?.groupCapScale || {}, '__proto__')?.value, 0.5)
}

console.log('\n=== 配置读取与保存竞态：迟到读取不能回退已保存表单 ===')
{
  const dom = makeDom(), cfg = editFixture(), oldRead = deferred(), savedReply = deferred()
  const bar = await boot(dom, oldGrouped, {}, cfg)
  const panel = await openConfig(dom, bar)
  let configReads = 0
  cfg.onGet = () => { configReads++; return oldRead.promise }
  cfg.onPut = () => savedReply.promise
  panel._q['#dsh-cb-reload'].press()
  panel._q['#dsh-cb-grouplist'].querySelector('.dsh-cb-gname').value = 'saved-name'
  panel._q['#dsh-cb-save'].press()
  await settle()
  check('保存期间禁用重新载入按钮', panel._q['#dsh-cb-reload'].disabled, true)
  panel._q['#dsh-cb-reload'].fire('click', {})
  check('保存期间忽略重新载入事件', configReads, 1)
  savedReply.resolve(response({ ok: true, applied: cfg.puts[0], state: newGrouped }))
  await settle()
  const savedMessage = panel._q['#dsh-cb-msg'].textContent
  oldRead.resolve(response(cfg.body))
  await settle()
  check('迟到旧读取不还原组名', panel._q['#dsh-cb-grouplist'].querySelector('.dsh-cb-gname').value, 'saved-name')
  check('迟到旧读取不覆盖已生效反馈', panel._q['#dsh-cb-msg'].textContent, savedMessage)
  check('保存结束恢复重新载入按钮', panel._q['#dsh-cb-reload'].disabled, false)
  panel._q['#dsh-cb-save'].press()
  await settle()
  check('再次保存不会回退到旧配置', Object.keys(cfg.puts[1].providerGroups), ['saved-name', 'B'])
}

console.log('\n=== 连续重新载入仅采纳最后发起的读取 ===')
{
  const dom = makeDom(), cfg = editFixture(), older = deferred(), newer = deferred()
  const bar = await boot(dom, oldGrouped, {}, cfg)
  const panel = await openConfig(dom, bar)
  let configReads = 0
  cfg.onGet = () => ++configReads === 1 ? older.promise : newer.promise
  panel._q['#dsh-cb-reload'].press()
  panel._q['#dsh-cb-reload'].press()
  newer.resolve(response({ effective: { ...cfg.body.effective, providerGroups: { newest: ['p-a'] }, groupCapScale: {} } }))
  await settle()
  older.resolve(response(cfg.body))
  await settle()
  const rows = panel._q['#dsh-cb-grouplist'].querySelectorAll('.dsh-cb-group')
  check('较早请求迟到时不覆盖最新回显', rows.map((row) => row.querySelector('.dsh-cb-gname').value), ['newest'])
}

console.log('\n=== 分组撑高后重新拉回视口，不覆盖缩放偏好 ===')
{
  const dom = makeDom(1600, 900)
  const cfg = { puts: [], onState: () => response({ ...STATE, quotaMode: 'total' }) }
  const store = { 'dsh-cb-pos': JSON.stringify({ x: 20, y: 820 }), 'dsh-cb-size': JSON.stringify({ w: 240, h: 80 }) }
  const bar = await boot(dom, STATE, store, cfg)
  await settle()
  // 为此场景提供浏览器布局后的实际尺寸；模拟 DOM 不负责计算 CSS 布局。
  Object.defineProperty(bar, 'offsetHeight', { get: () => Math.max(80, parseFloat(bar.style.minHeight) || 0) })
  cfg.onState = () => response({ ...STATE, quotaMode: 'group', groups: Array.from({ length: 20 }, (_, i) => ({
    name: 'group-' + i, effSpentCny: 1, capCny: 5, scale: 1, allowed: true,
  })) })
  await dom.poll()
  check('增高后仍完整位于视口', parseFloat(bar.style.top) + bar.offsetHeight <= 900, true)
  check('必要时才向上移动', bar.style.top, '580px')
  check('原水平位置保持不变', bar.style.left, '20px')
  check('重定位没有覆盖缩放高度偏好', bar.style.height, '80px')
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
