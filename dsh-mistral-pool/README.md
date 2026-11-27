# dsh-mistral-pool

Mistral Vibe 自包含 DSH 一级供应商与多 Key 池插件：安装即自动注册 `Mistral Vibe`（`mistral-vibe`）渠道与模型目录，内置 **ACP（官方 `vibe-acp`）** 与 **直连（HTTP API）** 双路由一键切换及自适应密钥/代理绑定，**无需在「设置 → 模型」手填 API 密钥或代理地址，也无需手改 `cordis.patch.yml`**。

## 为什么需要双模式

从 **2026-12-01** 起，非 Mistral 官方产品直连 `api.mistral.ai` 时，即使使用 Vibe key 也会统一扣减每月 \$30 的普通 API 额度；只有通过 Mistral 官方产品（包括 `vibe-acp`）的调用继续扣减 \$300 Vibe 额度。

| 模式 | 路由路径 | Key 池选择 | 适用场景 |
| --- | --- | --- | --- |
| **ACP (`vibe-acp`)** | `mistral-vibe` → `MistralAdapter` → `vibe-acp` 子进程 + loopback MCP 桥 | 仅使用 `$300` Vibe Key（`kind === 'vibe'` 或 `faceUsd >= 100`），避免误耗 `$30` Studio 池 | 常规主力使用，消耗每号 \$300 Vibe 额度 |
| **直连 (`HTTP API`)** | `mistral-vibe` → `MistralAdapter` → `127.0.0.1:28401/v1` → `api.mistral.ai` | `directKeyScope: 'auto'` 下 12/1 起优先仅使用 `$30` Studio Key（不误标同号 `$300` Vibe Key 耗尽） | 需要原生 `openai-responses` 流或使用 `$30` API 额度 |

管理入口：
- **DSH 设置 → 模型 → Mistral Vibe**：仅保留极简单行卡片（与 `Cursor` / `CodeBuddy` / `Antigravity` / `Devin` 一致），不在模型页内嵌 Key 池或模型目录表单；所有 Key 池、路由模式与 9 款默认主流模型目录（`zai-glm-5-3`、`zai-glm-5-3-flash`、`deepseek-v4-1-flash-1017`、`mistral-large-4`、`mistral-medium-latest`、`mistral-small-latest`、`devstral-latest`、`codestral-latest`、`magistral-medium-latest`，其余官方/实验型号按前缀自动补全参数）统一在独立插件面板 **DSH 设置 → Mistral Key 池** 管理。
- **DSH 设置 → Mistral Key 池**：顶部「调用路由」分段按钮实时切换 `ACP (vibe-acp)` / `直连 (HTTP API)`，立即持久化到 `~/.dsh/mistral-pool.json` 并在下一条请求生效；切回直连时自动回收空闲 `vibe-acp` 子进程。右上角「+ 新增 Key」按钮支持直接在界面中手动添加 Key（自动分配 ID、区分 `$300` Vibe / `$30` Studio 或自定义面值，并支持设置整数 `priority` 优先级与正数 `weight` 权重）；各面值组标题栏提供「刷新」按钮同步该组额度与状态；每条 Key 展示「已启用 / 已停用 / 额度耗尽」状态及可点击调整的 `优先级 · 权重`，行内提供「编辑」（可修改账号、备注、优先级、权重、额度档位及按需替换 Key）、「启用 / 停用」、「删除（二次确认）」聚合管理操作；页面底部同步提供「模型目录」管理。
- **路由调度规则**：优先从同池内最高 `priority`（默认 `0`，数值越大越优先）的可用 Key 中选择，并在同优先级内按 `weight`（默认 `1`）比例分配新会话；高优先级全部耗尽或停用后自动降级到下一优先级。
- **兜底看板**：<http://127.0.0.1:28401/> 同步提供模式切换、「+ 新增 Key」、「编辑」、「启用 / 停用」与「删除」按钮。

## 安装与前置条件

### 1. 前置条件

- **直连模式（HTTP API / `$30` Studio 池）**：零外部依赖，安装插件后在 **DSH 设置 → Mistral Key 池** 添加 Key 即可使用。
- **ACP 模式（`vibe-acp` / `$300` Vibe 池）**：需在本机安装 Mistral 官方 CLI：

```sh
uv tool install mistral-vibe
```

### 2. 从 GitHub 插件仓库安装（推荐）

```sh
dsh plugin --profile web add "git+https://github.com/lili-luo/dsh-plugin-bundle.git#main&path:/dsh-mistral-pool"
```

### 3. 从本地目录安装

```sh
dsh plugin --profile web add ./dsh-mistral-pool
```

重启 DSH Web 后，即可在模型选择器中直接使用 **Mistral Vibe** 分组（插件通过自带的 `./cordis.patch.yml` 自动挂载，无需手工修改 `llm-pi-ai` 或填写 API 密钥/地址）。

## 内置默认主流模型

插件内置 9 款常用主流模型并预配完整上下文窗口、最大输出、多模态与思考档位；其余官方或实验型号（如 `mistral-vibe-cli-latest`、`mistral-large-2512`、`labs-devstral-small-2512`、`labs-leanstral-1-5-1`、`pixtral-*`、`ministral-*`、`open-mixtral-*` 等）在 **+ 添加模型** 或 **获取可用模型** 时自动按前缀匹配补全：

| 模型 ID | 显示名称 | 上下文窗口 | 最大输出 | 输入类型 | 思考档位 |
| --- | --- | --- | --- | --- | --- |
| `zai-glm-5-3` | GLM 5.3 (Mistral Hosted) | `1M` | `128K` | 仅文本 | `low–max` |
| `zai-glm-5-3-flash` | GLM 5.3 Flash (Z.ai) | `1M` | `128K` | 文本 / 图片 | `low–max` |
| `deepseek-v4-1-flash-1017` | DeepSeek V4.1 Flash 1017 | `1M` | `128K` | 文本 / 图片 | `off–max` |
| `mistral-large-4` | Mistral Large 4 | `1M` | `256K` | 文本 / 图片 | `low–high` |
| `mistral-medium-latest` | Mistral Medium 3.5 | `256K` | `256K` | 文本 / 图片 | `off–high` |
| `mistral-small-latest` | Mistral Small 4 | `256K` | `250K` | 文本 / 图片 | `off–high` |
| `devstral-latest` | Devstral 2 | `262K` | `262K` | 仅文本 | — |
| `codestral-latest` | Codestral | `256K` | `8K` | 仅文本 | — |
| `magistral-medium-latest` | Magistral Medium | `262K` | `16K` | 文本 / 图片 | `off–high` |

## ACP 运行时机制（`lib/acp-runtime.js` + `lib/mcp-bridge.js`）

- **自包含一级供应商**：安装后自动通过 `MistralAdapter` 注册 `mistral-vibe` 渠道（同时保留 `ctx.on('llm/stream')` 对旧 `mistral` 渠道的兼容拦截）。
- **每会话隔离 `VIBE_HOME`**：`runners/<tag>/vibe_home` 内写入独立 `config.toml`、`dsh-bridge` Agent 与精简 `<dsh_context>` 提示词，启用 `bypass_tool_permissions = true` 与 `enabled_tools = ["<serverName>_*"]`（禁用 Vibe 内置 `read_file`/`write_file`/`edit`/`bash`/`skill`，所有工具调用经 `run_typescript` 转发到 `McpBridge` 回环 Streamable-HTTP 端点）。
- **长耗时工具中继**：`run_typescript` 单次超时为 60s；当 DSH 工具（人工审批或长子代理）等待超过 `45s` 时返回 `[DSH_RELAY]` 指引，模型立即调用 `dsh_await_result` 继续等待同一 DSH 调用。
- **生命周期与内存回收**：启动零进程；主会话空闲 8 分钟（480s）、子代理空闲 45 秒、无 `sessionId` 辅助调用 0 秒即收；低内存（`< 1.5 GiB`）收紧至 60s；接入全局 `dsh.acp.residentCoordinator.v1`（软上限 8）；`live-pids.json` 记录子进程并在启动时回收 `PPID=1` 残留 `vibe-acp`。
- **透明故障轮换**：若模型输出前收到 `401/402/403` 或配额错误，自动将该 Vibe Key 标为 `exhausted` 并用下一把重放当前提示。

## 代理与计价特性

- **会话粘滞**：优先读取 `x-dsh-session` / `x-session-id` / `x-conversation-id` / `x-affinity`，并按模式（`acp:` / `direct:`）隔离亲和表，保证模式切换不串桶。
- **按模型记账与折算**：直连 SSE/JSON 与 ACP `usage_update` / `PromptResponse.usage` 均按增量折算为分模型 USD 花费；费率取自 `.dsh-usage-stats.json` 并按 `6.79` RMB/USD 折算。
- **官方余额探测**：后台定期查询 `/v1/billing/subscription` 与 `/v1/billing/usage`（在当前只返回套餐名的部署中自动退化为本地估算）。

## 配置 (`~/.dsh/mistral-pool.json`)

```jsonc
{
  "mode": "acp",                     // "acp" | "direct"
  "directKeyScope": "auto",          // "auto" (12/1起仅Studio) | "studio" | "all"
  "port": 28401,
  "upstream": "https://api.mistral.ai",
  "currentId": "key-03",
  "keys": [
    {
      "id": "key-03",
      "kind": "vibe",                // 可选："vibe" | "studio"（省略时 faceUsd >= 100 判为 vibe）
      "account": "someone@gmail.com",
      "memo": "Pro",
      "key": "mstrl_…",
      "faceUsd": 300,
      "usedUsd": 0,
      "tokens": { "input": 0, "output": 0, "cached": 0 },
      "requests": 0,
      "status": "active"             // active | exhausted | disabled
    }
  ]
}
```

## 测试

```bash
npm test
```
