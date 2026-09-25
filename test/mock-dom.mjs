/**
 * 共享的模拟 DOM —— 给 test/drive.mjs 与 test/bar.mjs 用。
 * 不是真浏览器，但 pointer 事件序列、几何钳制、localStorage 都按规范语义模拟。
 */
import fs from 'node:fs'

// HTML 解析只解码一遍；输入值中的字面量 "&amp;" 不能被解码两次。
const decodeHtml = (value) => String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  if (entity[0] !== '#') return named[entity.toLowerCase()]
  const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd'
})

/** 从 lib/index.js 取出客户端脚本（并校验没有会被服务端求值的插值） */
export function loadClientJs(root = new URL('..', import.meta.url)) {
  const src = fs.readFileSync(new URL('lib/index.js', root), 'utf8')
  const m = src.match(/const CLIENT_JS = String\.raw`([\s\S]*?)\n`\n/)
  if (!m) throw new Error('lib/index.js 里找不到 CLIENT_JS')
  const js = m[1]
  if (/\$\{/.test(js)) throw new Error('CLIENT_JS 里出现了模板插值，会被服务端求值')
  return js
}

/** 造一个够用的 DOM 环境 */
export function makeDom(innerWidth = 1600, innerHeight = 900) {
  const all = []
  /** 深度优先收集后代的元素（靠 appendChild 建立的 _parent 链回溯） */
  const descendants = (root) => {
    const out = []
    for (const e of all) {
      let p = e._parent
      while (p) { if (p === root) { out.push(e); break } p = p._parent }
    }
    return out
  }
  const mk = (tag) => {
    const el = {
      tagName: tag, className: '', textContent: '', title: '',
      style: {}, children: [], _q: {}, _h: {}, _html: '',
      offsetWidth: 210, offsetHeight: 60,
      get innerHTML() { return this._html },
      // 极简解析，但覆盖测试真正用到的形态：
      //   ① <tag id="x" ...>文字</tag>       —— 普通元素，取标签后的文字
      //   ② <input type="text" id="x" ...>   —— 自闭合/空元素，没有结束标签
      //   ③ <input type="checkbox" id="x" checked>
      // 逐个「开标签」处理，避免把标签间的无关内容吞进 textContent。
      // 不解析的话 querySelector 返回空元素，断言就全是假的。
      set innerHTML(v) {
        this._html = v
        // innerHTML 替换会卸载旧子树；否则重新渲染/删除分组后仍会数到幽灵节点。
        for (const child of all) if (child._parent === this) child._parent = null
        this.children = []
        // ⚠️ 必须重置 _q：替换 innerHTML 后，旧内容对应的缓存条目（尤其是
        //    querySelector 曾经造出来的**占位元素**）已经不在 DOM 里了。
        //    留着它们会让 querySelectorAll 数出双份，被测代码遍历到空占位行
        //    读出 undefined —— 真实功能没坏，却测成了坏的。
        this._q = {}
        const VOID = /^(input|br|hr|img|meta|link|source|area|base|col|embed|track|wbr)$/i
        // 带 id 或带 class 的元素都要登记：只认 id 的话，像
        // <input type="checkbox" class="dsh-cb-gpick"> 这种没有 id 的控件
        // 就查不到，querySelectorAll('.dsh-cb-gpick') 会静默返回空数组
        // —— 断言于是变成假绿（或假红）。实测踩过。
        const re = /<(\w+)([^>]*\b(?:id|class)="[^"]*"[^>]*)>/g
        let m
        while ((m = re.exec(v))) {
          const tag = m[1]
          const attrs = m[2]
          const idm = /(?:^|\s)id="([^"]+)"/.exec(attrs)
          const id = idm ? idm[1] : null
          const node = mk(tag)
          if (id) node.id = id
          // 空元素或自闭合：不找结束标签，文字为空
          const selfClosed = /\/\s*$/.test(attrs) || VOID.test(tag)
          if (!selfClosed) {
            const after = v.slice(m.index + m[0].length)
            const close = after.indexOf('</' + tag)
            if (close >= 0) node.textContent = decodeHtml(after.slice(0, close))
          }
          const t = /title="([^"]*)"/.exec(attrs)
          if (t) node.title = decodeHtml(t[1])
          const ty = /type="([^"]*)"/.exec(attrs)
          if (ty) node.type = ty[1]
          const ph = /placeholder="([^"]*)"/.exec(attrs)
          if (ph) node.placeholder = decodeHtml(ph[1])
          const va = /value="([^"]*)"/.exec(attrs)
          if (va) node.value = decodeHtml(va[1])
          if (node.type === 'checkbox') node.checked = /\bchecked\b/.test(attrs.replace(/"[^"]*"/g, ''))
          const cl = /class="([^"]*)"/.exec(attrs)
          if (cl) node.className = cl[1]
          // 挂上父子链，否则 querySelectorAll 的 descendants() 回溯不到这些节点
          node._parent = this
          // ⚠️ _q 的语义必须是"选择器 → **单个元素**"：querySelector 直接返回它。
          //    曾经把 class 命中写成了数组桶，于是 querySelector('.x') 返回数组，
          //    调用方 .addEventListener 立刻炸 —— 面板整个渲染不出来。
          //    一个 class 可能命中多个元素，所以只记第一个，别覆盖已有的。
          if (id) this._q['#' + id] = node
          if (cl) {
            const key = '.' + cl[1]
            if (!this._q[key]) this._q[key] = node
          }
        }
      },
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c) },
        remove(c) { this._s.delete(c) },
        toggle(c, on) {
          if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c) }
          else { on ? this._s.add(c) : this._s.delete(c) }
        },
        contains(c) { return this._s.has(c) },
      },
      appendChild(c) { c._parent = this; this.children.push(c); return c },
      get parentNode() { return this._parent || null },
      removeChild(c) {
        if (c._parent !== this) throw new Error('NotFoundError')
        c._parent = null
        this.children = this.children.filter((child) => child !== c)
        return c
      },
      addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f) },
      /**
       * 在**本节点**触发事件，并按真实浏览器语义**冒泡到祖先**。
       * 返回 { prevented, stopped }：prevented 供 press 判断是否抑制 click。
       */
      fire(t, ev) {
        let prevented = false
        let stopped = false
        // 兼容两种写法：坐标既可在顶层（历史用法），也可在 detail 里（press 用）
        const src = Object.assign({}, ev && ev.detail, ev)
        const clientX = src.clientX === undefined ? 0 : src.clientX
        const clientY = src.clientY === undefined ? 0 : src.clientY
        const extra = (ev && ev.detail && ev.detail.extra) || {}
        // 显式传入的 target 优先（模拟"事件源自子元素"），否则就是本节点
        const targetEl = src.target || extra.target || this
        const base = {
          button: 0, type: t, clientX, clientY, pointerId: 1,
          stopPropagation() { stopped = true },
          preventDefault() { prevented = true },
        }
        // 冒泡：target → … → 根
        let node = this
        while (node) {
          for (const f of (node._h[t] || [])) {
            f(Object.assign({}, base, extra, { target: targetEl, currentTarget: node }))
          }
          if (stopped) break
          node = node._parent
        }
        this._lastDefaultPrevented = prevented
        return { prevented, stopped }
      },
      /**
       * 模拟一次真实的"按下 → 抬起 → 点击"（含冒泡）。
       *
       * ★ 为什么要显式实现"pointerdown 的 preventDefault 会抑制 click"：
       *   这是 Chrome/Edge 在 Windows 上的实测行为。真实项目里踩过：
       *   齿轮 ⚙ 位于 #dsh-cb-head 内部，被拖动逻辑的 pointerdown 分支调了
       *   preventDefault，于是它的 click 监听器永远不触发，配置面板
       *   **永远打不开** —— 而裸调 fire('click') 的测试完全测不出来。
       *   把浏览器语义写进夹具，这类 bug 才可能被断言抓住。
       */
      press(target, detail = {}) {
        // 不写 `press(target = this)` —— 方法简写的默认参数里 this 取不到本元素
        const el = target || this
        const ev = { detail }
        const onDown = el.fire('pointerdown', ev)
        el.fire('pointerup', ev)
        // 被 preventDefault 的 pointerdown 不产生 click
        if (!onDown.prevented) el.fire('click', ev)
        return { clickSuppressed: onDown.prevented }
      },
      /**
       * 模拟一次真实的"按下 → 抬起 → 点击"。
       *
       * ★ 为什么要显式实现这条规则：
       *   在 **pointerdown 上调用 preventDefault() 会阻止后续的 click 事件**
       *   （Chrome/Edge 在 Windows 的实测行为）。真实项目里踩过：
       *   齿轮 ⚙ 位于 #dsh-cb-head 内部，被拖动逻辑的 pointerdown 分支
       *   调了 preventDefault，于是它的 click 监听器永远不触发，
       *   配置面板**永远打不开** —— 而裸调 fire('click') 的测试完全测不出来。
       *   把浏览器语义写进夹具，这类 bug 才可能被断言抓住。
       */
      setPointerCapture() {}, releasePointerCapture() {},
      getBoundingClientRect() {
        const l = parseFloat(this.style.left)
        const t = parseFloat(this.style.top)
        return { left: isNaN(l) ? 40 : l, top: isNaN(t) ? 16 : t,
                 width: this.offsetWidth, height: this.offsetHeight }
      },
      querySelector(sel) {
        // 顺序很关键：**先找真实后代**，再退回 _q 缓存，最后才造占位元素。
        //
        // ⚠️ 曾经是"_q 命中就直接返回"，结果 _q 里那个早期造的**陈旧占位元素**
        //    （没有子节点、不在 DOM 树里）会一直抢先返回：
        //    panel.querySelectorAll('.dsh-cb-row') 数出双份，
        //    遍历到占位行就读出 undefined → "档位格式不对：undefined / undefined"，
        //    保存永远失败。这不是产品 bug，是夹具把真实功能测成了坏的。
        const hits = this.querySelectorAll(sel)
        if (hits.length) return hits[0]
        if (this._q[sel]) return this._q[sel]
        // 未命中且是类选择器：真去解析自己的 innerHTML。
        // 动态创建的行（如阶梯的 <input class="dsh-cb-until">）只有这样才能找到；
        // 直接造一个空 span 会让被测代码读到 undefined。
        if (sel.charAt(0) === '.' && this._html) {
          const cls = sel.slice(1)
          const re = new RegExp('<(\\w+)([^>]*\\bclass="' + cls + '"[^>]*)>', 'g')
          const m = re.exec(this._html)
          if (m) {
            const node = mk(m[1])
            node.className = cls
            const va = /value="([^"]*)"/.exec(m[2])
            node.value = va ? decodeHtml(va[1]) : ''
            const ph = /placeholder="([^"]*)"/.exec(m[2])
            if (ph) node.placeholder = decodeHtml(ph[1])
            return node
          }
        }
        // ⚠️ 兜底占位元素**故意不写进 _q**。
        //    写进去的话，它会被 querySelectorAll 当成"已登记的匹配项"，
        //    但它其实不在 DOM 树里（没有 _parent），于是
        //    querySelectorAll('.dsh-cb-row') 数出双份、遍历到空行读出 undefined。
        //    占位元素只服务于"同一次调用里紧接着写 .value"，
        //    跨调用复用没有意义，反而制造幽灵节点。
        const e = mk('span')
        if (sel.charAt(0) === '#') e.id = sel.slice(1)
        if (sel.charAt(0) === '.') e.className = sel.slice(1)
        return e
      },
      querySelectorAll(sel) {
        const want = sel.charAt(0) === '.' ? { cls: sel.slice(1) } : { id: sel.slice(1) }
        // descendants() 遍历 mk() 造出来的全部元素，靠 _parent 链回溯到 this，
        // 所以 mk 必须把每个元素登记进 all —— 否则动态创建的行会查不到。
        //
        // ⚠️ 还必须把 _q 里那些**不是真正后代**的条目排掉：
        //    querySelector 未命中时会造一个占位元素塞进 _q（为了让被测代码
        //    读得到 value），那个占位元素没有子节点、也不在 DOM 树里。
        //    无脑并进来会让 querySelectorAll('.dsh-cb-row') 数出双份 ——
        //    于是 collectConfig 遍历到空占位行、读出 undefined，报
        //    "档位格式不对：undefined / undefined"，保存永远失败。
        const pool = [...Object.values(this._q), ...descendants(this)]
        const seen = new Set()
        const isDescendant = (e) => {
          let p = e._parent
          while (p) { if (p === this) return true; p = p._parent }
          return false
        }
        const hasClass = (e, cls) =>
          // ⚠️ 不能用全等比较：className 可能是 "dsh-cb-row dsh-cb-tier" 这种
          //    多类名字符串，真 DOM 的 .dsh-cb-tier 选择器能命中它。
          //    全等比较会让 querySelectorAll('.dsh-cb-tier') 返回空 —— 夹具
          //    的缺陷把正常代码测成坏的。
          (typeof e.className === 'string' && e.className.split(/\s+/).indexOf(cls) >= 0)
          || (e.classList && e.classList.contains(cls))
        return pool.filter((e) => {
          if (!e || typeof e !== 'object' || Array.isArray(e) || seen.has(e)) return false
          seen.add(e)
          const match = want.cls ? hasClass(e, want.cls) : e.id === want.id
          // 自己或真正的后代才算命中
          return match && (e === this || isDescendant(e))
        })
      },
    }
    all.push(el)
    return el
  }
  return {
    doc: {
      readyState: 'complete', title: 'DSH', head: mk('head'), body: mk('body'),
      createElement: mk, addEventListener() {},
    },
    all, mk, innerWidth, innerHeight,
  }
}

/** 装好全局环境并执行客户端脚本，返回进度条元素 */
export function bootBar(dom, state, store = {}, cfgResp = null) {
  globalThis.window = {
    innerWidth: dom.innerWidth, innerHeight: dom.innerHeight, addEventListener() {},
  }
  globalThis.document = dom.doc
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v },
    removeItem: (k) => { delete store[k] },
  }
  // cfgResp：/config.json 的响应；PUT 调用记到 cfgResp.puts
  cfgResp = cfgResp || { body: { effective: {}, override: {} }, puts: [] }
  globalThis.fetch = async (url, opts) => {
    if (String(url).indexOf('/config.json') >= 0) {
      if (opts && opts.method === 'PUT') {
        const body = JSON.parse(opts.body)
        cfgResp.puts.push(body)
        if (cfgResp.onPut) return cfgResp.onPut(body)
        return { ok: true, json: async () => ({ ok: true, applied: { quotaMode: 'group', ladder: [] } }) }
      }
      if (cfgResp.onGet) return cfgResp.onGet()
      return { ok: true, json: async () => cfgResp.body }
    }
    return cfgResp.onState ? cfgResp.onState() : { ok: true, json: async () => state }
  }
  globalThis.requestAnimationFrame = (cb) => { cb(); return 0 }
  globalThis.setInterval = (cb) => { dom.poll = cb; return 0 }
  delete globalThis.window.__dshCostBudgetBar
  eval(loadClientJs())
  const bar = dom.all.find((e) => e.id === 'dsh-cb-bar')
  bar.__cfgResp = cfgResp
  return bar
}

/** 等异步的 loadConfig/poll 落地（真实环境里是网络往返） */
export const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms))
