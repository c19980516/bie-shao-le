# 别烧了（bie-shao-le）

DeepSeek Harness 预算插件：额度到了就歇会儿，别烧了。

插件安装标识为 `dsh-cost-budget`。

**0.1.0 为实验性测试版。** 随附 `cordis.patch.yml` 默认 `dryRun: true`：记录和显示消费，**不会拦截调用或暂停任务**。核对计量后，手动改为 `false` 才启用预算限制。随附配置还默认启用官方余额轮询，会尝试读取 DSH 凭证并每 60 秒访问余额接口；关闭方法见[余额观测](#余额观测balance)。

DSH 成本预算插件：按**北京时间阶梯**累计当日消费金额，启用预算限制后，在已收到的用量达到上限时**拦截后续工具和模型调用**并暂停 goal，到阶梯边界检查额度，余量充足时自动恢复续跑。

消费依赖宿主回报的用量，正在执行的请求和并发请求仍可能产生费用。插件不能撤销已经发出的请求，也不承诺账单绝对不超过额度。

```
00:00 ─── ¥5 ─── 10:00 ─── ¥10 ─── 11:00 ─── ¥15 ─── 12:00
                                                      │
              ¥25 ─── 14:00 ─── ¥30 ─── 16:00 ─── ¥40 ─── 24:00
```

默认 token 估算模式的阶梯是**累积包络**语义：到 `until` 时刻为止，当日**累计**消费不得超过 `cap` 元。
边界到达时上限**跳变放宽**，不"补花"；次日北京 00:00 归零。以上数值全部可配置。
可选 `spendSource: observed` 使用官方余额的**当前档位窗口消费**，不是当日累计，详见[余额作为预算判据](#余额作为预算判据)。

---

## 它解决什么

DSH 的 goal 有 `maxGoalRounds`，但它只管**回合数**，不管钱：

> "does not meter tokens, currency, wall time, or provider quotas"

所以一个跑飞的 goal 可以在回合上限内烧掉任意金额。本插件补上这个缺口，并且在
**回合中途**就能拦住：`agent/pre-step` 在模型请求前拒绝继续，
`tools/pre-execute` 同时拒绝工具执行，并提供可读的预算说明。

同时，插件的计量是**独立于挂件**的：不依赖任何 UI 插件，账本格式是公开契约。

---

## 安装

运行要求：**Node.js 22.15–22.x 或 24.x**（测试入口使用 `node:module` 的 `registerHooks`），安装使用 **pnpm 11.19.0**。当前已在 Node.js 24、DSH CLI `0.1.5-rc.1` 及其 `0.1.5-rc.2` 核心包组合上验证；其他宿主版本尚未验证。

在插件仓库根目录打开 PowerShell：

```powershell
# 1) 装依赖（link: 安装的插件没有 node_modules 祖先目录，必须自带依赖）
$pluginPath = (Get-Location).Path
pnpm install --frozen-lockfile --ignore-scripts

# 2) 挂进 web profile
dsh plugin --profile web add "link:$pluginPath"

# 3) 重启 dsh web
```

`cordis.patch.yml` 里带全部可配置项和注释。改完配置需要重启生效。

> ⚠️ **从 DSH 自己的 shell 里重启 dsh web 会失败**：shell 是 dsh web 的子进程，
> 杀掉 dsh web 会连带杀掉正在执行重启的 shell，于是脚本停在半路、服务器再也起不来。
> 让重启跑在**计划服务**下（`schtasks`）可避免，或者干脆在外部终端里重启。

---

## 配置

全部在 `cordis.patch.yml` 的 `config:` 下：

| 键 | 默认 | 说明 |
|---|---|---|
| `ladder` | 见上表 | 阶梯。`until` 是"到几点为止"，`cap` 是"累计不超过多少元" |
| `peakHours` | `[[9,12],[14,18]]` | 峰时区间（北京时间，半开）。**只影响单价折算**，与阶梯判定无关 |
| `unknownModelPolicy` | `warn-and-fallback` | 未知模型：按 flash 价兜底并告警；`deny` 表示跳过计量，会漏算，**不会阻止模型调用** |
| `ledgerWaitMs` | `30000` | 跨进程账本锁的等待上限 |
| `dryRun` | `false`（随附 patch 为 `true`） | `true` = 只记账和显示预算，不拦工具或模型、不暂停或自动恢复 goal |
| `spendSource` | `estimated` | `estimated` 为当日 token 估算；`observed` 为当前档位余额下降累计，仅支持 `quotaMode: total` |
| `notify` | `{browser:false, whale:false}` | 保留配置项，桌面通知和小鲸鱼通知尚未实现；设为 true 也不会发出通知 |

**建议**：先跑一天 `dryRun: true`，核对账本金额与实际花费是否吻合，再改成 `false`。

### 调试档

`debug` 段用来在 1 分钟内走完"触顶硬停 → 时钟跨档 → 自动恢复"，不必真等到整点：

```yaml
debug:
  timeOffsetMs: 0          # 判定时钟整体平移（毫秒）
  forceSpentCny: null      # 强制"已花金额"，高于当前档上限即立刻硬停
  treatBoundaryAsInMs: null # 把"距下一边界"编成 N 毫秒 → N 毫秒后重判
  stepClockMs: 0           # 每次重判把判定时钟再往前推，用来模拟跨档
```

> ⚠️ 打开它会强制触顶，从而**拒绝你自己的所有工具**（包括读文件和提问）。
> 这是硬停按设计生效，不是故障。排查时用 `test/drive.mjs` 更省事。

---

## 账本：公开契约

路径：`$DSH_HOME/dsh-cost-budget.json`（默认 `~/.dsh/dsh-cost-budget.json`）

以下为合成示例，不包含实际会话或消费数据：

```jsonc
{
  "version": 1,
  "currency": "CNY",
  "day": "2030-01-01",        // 北京时间日期，跨日归零的依据
  "spentUnits": 24,           // 当日累计，定点整数，1 元 = 10000 units
  "events": [
    {
      "at": 1893456000000,    // 事件时刻（epoch ms）
      "sessionId": "example-session",
      "provider": "deepseek-official",
      "model": "deepseek-flash",
      "units": 24,            // 本次成本，1 元 = 10000 units → ¥0.0024
      "basis": "deepseek-flash/valley/hit50000",  // 计价依据，可审计
      "tokens": { "miss": 1000, "hit": 50000, "write": 0, "out": 100 }
    }
  ],
  "updatedAt": "2030-01-01T00:00:00.000Z"
}
```

**契约承诺**：只增字段，不改语义；破坏性变更走 major 版本。外部消费者（比如余额挂件）
可以安全读取，但请只依赖上面这些字段。

金额一律用**定点整数**（`1 元 = 10000 units`），避免浮点累加误差。

### 并发

多会话、多进程同时记账由 DSH 自带原语保证：

- `withFileLock`（`@deepseek-ai/dsh-atomic-write`）—— `wx` 独占创建 `<path>.lock`，跨进程互斥
- `writeFileAtomic` —— 临时文件 + rename，读方永远看到完整文件

两个坑：必须在锁**内**重读账本；崩溃会留下孤儿 `.lock`，需要人工删除。

---

## 计价

以下是插件内置的**估价表**，单位 CNY / 百万 token，`[谷时, 峰时]`。它不会自动跟随服务商价格变化；使用前应核对实际服务商、模型、币种和价格，必要时更新 `lib/pricing.js`：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

峰时 = 工作日 09:00–12:00 与 14:00–18:00（北京时间）；周末自 2026-08-23 起全天谷价。

**别名**：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash`
都归到 `deepseek-flash`。`example-gateway` 为通用网关适配器示例，使用时应按实际服务的价格配置。

### Token 计数约定

**① DSH 的 token 计数是互斥的。** `inputTokens` 只含**未命中**部分，缓存单独上报：

```
成本 = 未命中×miss + 缓存读×hit + 缓存写×miss + 输出×out
```

把命中重复计入未命中（"包含式"写法）会高估成本。例如，按上表 flash 谷价计算的
**合成样例** `input 1000 / cacheRead 50000 / output 100`，正确金额为 ¥0.0024；
把缓存命中也计入未命中后会得到 ¥0.0524。

**② `reasoningTokens` 已包含在 `outputTokens` 内**，不得再加。

---

### 节假日与峰谷

峰谷时段**只适用于工作日**。以下两类日子全天按谷价：

- 周六、周日
- 中国法定节假日（含调休放假）

> ⚠️ **"调休上班的周末"也算谷价** —— DeepSeek 明确过"别人上班它放假"。
> 所以判定退化成一句"这天是不是休息日"，不需要区分调休方向。

光看星期几是错的：国庆、春节落在工作日时会被当成峰时，**成本高估近一倍**。
所以插件带一张日历，来源按优先级合并：

| 来源 | 说明 |
|---|---|
| 内置 2026 年表 | 兜底，不联网也能对 |
| `holidays` 配置 | 追加/覆盖 |
| `valleyDays` 配置 | **强制算工作日**，用来纠正线上表的误判 |
| `calendarUrl` | 线上日历，取回后落盘 `$DSH_HOME/dsh-cost-budget-holidays.json`，离线可用 |

线上日历用 [date.nager.at](https://date.nager.at) 这类公开接口即可（宽容解析 `date` 字段）：

```yaml
calendarUrl: https://date.nager.at/api/v3/PublicHolidays/2027/CN
```

拉取失败**不影响**已有日历（内置表始终兜着），只告警。

---

## 可视化配置

点进度条上的 **⚙** 打开配置面板，改完点「保存并生效」——**不需要重启**。

可改的内容：

| 分组 | 项 |
|---|---|
| 额度模式 | `total`（所有 API 合并）/ `group`（按组各算各的） |
| 阶梯额度 | 逐档增删改（几点为止 + 累计上限） |
| API 分组 | 组名与 provider 勾选项 |
| 各组倍率 | 每组填写阶梯上限的倍率，0.5 减半、2 加倍 |
| 峰谷 | 当前峰谷及依据只读展示，不能从面板修改计费规则 |
| 其他 | 试跑模式、恢复续跑的最低余量 |

**为什么不用重启**：`cordis.patch.yml` 的配置要重启才生效，所以另存了一份
**运行时覆盖层** `$DSH_HOME/dsh-cost-budget-config.json`。保存流程是：

```
界面 → PUT /dsh-cost-budget/config.json
     → 校验（非法直接 400，旧配置不受影响）
     → 按候选配置重算消费归属
     → 原子写覆盖层文件
     → 更新配置与分组 → 重建日历 → 重排恢复定时器 → 重新判定
     → 响应携带最新状态，界面立即重画
```

覆盖层只覆盖它显式写出的键，其余仍用 patch 里的值；且只接受**白名单键**
（`debug` 之类不会被界面误写）。校验失败会回滚——`test/config.mjs` 里有这条断言。

---

### 按组额度

默认 `quotaMode: total` —— 所有 provider 的花费合并撞同一条阶梯。

想分开管就切 `group` 模式，**每组各有一套阶梯、各算各的**：

```yaml
quotaMode: group
providerGroups:
  official: [deepseek-official]   # 组名 → provider 列表
  gateway: [example-gateway]
groupCapScale:                    # 每组对阶梯上限的倍率，默认 1.0
  gateway: 0.5                    # gateway 只有阶梯一半的额度
```

分组模式要求 `spendSource: estimated`。官方余额只代表一个账户，无法分摊到各个 provider；同时配置 `observed` 与 `group` 会被拒绝，在线保存失败时原配置保持有效。

**"按 provider"和"按组"是同一套配置的两种用法**，不需要两套实现：

| 想要的效果 | 怎么写 |
|---|---|
| 所有 provider 合并算一个额度 | `quotaMode: total` |
| 每个 provider 各自独立额度 | `quotaMode: group`，每个 provider 自己一组 |
| 某几个 provider 合并成一个额度 | `quotaMode: group`，它们写在同一组 |
| 某个 provider 不参与、自成一组 | 不写进 `providerGroups` 即可（未配置的 provider 自动自成一组） |

**判定语义**：硬停模式下任一组触顶即整体拦截，日志和状态会指明是哪一组触顶。
`groupCapScale` 乘在阶梯上限上：基准 ¥40、倍率 0.5 时该组额度为 ¥20，倍率 2 时为 ¥80。
消费金额保持原值，分组行展示真实消费 / 该组实际额度；`effSpentCny` 保留兼容字段，也返回真实消费。
试跑模式的 `allowed` 恒为 true，`budgetAllowed` 和各组 `allowed` 仍反映实际预算判定。

**账本**：顶层新增 `spentByGroup: {组名: units}`，每条事件新增 `group` 字段，
`spentUnits` 仍保留为总计（挂件/进度条照旧能读）。
**读旧账本时会从 `events` 现场补算 `spentByGroup`**，所以升级后分组计数不会从 0 起算。

---

## 可视进度条

插件会在 DSH Web 页面**右上角**挂一个进度条：

```
┌─────────────────────────────┐
│ ⋮⋮ 当前预算       ¥3.42/¥5.00│
│ ████████████████░░░░░░░░░░░░ │
│ 第 1/6 档           下档 10:00│◢
└─────────────────────────────┘
```

> 标题是**当前预算**而不是"今日预算"：`¥3.42 / ¥5.00` 里的 ¥5 是**当前档位**的上限，
> 跨过 10:00 后会变成 ¥10。鼠标悬停标题会说明是哪个档位、到几点为止、上限多少。

**交互**（位置与大小记在 localStorage，刷新后回到原处）：

| 操作 | 效果 |
|---|---|
| 拖动面板任意处（除标题） | 移动位置，越界自动拉回视口内 |
| 点击"当前预算" | 折叠 / 展开 |
| 拖右下角 `◢` | 缩放（宽 150–520，高 64–320） |
| 双击面板空白处 | 复位到默认位置和大小 |

**颜色**：< 80% 绿 → ≥ 80% 橙 → 触顶红（并显示"· 已停"，右侧变成"待到 xx:xx"）。
**试跑模式**（`dryRun: true`）标题后加"· 试跑"，一眼看出当前不会真拦。
触顶/恢复时临时改写 `document.title` 闪一下（不依赖浏览器通知权限）。

> 拖动用 `setPointerCapture` + 3px 抖动容差，所以点击折叠不会被误判成拖动。
> "当前预算"那四个字让给了折叠，按住它不会拖动面板——拖不动就按别处。

**实现方式**（与余额挂件同机制，无需构建工具）：

| 端点 | 作用 |
|---|---|
| `GET /dsh-cost-budget/state.json` | 当前状态（无缓存） |
| `GET /dsh-cost-budget/bar.js` | 客户端脚本 |
| `ctx.webServer.tapIndex(...)` | 往 index.html 注入 `<script defer>` |

脚本手写在 `lib/index.js` 的 `CLIENT_JS` 常量里，用 `String.raw` 包裹，所以客户端
脚本里**绝对不能用模板字符串**（`${...}` 会被服务端求值）。`test/bar.mjs` 会检查。

---

## 已知限制

**钩子返回值**

0. `agent/pre-step` 是 **waterfall** 钩子，它的终止函数返回 `{ kind:'enter', messages }`，
   而调用方紧接着读 `decision.kind`：

   ```js
   const decision = await this.dispatch.waterfall("agent/pre-step", {...},
     () => Promise.resolve({ kind: "enter", messages: ... }));
   if (decision.kind === "reject") return decision;   // ← undefined 时在这里抛
   ```

   所以 listener **放行时必须 `return next()`**。写成裸 `return`（即 undefined）
   会让 waterfall 结果为 undefined，触发
   `Cannot read properties of undefined (reading 'kind')`，**每个正常回合都崩**。
   别的 handler 看着像"提前返回"是因为它们最后都 `return decision`。
   `test/drive.mjs` 的阶段 2b/2c 专门钉住了这条。

**计价**

1. **余额观测和 token 估算是两种口径，不要直接相加或互相校准。** 以下 provider 名仅为配置示例，实际路由由宿主配置决定：

   | provider 示例 | 配置情形 | 计价口径 |
   |---|---|---|
   | `deepseek-official` | 直接使用官方 API 和对应账户 | **余额法**（该账户的余额变化） |
   | `example-gateway` | 使用独立计费的中转网关 | **token 法**（按配置价目表估算） |

   `state.json` 里 `balance` 展示余额观测，`providers` 与 `realSpentCny` 展示 token 估算；`spentCny` 是当前预算判定使用的消费口径。
   官方账单只能核对同一计费账户、同一时间范围内的请求；provider 名本身不能证明账单归属。

2. 网关若不上报缓存命中，估价会将这些输入按未命中价计算，可能高估成本。
   不要用另一个账户的官方账单反推网关命中率。只有具备独立证据时，才配置
   `assumedHitRatio`，并核对网关自己的计费规则。

3. **用量在调用后上报**，不会预留正在执行的请求费用。回报延迟、多个会话或进程的在途请求都可能造成超限，超出金额和回合数没有固定上限。token 估算还依赖服务商准确上报用量，未知模型使用 `deny` 会直接漏计该笔消费；它不是调用黑名单。

4. 累计值**可能变小**（DSH 明确说明 "totals need not be monotone"），
   所以增量允许为负；`onChanged` 不是单调信号。

### 余额观测（`balance`）

轮询官方余额接口，把**余额下降额**累计为观测消费；充值/赠金单独记为 credit，
**不冲掉已有消费**。余额属于整个计费账户，可能包含同一账户下其他客户端的使用。
同一采样间隔内同时发生充值和消费时，净余额变化可能掩盖部分消费；插件只能保证已观测到的下降量不被后续充值冲销。

随附配置默认 `enabled: true`、`poll: true`，每 60 秒尝试从
`$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）读取
`DEEPSEEK_API_KEY`，并向 `https://api.deepseek.com/user/balance` 发起认证请求。
即使 `dryRun: true`，余额轮询仍会运行。凭证缺失时不会成功请求余额。

在 `cordis.patch.yml` 的 `config:` 下配置，修改后重启宿主：

```yaml
balance:
  enabled: true
  poll: true
  url: https://api.deepseek.com/user/balance
  keyRef: DEEPSEEK_API_KEY     # 从 ~/.dsh/.credentials.yaml 按名读取
  pollMs: 60000
  maxAgeMs: 180000           # 可用余额样本的最大年龄
  scope: deepseek
```

完全关闭余额功能：

```yaml
balance:
  enabled: false
```

保留读取已有余额观测账本，但不读取凭证或轮询接口：

```yaml
balance:
  enabled: true
  poll: false
```

**API key 只从 `.credentials.yaml` 读进内存，绝不写进配置文件、绝不落日志。**

核心不变量（由 `test/balance.mjs` 验证）：

1. 余额**下降** → 累加为消费
2. 余额**上升**（充值/赠金）→ 单独记 credit，**绝不冲掉已有消费**
3. 当天**首次观测是统计起点**，不把此前余额算成今天消费
4. 重复/乱序样本丢弃（否则消费会算反）
5. 金额用定点整数（1 CNY = 1e8 units），无浮点漂移

**适用范围**：余额法只覆盖该接口返回的计费账户。独立计费的网关消费不包含在其中，
需使用对应网关的数据或 token 估算。

### 余额作为预算判据

默认 `spendSource: estimated`：按当天 token 账本累计消费判定，余额观测只供核对。
若所有受控调用都属于余额接口对应的同一账户，可以在 patch 中选择：

```yaml
quotaMode: total
spendSource: observed
balance:
  enabled: true
  poll: true
  pollMs: 60000
  maxAgeMs: 180000
```

`observed` 取当前档位起点至最近余额样本之间的下降额之和，与该档 `cap` 比较。
例如 `10:00–11:00` 档 `cap: 10` 表示该窗口观测消费最多 ¥10；到 11:00 后从新档位起点重新计算。
这与 `estimated` 的当日累计口径不同。窗口内充值和赠金只记为 credit，不抵销之前的消费。
余额下降也可能来自同一账户的其他客户端；余额接口不能分摊 provider，所以 `observed` 只支持 `total`。

余额功能被禁用、窗口起点无有效锚点、最新样本过期、账户 scope 不匹配或币种不是 CNY 时，
预算判断回退到**当天 token 估算**。默认 `maxAgeMs` 为 `max(3 × pollMs, 180000)`，最小允许 15000 毫秒。
回退和余额恢复时消费口径会切换，额度仍按当前档位配置判断；停机和自动恢复都使用同一有效口径。
余额模式还受轮询与服务商余额更新延迟影响，不能保证精确封顶。

`state.json` 的 `spendSource` 对象给出 `requested`（配置选择）、`effective`（实际采用的
`estimated` / `observed` / `debug`）、`fallback`（回退原因）、`window`（`day` / `tier` / `debug`）
及 `startAt`、`endAt`、`lastObservedAt`、`maxAgeMs`。调用方应按 `effective` 和 `window`
解释 `spentCny`，不能仅凭配置推断消费来自余额。
回退原因包括 `disabled`、`no-samples`、`context-mismatch`、`invalid-samples`、
`stale-samples`、`no-anchor`、`stale-anchor`；未回退时 `fallback` 为空。

**Windows 权限说明**：代码里写了 `mode: 0o600` 并显式 `chmodSync`，但
这不能替代 Windows 的 ACL 访问控制。Windows 用户应按自己的账户与权限需求设置
`DSH_HOME` 的 ACL，不应依赖 POSIX mode 来隔离账目。

### 与账单核对

对账前先确认计费账户、provider 路由、时区和时间范围一致，再比较请求数、token 分桶
和金额。账单与本地账本的采样范围可能不同；缺失请求、其他客户端及服务端计费规则
都会造成差异，不能仅凭某一个 token 分桶推断计价正确或错误。

账本按 `(sessionId, at)` 在**写入和读取路径**上去重，避免实时订阅与启动回填
重复计费，并从去重后的事件重新派生
`spentUnits`/`spentByGroup`。**存量账本自动自愈**，不需要手动跑修复脚本。

`test/calibrate.mjs` 用于本地账单核对。真实账单、账本与对账输出应保留在仓库外，
不要作为测试夹具或发布附件提交。

**通知**

4. **小鲸鱼通知未实现。** `notify.whale` 是保留配置项，默认 `false`，启用它不会推送气池提示。
5. **桌面通知未实现。** `notify.browser` 是保留配置项，默认 `false`，启用它不会请求浏览器通知权限或发送通知。进度条只在页面开着时可见；页面关掉后没有桌面提醒。
   当前触顶的感知渠道是：进度条、运行日志、账本、以及模型可见的拒绝理由。
6. **界面已通过隔离页面的真实浏览器验证。** `test/preview.mjs` 使用实际插件路由和客户端脚本，
   以合成数据验证默认按钮与面板可见、预算触顶与恢复、分组/provider/倍率保存、刷新后配置保留，
   以及拖动、缩放、折叠和刷新后的布局状态，截图检查正常；模拟 DOM 回归另外覆盖竞态和边界钳制。
   此验证未读取真实凭证或消费，不等于真实 DSH 页面外壳下的完整端到端测试。
   客户端 CSS 在 `lib/index.js` 的 `CLIENT_JS.style()` 中。

**其他**

7. 插件**不加载历史消费**：只回填**当日**事件（历史消费不属于"当天预算"）。
8. 暴露了只读服务 `costBudget`，`ctx.get('costBudget').snapshot()` 可查当前状态。

---

## 分组配置与显示

分组配置的保存与显示行为：

| 原问题 | 当前行为 |
|---|---|
| 改了分组配置，面板看不出变化 | group 模式即使只有一组也显示组名；保存后显示“已生效”及组名、provider、倍率摘要 |
| 保存配置后要等一段时间 | 服务端在保存返回前按新配置重算消费归属，响应直接携带最新状态，前端立即重画 |
| 空的 default 行造成混淆 | group 模式仅显示配置声明的组和实际有消费的组；空 default 隐藏，用户明确配置的 default 保留 |
| 删光组后仍残留旧组 | 保存后旧组立即消失；保持 group 时，未配置的 provider 各自独立计额；切 total 时，default 立即汇总全部消费 |

**default 的含义**：total 模式下它代表全部消费；group 模式下只有 provider 名为空时才自动落入 default。删除具名分组不会删除消费记录，也不会让对应 provider 失去预算约束。

**保存一致性**：校验配置 → 用候选配置重读账本并重算归属 → 原子保存覆盖层 → 一起更新生效配置与内存 → 重判额度 → 返回最新 state。配置保存、记账和对账串行执行，防止旧读写结果覆盖新分组。读取或保存失败时返回错误，保留原生效配置。账本暂时写入失败的消费会在本次进程的内存中保留，改组和对账时也参与计算；同一事件落盘后不会重复计费。

**界面反馈**：保存期间禁止重复提交；保存前发出的旧轮询不能覆盖新状态；保存失败与“已保存但状态刷新失败”分别提示。没有配置分组也没有消费时显示提示，不画空额度行。已缩小的面板会临时增高以显示分组，长列表内部滚动，切回总额模式恢复原高度偏好；省略的组名和倍率可悬停查看。普通消费仍每 3 秒轮询，保存配置无需等下一个轮询周期。

**回归验证**：分组测试覆盖单组、删组、total/group 切换、无名 provider、保存失败、并发保存/记账、同总额归属修正及未落盘消费保留；客户端测试覆盖立即渲染、旧轮询竞态和保存反馈。真实浏览器已在隔离的合成数据预览页中验证配置加载、分组/provider/0.5 倍率保存、预算触顶与恢复、刷新持久化及拖动/缩放/折叠，并完成截图检查；真实 DSH 页面外壳下的完整端到端测试尚未覆盖。

### 边界情况

实现及回归测试覆盖以下边界：

- 特殊组名或 provider（如 constructor、toString、__proto__）不再与对象原型冲突，金额和配置可完整保留。
- 配置编辑器对名称与 provider 正确转义，字符实体不再改变原值，标记字符也不会被当作 HTML 渲染。
- 配置读取采用请求序号；较早的读取不能覆盖较新的读取，也不能在保存后还原旧表单或覆盖成功反馈。
- 分组撑高浮窗后重新检查视口边界，原先贴近屏幕底部的位置会自动上移，缩放高度偏好仍保留。
- 阶梯时间只接受 24:00 作为午夜边界，拒绝 24:01、24:59 等超过一天的值；拒绝时保留原配置。
- 同一事件在写入返回前就去重，重启回填不再先把消费算两遍、短暂误触发暂停，再等下一次读取纠正。
- 恢复时账本暂不可读会保留已有消费和暂停状态，15 秒后重试；插件卸载后停止重试和恢复动作。

测试夹具使用固定同日余额样本和全天阶梯，避免测试结果依赖运行时刻。

### 预算控制与升级说明

- `groupCapScale` 已统一为上限倍率，0.5 减半、2 加倍，消费不乘倍率。旧版实际用消费乘倍率；如曾按旧行为配置非 1 倍率，升级后需按实际想要的额度检查配置。
- `dryRun` 只观察预算：不拦工具或模型，不暂停或恢复 goal，不安排预算恢复定时器。快照 `allowed=true`、`exhausted=false`，另用 `budgetAllowed` 保留真实预算判断。切入试跑会取消已有恢复定时器；此前已暂停的任务保持暂停，可手动恢复，或切回硬停后由插件按余量检查。
- 账本保留完整当日事件，不再截断为 2000 条；重读、重分组、去重都使用完整记录，跨日清空。旧版已经删除的事件无法从残余账本还原，只有仍完整的原始会话历史可用于重新回填。
- harness 的 `goals.resume()` 会激活 goal 驱动并调度续跑。因此余量不足时保持 paused，到下一档再检查；所有组的余量均达到各自额度的 `resumeMinHeadroomPct` 后才恢复。设为 0 仍须预算未触顶。插件只调用 resume，不再额外发送 followup。
- 自动恢复只处理本次插件运行中由它暂停、且 goal id / revision 未被修改的任务。手动暂停、编辑过的任务，以及原本未激活的旧 goal 不会被误恢复；插件重启后不会猜测旧暂停的归属。配置提高额度后也会立即检查是否可以恢复，临时恢复失败 15 秒后重试。

恢复回归还覆盖跨日时其他进程已经记入消费、恰好达到余量门槛、agent 枚举暂时失败。宿主 goal 轮数耗尽时保持暂停并停止无效重试，需要用户调整轮数后手动恢复。

---

## 开发

在全新目录安装依赖后，可直接运行 14 个离线测试套件，无需安装 harness：

```powershell
# 在插件仓库根目录运行。
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

直接依赖固定为 `@deepseek-ai/dsh-atomic-write` 和 `@deepseek-ai/dsh-home-paths` 的 `0.1.5-rc.2`，
测试需要的 `js-yaml` 已声明为开发依赖；提交的 `pnpm-lock.yaml` 固定完整依赖树。
已在全新临时目录完成 frozen-lockfile 安装、模块导入及 14 套离线测试，未借用本机 harness 的依赖。

如需额外验证真实宿主 goal 驱动，可显式借用本机 harness，共运行 15 套：

```powershell
# 先将 DSH_TEST_HARNESS_ROOT 环境变量设为本机 harness 的安装目录。
node test/run.mjs --harness-root $env:DSH_TEST_HARNESS_ROOT
```

入口为每个套件隔离 DSH_HOME、用户目录和临时目录，禁止真实网络请求；不会读取真实凭证或改动 harness 的安装和配置。--harness-root 只借用宿主的已安装依赖；省略时使用插件本地依赖，缺少依赖会明确失败。privacy 套件用合成凭证、模拟响应和虚构账单验证诊断输出，包含 calibrate 的默认合成测试，不执行真实接口探测或读取用户账单。

`.github/workflows/ci.yml` 配置 Windows / Ubuntu、Node.js 22.15.0 / 24 的安装、导入、离线测试和发布文件检查。上传 GitHub 后由 Actions 执行；本地验证不等于这些平台的远端 CI 已通过。

余额口径测试固定北京时间及样本锚点，不再依赖测试运行时刻。单独运行某个测试前也应隔离 DSH_HOME；以下命令假定依赖已正确安装：

```powershell
node test/calendar.mjs      # 峰谷：法定节假日按谷价、valleyDays 覆盖、线上格式解析
node test/groups.mjs        # 按组额度：total/group 隔离、scale 打折、旧账本迁移
node test/grouping.mjs      # 分组归属：各组之和 = 总额、旧组名不得变幽灵组
node test/config.mjs        # 配置接口：保存、热重载、白名单、非法值拒绝与回滚
node test/dryrun.mjs        # 试跑：dryRun 下判定照算但不拦截
node test/drive.mjs         # 进程外驱动 apply()：刹车 → goal 暂停 → 边界恢复 → 进度条
node test/bar.mjs           # 模拟 DOM：拖动/缩放/折叠/钳制/持久化/配置面板/分组条
node test/panelcontract.mjs # 面板契约：config.json / state.json 的响应形状
node test/balance.mjs       # 余额观测：采样、去重、窗口增量、充值钳制
node test/spendsource.mjs   # 判据数据源：token 估算 vs 余额观测的接线
node test/recovery.mjs      # 恢复时读盘失败重试、卸载时停止恢复任务
node test/ledger.mjs        # 超过 2000 条的完整消费、重读、重分组、去重与跨日
node test/goalcontrol.mjs   # 试跑副作用、最低余量、暂停归属与宿主自动续跑
node test/hostdriver.mjs    # 真实宿主 round driver：低余量不续跑、恢复仅一条消息
node test/privacy.mjs       # 合成凭证/账单与模拟接口：敏感信息不进入诊断输出
node test/calibrate.mjs     # 默认仅运行合成数据测试
node --check lib/index.js
```

**两个套件专门盯"服务端逻辑对、但界面/接口层错"这类问题**，因为这类错
不报异常、只是静默显示成空的或旧的，最容易漏：

- `test/grouping.mjs` —— 曾经三处 `currentSpend()` 漏传 `groupOf`，
  于是启动时全部金额落到 `default`，各组恒为 ¥0，且取最大值合并后再也清不掉。
- `test/panelcontract.mjs` —— 曾经 `renderPeakNow` 写在服务端作用域
  （客户端调不到）、`availableProviders` 写在 `snapshot()` 内部
  （`effectiveForUi` 够不着）、`loadConfig` 读错层级（`j.peakNow` vs `e.peakNow`）。
  三者都不抛错，表现只是面板半截是空的或显示 `--`。

修界面相关的问题时，**同时改夹具**：`test/bar.mjs` 的 `cfgResp` 必须与
`config.json` 的**真实响应形状**一致。曾经夹具把 `peakNow` 放在顶层，
于是 `loadConfig` 里写错的 `j.peakNow` 也"测过"了。

设 `DSH_HOME` 到临时目录可避免测试污染真实账本。

### 浏览器预览

```powershell
node test/preview.mjs
# 也可显式借用宿主依赖：
node test/preview.mjs --harness-root $env:DSH_TEST_HARNESS_ROOT
```

打开终端输出的本机预览地址，可以检查真实客户端脚本与路由的显示和交互。
预览使用隔离临时目录和合成消费数据，默认试跑、禁用余额功能和外部 fetch，
修改设置不会触及真实 DSH 配置或账本。在终端输入 `quit` 并回车，正常退出并清理预览数据；
强制结束进程可能留下只含合成数据的临时目录。

### 手工诊断

`node test/probe-balance.mjs` 默认只显示用法。显式添加 `--live` 才读取
`DEEPSEEK_API_KEY` 环境变量或 DSH 凭证文件并请求官方余额接口；只输出可用性、
HTTP 状态或固定错误分类，不输出密钥片段、响应正文、余额或错误正文。

`node test/calibrate.mjs` 默认只运行合成数据测试。手工核对账单时必须同时提供
`--ledger <账本文件>`、`--amount <CSV文件>`、`--day <YYYY-MM-DD>`、
`--provider <provider名称>`，脚本不会自动寻找用户文件。CSV 第七列是指标名称，
第九列是数量，输入应来自相同计费账户与时间范围。输出仅包含 PASS/FAIL 和比较分类，
不输出实际金额、用量、日期、provider 名称或文件路径。

### 发布文件

插件的 HTTP 接口没有额外鉴权层，沿用 DSH 宿主的访问控制；状态响应包含消费、provider 和本地账本路径，
配置接口可修改预算。部署时应限制宿主访问范围，不要将这些接口直接暴露到公网，也不要把真实响应作为公开 issue 附件。

公开仓库保留 `lib/` 源码、`test/` 测试与预览、`scripts/verify-package.mjs`、
`.github/workflows/ci.yml`、README、LICENSE、配置示例、package.json、pnpm-lock.yaml 和
`.gitignore`、`.gitattributes`。文档与测试样例均为合成数据，provider 示例名称需按实际配置替换。
`.gitignore` 排除依赖目录、凭证、本地配置、运行时账本、账单导出、日志和临时文件；
真实运行数据保留在仓库外。手动打包或通过网页上传时也应遵守这一文件范围。
`package.json` 的 `files` 仅约束 npm 包，不替代 Git 忽略规则。

可检查 npm 发布文件清单，整个过程不上传包：

```powershell
$packReport = Join-Path $env:TEMP 'dsh-budget-package.json'
pnpm pack --dry-run --json | Set-Content -LiteralPath $packReport -Encoding utf8
node scripts/verify-package.mjs $packReport
```

当前包已验证仅含 10 个源码、配置示例、文档、许可证及 package.json 文件；
检查脚本拒绝白名单外的文件，测试与 CI 配置保留在 GitHub 仓库中，不进入安装包。

### 许可证

本项目按 [MIT License](./LICENSE) 发布，署名为 `dsh-cost-budget contributors`。
许可证正文采用 [Open Source Initiative 的 MIT 标准条款](https://opensource.org/license/mit)。

模块分工：

| 文件 | 职责 |
|---|---|
| `lib/pricing.js` | 单价表、别名解析、峰谷判定、单次调用折价 |
| `lib/ladder.js` | 阶梯累积包络判定、下一个边界计算 |
| `lib/ledger.js` | 全局账本（跨进程锁 + 原子写），格式即公开契约 |
| `lib/index.js` | 接线：订阅用量、累计、刹车、恢复、goal 联动 |
