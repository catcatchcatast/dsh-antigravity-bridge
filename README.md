# Antigravity bridge for DeepSeek Harness

通过官方 Antigravity CLI 的 ACP 接口，把本机可用的模型接入 DeepSeek Harness (DSH)。默认 bridge 模式由 DSH 声明工具、执行工具并处理审批。插件使用当前会话提供的工作区、工具和规则；模型目录来自 CLI，显示名称和隐藏规则由每个安装实例单独配置。

## 安装

需要兼容的 DSH 0.2.x 宿主、Node.js 22.19 或更高版本，以及已通过官方流程登录的 agy CLI（1.5.0 或更高版本）。在运行 DSH 的操作系统账号下确认 `agy --version` 可用。包内已包含编译好的 `lib/`。

在 DSH 的插件安装入口使用本仓库的 Git 地址：

```text
git+https://github.com/catcatchcatast/dsh-antigravity-bridge.git
```

使用 DSH CLI 时，将 `PROFILE_NAME` 替换为实际运行的配置名，例如桌面端通常是 `desktop`，Web 服务通常是 `web`。

```sh
dsh plugin --profile PROFILE_NAME add "git+https://github.com/catcatchcatast/dsh-antigravity-bridge.git"
```

也可在本仓库根目录运行 `npm pack`，把生成的 tgz 安装到目标 DSH 配置。在插件管理中确认已启用，然后从模型选择器的 Antigravity 分组选择模型。

## 配置与会话

- 默认查找本机安装的 agy。可通过插件的 `command` 指定可执行文件，通过 `home` 指定插件数据目录。
- 首次安装默认使用当前操作系统账号的官方 CLI 登录状态。模型可用性和额度取决于该账号。
- `hiddenModels` 默认为空。按需隐藏名称或模型 ID；支持通配符，新模型只要与隐藏规则不匹配便可显示。
- 默认使用 CLI 的标准上下文配置。启动时仅在显式配置 `patchScript` 后运行可选检查，`autoPatch` 默认关闭。
- 默认 bridge 在新建和恢复会话时省略 `systemPrompt`。agy 按专用代理的工具范围生成官方系统提示，其内容可以与默认 CLI 会话不同。DSH 的工作区规则随用户上下文传入。
- agy 在流中报告明确的认证、权限、服务条款或 429 错误时，bridge 取消当前请求并返回上游错误。只有明确的额度耗尽才会暂停对应模型组。
- bridge 等待模型连续 3 分钟没有进展时，取消当前请求。收到取消回执后，在同一 agy 会话最多自动续接 5 次（初始请求另计）。等 DSH 工具或用户审批时暂停计时。续接不会重放此前的工具调用。模型可按需再次查询任务输出、任务或代理列表、文件和搜索结果。其他已完成的工具若被再次以相同参数请求，插件会暂停并请用户确认。
- 会话续接和长历史交接使用 DSH 提供的会话消息及已有摘要。工具权限与审批由实际使用的 DSH 会话决定。

关于专用代理、长会话和错误处理的取舍，见[桥接差异与验证](docs/bridge-comparison.zh.md)。

## 开发

`src/` 存放源码，`lib/` 是供宿主直接加载的产物，`tests/` 包含使用模拟 ACP 进程的回归测试。源码开发需要兼容的 DSH SDK 和 TypeScript。设置 `DSH_CHECKOUT` 为已安装依赖并构建的 DSH 源码目录，再运行 `npm run build` 与 `npm test`。直接安装预编译插件无需设置此变量。

## 来源与许可

基于 lili-luo 的 dsh-llm-antigravity-acp，保留原作者 MIT 许可。本仓库提供独立分发的桥接适配。[上游源码](https://github.com/lili-luo/dsh-plugin-bundle/tree/main/dsh-llm-antigravity-acp) · [MIT 许可证](LICENSE)

## 已验证范围

在 Windows 上用 DSH 0.2.1-rc.5 CLI 将压缩包安装到新命名的空配置，使用宿主 SDK 加载插件并核对默认设置。使用模拟 ACP 进程运行的 282 项回归中有 278 项通过。4 项在发布前的基线上也能复现：一项涉及跨工具步骤的重答预算，两项涉及系统提示及工具契约文本断言，一项需要 Windows 测试进程具备创建符号链接的权限。
