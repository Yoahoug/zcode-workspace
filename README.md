# zcode-workspace

ZCode 工作空间里的插件目录，目前包含两个插件：

| 插件 | 说明 |
|---|---|
| [`zcode-websearch`](plugins/zcode-websearch/README.md) | 通过 Tavily API 给 ZCode 提供联网搜索。`web_search` 只返回来源链接与短摘要（条数、摘要长度由部署配置固定，模型改不了），`web_fetch` 每次读一个 URL 的正文 |
| [`newapi-admin`](plugins/newapi-admin/README.md) | 对 [New API](https://github.com/QuantumNous/new-api)（new-api）实例做完整管理员运维：渠道、模型元数据、模型定价与倍率、用户、令牌、兑换码、日志、统计、分组、供应商、Root 系统选项。零依赖 CLI + MCP 服务覆盖全部 295 条管理路由 |

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
  newapi-admin/
    .zcode-plugin/plugin.json          插件清单：名称、版本、MCP 服务器、可配置项
    .mcp.json                          MCP 服务器声明（与上者内容一致）
    server/index.mjs                   MCP stdio 服务，16 个工具
    scripts/newapi-admin.mjs           零依赖 CLI，与 MCP 服务共用同一套请求核心
    lib/core.mjs                       共享核心：配置解析、请求发送、响应信封判定
    lib/routes.mjs                     295 条管理路由的索引，取自 new-api 后端路由源码
    skills/newapi-admin/SKILL.md       何时用 MCP、何时用 CLI，以及安全边界
    skills/newapi-admin/references/    字段级参考文档 8 篇 + 索引
    test/                              3 套检查（121 + 53 + 161 项）与契约 mock 服务
    tools/generate-endpoints.mjs       从 lib/routes.mjs 重新生成 endpoints.md
    README.md                          安装、配置、Root 与管理员权限差异、CLI 用法、安全提示
```

## 作为 ZCode 市场源安装

在 ZCode 里打开 **插件市场 → 添加 → 添加插件市场**，二选一：

- **直接粘贴仓库地址**：`https://github.com/Yoahoug/zcode-workspace`（ZCode 会浅克隆仓库并读取根目录的 `.claude-plugin/marketplace.json`）
- **本地目录**：克隆本仓库后，选择**仓库根目录**（不是 `plugins` 子目录）

添加后市场名为 `zcode-workspace`，插件有 `zcode-websearch` 和 `newapi-admin` 两个。
配置 API Key / 访问令牌、更新到新版本、以及各种报错的排查见各插件自己的 README：

- [`plugins/zcode-websearch/README.md`](plugins/zcode-websearch/README.md)
- [`plugins/newapi-admin/README.md`](plugins/newapi-admin/README.md)

## 验证

两套验证都不需要真实凭据（websearch 用本地 stub 顶替 `api.tavily.com`，newapi-admin 用复刻官方
契约的 mock 服务）：

```bash
node plugins/zcode-websearch/test/verify-server.mjs

cd plugins/newapi-admin && npm test
```

## 加一个新插件

1. 在 `plugins/` 下建目录，目录名与插件名一致（小写 + 连字符）。
2. 写 `plugins/<name>/.zcode-plugin/plugin.json`：`name`、`version`、`description`、`skills`，
   需要 MCP 服务就再加 `mcpServers` 与 `userConfig`。引用插件内文件一律用 `${CLAUDE_PLUGIN_ROOT}`，
   这个变量只在 MCP `args` 和 hook 命令里展开。
3. 加组件：Skill 放 `skills/<skill-name>/SKILL.md`（frontmatter 必须有 `name` 与 `description`）。
   需要 MCP 的再补一份内容相同的 `.mcp.json`，与现有两个插件保持一致。
4. 在 `.claude-plugin/marketplace.json` 的 `plugins` 里登记一条，`source` 写 `./plugins/<name>`，
   `version` 与 `plugin.json` 保持一致，并补上 `displayName`、`displayName_i18n`、`description_i18n`
   和 `category`。
5. 密钥一律走 `userConfig` 或环境变量，不要写进仓库。
6. 提交；使用者刷新市场即可看到新插件。

## License

MIT，见 [LICENSE](LICENSE)。
