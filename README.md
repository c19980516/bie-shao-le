# 别烧了（bie-shao-le）

DeepSeek Harness 预算插件：额度到了就歇会儿，别烧了。

按北京时间设置阶梯预算，查看消费进度；触顶后拦截后续模型和工具调用、暂停任务，额度与余量满足条件时自动续跑。支持所有 provider 共用额度，也支持按组分别计额。

> 当前为实验版。默认开启试跑，**只记账，不拦截**；核对消费后，在配置面板关闭试跑即可启用预算限制。

## 安装

需要已安装 DSH、Node.js **22.15–22.x 或 24.x**、pnpm **11.19.0**。宿主适配验证使用 DSH CLI `0.1.5-rc.1` 及其 `0.1.5-rc.2` 核心包。

在 PowerShell 中运行：

```powershell
git clone https://github.com/c19980516/bie-shao-le.git
cd bie-shao-le
pnpm install --frozen-lockfile --ignore-scripts
$pluginPath = (Get-Location).Path
dsh plugin --profile web add "link:$pluginPath"
```

然后在外部终端重启 `dsh web`。插件安装标识为 `dsh-cost-budget`。

## 使用

页面右上角的预算条显示当前消费与额度，点击 **⚙** 打开配置面板：

- 设置阶梯的截止时间和上限。
- 选择合并计额（`total`）或分组计额（`group`）；任一组触顶都会暂停任务。
- 分组倍率作用于额度：`0.5` 为一半，`2` 为两倍；未分组的 provider 各自独立计额。
- 关闭“试跑模式”启用拦截，设置恢复所需的最低余量（默认 15%）。

点击“保存并生效”即可应用。预算条支持拖动、右下角缩放、点击标题折叠。

### 阶梯怎么算

默认按**当日累计消费**计额，币种为人民币、时区为北京时间。例如：

```yaml
ladder:
  - { until: "10:00", cap: 5 }
  - { until: "12:00", cap: 15 }
  - { until: "24:00", cap: 40 }
```

表示 10 点前累计上限 ¥5，10–12 点累计上限 ¥15，12 点后累计上限 ¥40；不是每档额外发放一笔额度。次日 00:00 重新计额。

更多配置见 [cordis.patch.yml](./cordis.patch.yml) 的 `config` 部分。直接修改文件后需要重启；面板保存的设置优先于文件配置。

## 计费与余额

默认使用 token 用量和[内置价格表](./lib/pricing.js)估算消费，价格不会自动更新。未知模型默认按 flash 价格兜底，实际费用可能有偏差。

随附配置还会每 60 秒尝试读取 DSH 凭证并查询官方账户余额。试跑不会关闭这项查询；不需要时，在配置的 `balance` 下关闭：

```yaml
balance:
  enabled: false
```

可选 `spendSource: observed` 以**当前档位内的账户余额下降累计**计额，仅支持 `total`。样本缺失、过期或范围不匹配时回退到当日 token 估算，预算条会显示当前口径和回退原因。共享账户的其他消费也会计入，同一采样间隔内的充值可能掩盖消费。

## 使用边界

- 在途请求、并发和用量上报延迟仍可能产生费用，不能保证账单绝对不超额。
- 自动恢复只处理本次运行中由插件暂停、且未被手动修改的任务；重启后可能需要手动恢复。
- 暂无桌面通知。状态和配置接口依赖 DSH 宿主的访问控制，不要直接暴露到公网。
- 真实凭证、账本、日志和接口响应不要提交到仓库或公开 issue。

## 开发

```powershell
pnpm test              # 隔离环境下的离线回归测试
node test/preview.mjs   # 使用合成数据预览界面，输入 quit 退出
```

GitHub Actions 检查 Windows / Ubuntu、Node.js 22.15 / 24 的安装、测试和打包内容。

## 许可证

[MIT](./LICENSE)
