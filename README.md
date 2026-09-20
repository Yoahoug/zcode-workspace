# zcode-workspace

ZCode 工作空间里的插件目录，目前包含一个插件：

| 插件 | 说明 |
|---|---|
| [`zcode-websearch`](plugins/zcode-websearch/README.md) | 通过 Tavily API 给 ZCode 提供联网搜索。`web_search` 只返回来源链接与短摘要（条数、摘要长度由部署配置固定，模型改不了），`web_fetch` 每次读一个 URL 的正文 |

## 目录结构

```
.claude-plugin/
  marketplace.json                     插件市场清单（ZCode 从仓库根目录读取这个文件）
plugins/
  zcode-websearch/
    .zcode-plugin/plugin.json          插件清单：名称、版本、MCP 服务器、可配置项
    .mcp.json                          MCP 服务器声明（stdio，node 启动 server/index.mjs）
    server/index.mjs                   服务器实现（零第三方依赖，Node 18+ 原生 fetch）
    skills/web-search/SKILL.md         何时该搜索、结果怎么引用
    test/verify-server.mjs             端到端验证：93 项断言，不需要真实 API Key
    README.md                          安装、配置项、截断策略、故障排查
```

## 作为 ZCode 市场源安装

在 ZCode 里打开 **插件市场 → 添加 → 添加插件市场**，二选一：

- **直接粘贴仓库地址**：`https://github.com/Yoahoug/zcode-workspace`（ZCode 会浅克隆仓库并读取根目录的 `.claude-plugin/marketplace.json`）
- **本地目录**：克隆本仓库后，选择**仓库根目录**（不是 `plugins` 子目录）

添加后市场名为 `zcode-workspace`，插件为 `zcode-websearch`。
配置 API Key、更新到新版本、以及各种报错的排查见
[`plugins/zcode-websearch/README.md`](plugins/zcode-websearch/README.md)。

## 验证

不需要真实 Key 就能跑完整链路（本地 stub 顶替 `api.tavily.com`）：

```bash
node plugins/zcode-websearch/test/verify-server.mjs
```

## License

MIT，见 [LICENSE](LICENSE)。
