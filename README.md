# dsh-plugin-bundle

基于 DeepSeek Harness（DSH）的插件组合包。每个目录可以用 `path:` 单独安装。

本仓库和 LINUX DO 上的介绍帖已经公开。Google 会用提示词做检测，插件这边已经用提示词处理做了缓解。封号已经出现。请谨慎使用：目前付费套餐暂时还没有封号，活动、赠送一类套餐封号比较集中。细节见 [dsh-llm-antigravity-acp](./dsh-llm-antigravity-acp)。

| 目录 | 内容 |
|---|---|
| [`dsh-llm-antigravity-acp`](./dsh-llm-antigravity-acp) | 用本机官方 `agy acp` 把 Antigravity 接成 DSH 一级模型。登录态留在官方进程里，插件不保存钥匙，也不把请求转到别的网关。 |
| [`agy-context-unlock`](./agy-context-unlock) | 可选的本地解锁脚本。把官方客户端默认的 256K 上下文放到约 1M。它会改写本机 `agy` 二进制，不随插件一起安装。 |

安装插件：

```sh
dsh plugin --profile web add "git+https://github.com/lili-luo/dsh-plugin-bundle.git#main&path:/dsh-llm-antigravity-acp"
```

协议说明：[Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)。`agy acp` 的产品说明：[Antigravity CLI ACP](https://antigravity.google/docs/cli/acp/)。

## 社区

本项目在 [LINUX DO](https://linux.do) 社区进行开源推广，感谢社区佬友的交流、反馈与建议。
