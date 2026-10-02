// The complete Qinglong remote route inventory, as data.
//
// Source of truth: the official docs' "API 与 CLI 路由" page plus the per-resource OpenAPI
// pages (https://qinglong.online/, panel 2.20.0-1, snapshot 2026-10-01), cross-checked
// against `ql api routes --json`, which returns 143 routes. The panel additionally serves
// /open/dashboard/successes and /open/dashboard/failures, which the CLI's route table does
// not index; they are listed under EXTRAS below and are reachable from this plugin's generic
// request path.
//
// `scope` is the application scope (面板 系统设置 → 应用设置) the route requires. A route
// can exist and still answer 403 when the application lacks its scope — route existence and
// authorization are different facts.
//
// `destructive: true` marks routes that delete or overwrite data (or restart/wipe the panel);
// the CLI refuses them without --yes and the MCP generic tool refuses them without confirm.

export const GROUPS = [
  {
    group: "定时任务",
    id: "crons",
    scope: "crons",
    routes: [
      { method: "GET", path: "/open/crons/views", purpose: "任务视图列表" },
      { method: "POST", path: "/open/crons/views", purpose: "创建任务视图（name 必填）" },
      { method: "PUT", path: "/open/crons/views", purpose: "更新任务视图（id + name 必填）" },
      { method: "DELETE", path: "/open/crons/views", purpose: "删除任务视图（ID 数组）", destructive: true },
      { method: "PUT", path: "/open/crons/views/move", purpose: "移动视图位置（fromIndex/toIndex/id）" },
      { method: "PUT", path: "/open/crons/views/disable", purpose: "禁用任务视图（ID 数组）" },
      { method: "PUT", path: "/open/crons/views/enable", purpose: "启用任务视图（ID 数组）" },
      { method: "GET", path: "/open/crons", purpose: "任务列表（searchValue/status/type/page/size 等）" },
      { method: "GET", path: "/open/crons/detail", purpose: "任务详情（query 传 id 或搜索条件）" },
      { method: "POST", path: "/open/crons", purpose: "创建任务（command + schedule 必填）" },
      { method: "PUT", path: "/open/crons/run", purpose: "运行任务（ID 数组；accepted≠执行成功）" },
      { method: "PUT", path: "/open/crons/stop", purpose: "停止任务（ID 数组）" },
      { method: "DELETE", path: "/open/crons/labels", purpose: "删除任务标签（ids + labels）", destructive: true },
      { method: "POST", path: "/open/crons/labels", purpose: "添加任务标签（ids + labels）" },
      { method: "PUT", path: "/open/crons/disable", purpose: "禁用任务（ID 数组）" },
      { method: "PUT", path: "/open/crons/enable", purpose: "启用任务（ID 数组）" },
      { method: "GET", path: "/open/crons/:id/log", purpose: "任务日志分块读取（offset/limit/tail，按字节）" },
      { method: "PUT", path: "/open/crons", purpose: "更新任务（id + command + schedule 必填，整体提交）" },
      { method: "DELETE", path: "/open/crons", purpose: "删除任务（ID 数组）", destructive: true },
      { method: "PUT", path: "/open/crons/pin", purpose: "置顶任务（ID 数组）" },
      { method: "PUT", path: "/open/crons/unpin", purpose: "取消置顶（ID 数组）" },
      { method: "GET", path: "/open/crons/import", purpose: "从 crontab 导入定时任务" },
      { method: "GET", path: "/open/crons/:id", purpose: "按 ID 取单个任务" },
      { method: "PUT", path: "/open/crons/status", purpose: "更新任务运行状态（面板内部：status/pid/log_path）" },
      { method: "GET", path: "/open/crons/:id/instances", purpose: "任务实例列表（按启动时间降序）" },
      { method: "POST", path: "/open/crons/:id/instances/:instanceId/stop", purpose: "停止指定任务实例" },
      { method: "GET", path: "/open/crons/:id/logs", purpose: "任务的日志文件列表" },
    ],
  },
  {
    group: "订阅",
    id: "subscriptions",
    scope: "subscriptions",
    routes: [
      { method: "GET", path: "/open/subscriptions", purpose: "订阅列表（searchValue / ids）" },
      { method: "POST", path: "/open/subscriptions", purpose: "创建订阅（type/url/alias/schedule_type 必填）" },
      { method: "PUT", path: "/open/subscriptions/run", purpose: "运行订阅，触发拉取（ID 数组）" },
      { method: "PUT", path: "/open/subscriptions/stop", purpose: "停止订阅（ID 数组）" },
      { method: "PUT", path: "/open/subscriptions/disable", purpose: "禁用订阅（ID 数组）" },
      { method: "PUT", path: "/open/subscriptions/enable", purpose: "启用订阅（ID 数组）" },
      { method: "GET", path: "/open/subscriptions/:id/log", purpose: "订阅日志分块读取（按字节）" },
      { method: "PUT", path: "/open/subscriptions", purpose: "更新订阅（id/type/url/alias 必填）" },
      { method: "DELETE", path: "/open/subscriptions", purpose: "删除订阅（ID 数组；query force=true 连删任务与脚本目录）", destructive: true },
      { method: "GET", path: "/open/subscriptions/:id", purpose: "订阅详情" },
      { method: "PUT", path: "/open/subscriptions/status", purpose: "更新订阅运行状态（面板内部）" },
      { method: "GET", path: "/open/subscriptions/:id/logs", purpose: "订阅的日志文件列表" },
    ],
  },
  {
    group: "环境变量",
    id: "envs",
    scope: "envs",
    routes: [
      { method: "GET", path: "/open/envs", purpose: "环境变量列表（searchValue）" },
      { method: "POST", path: "/open/envs", purpose: "创建环境变量（对象数组；name 以字母/下划线开头）" },
      { method: "PUT", path: "/open/envs", purpose: "更新环境变量（id + name + value 必填，整体提交）" },
      { method: "DELETE", path: "/open/envs", purpose: "删除环境变量（ID 数组）", destructive: true },
      { method: "PUT", path: "/open/envs/:id/move", purpose: "移动环境变量位置（fromIndex/toIndex）" },
      { method: "PUT", path: "/open/envs/disable", purpose: "禁用环境变量（ID 数组）" },
      { method: "PUT", path: "/open/envs/enable", purpose: "启用环境变量（ID 数组）" },
      { method: "PUT", path: "/open/envs/name", purpose: "批量改名（ids + name）" },
      { method: "GET", path: "/open/envs/:id", purpose: "按 ID 取单个环境变量" },
      { method: "PUT", path: "/open/envs/pin", purpose: "置顶环境变量（ID 数组）" },
      { method: "PUT", path: "/open/envs/unpin", purpose: "取消置顶（ID 数组）" },
      { method: "POST", path: "/open/envs/labels", purpose: "添加标签（ids + labels）" },
      { method: "DELETE", path: "/open/envs/labels", purpose: "删除标签（ids + labels）", destructive: true },
      { method: "POST", path: "/open/envs/upload", purpose: "上传环境变量文件（multipart 字段 env；只新建，不按 id 更新）" },
    ],
  },
  {
    group: "脚本",
    id: "scripts",
    scope: "scripts",
    routes: [
      { method: "GET", path: "/open/scripts", purpose: "脚本列表（path；排除黑名单目录，目录优先）" },
      { method: "GET", path: "/open/scripts/detail", purpose: "脚本内容（file + path）；旧 /open/scripts/:file 已下线（410）" },
      { method: "POST", path: "/open/scripts", purpose: "创建脚本/目录（filename/path/content/file/directory）" },
      { method: "PUT", path: "/open/scripts", purpose: "更新脚本内容（filename + content + path）" },
      { method: "DELETE", path: "/open/scripts", purpose: "删除脚本（filename + path）", destructive: true },
      { method: "POST", path: "/open/scripts/download", purpose: "下载脚本（返回文件流）" },
      { method: "PUT", path: "/open/scripts/run", purpose: "调试运行：传 content 生成临时 swap 文件；省略 content 会写空内容" },
      { method: "PUT", path: "/open/scripts/stop", purpose: "停止脚本（filename/path/pid）" },
      { method: "PUT", path: "/open/scripts/rename", purpose: "重命名脚本（filename + newFilename）" },
    ],
  },
  {
    group: "配置文件",
    id: "configs",
    scope: "configs",
    routes: [
      { method: "GET", path: "/open/configs/samples", purpose: "示例配置文件列表" },
      { method: "GET", path: "/open/configs/files", purpose: "配置文件列表" },
      { method: "GET", path: "/open/configs/detail", purpose: "读取配置文件（path=config.sh）；旧 /open/configs/:file 已下线（410）" },
      { method: "POST", path: "/open/configs/save", purpose: "保存配置文件（name + content，整体覆盖）" },
    ],
  },
  {
    group: "日志",
    id: "logs",
    scope: "logs",
    routes: [
      { method: "GET", path: "/open/logs", purpose: "日志目录列表" },
      { method: "GET", path: "/open/logs/detail", purpose: "分块读日志（file/path/offset/limit/tail；offset 按字节）" },
      { method: "DELETE", path: "/open/logs", purpose: "删除日志文件或目录（body: filename + path）", destructive: true },
      { method: "POST", path: "/open/logs/download", purpose: "下载日志（返回文件流）" },
    ],
  },
  {
    group: "依赖",
    id: "dependencies",
    scope: "dependencies",
    routes: [
      { method: "GET", path: "/open/dependencies", purpose: "依赖列表（searchValue/type 枚举名/status）" },
      { method: "POST", path: "/open/dependencies", purpose: "创建依赖（数组；type 数字 0 Node/1 Python3/2 Linux）" },
      { method: "PUT", path: "/open/dependencies", purpose: "更新依赖（id + name + type）" },
      { method: "DELETE", path: "/open/dependencies", purpose: "删除依赖（ID 数组）", destructive: true },
      { method: "DELETE", path: "/open/dependencies/force", purpose: "强制删除依赖（ID 数组）", destructive: true },
      { method: "GET", path: "/open/dependencies/:id", purpose: "按 ID 取单个依赖" },
      { method: "PUT", path: "/open/dependencies/reinstall", purpose: "重新安装依赖（ID 数组）" },
      { method: "PUT", path: "/open/dependencies/cancel", purpose: "取消安装（ID 数组）" },
    ],
  },
  {
    group: "系统",
    id: "system",
    scope: "system",
    routes: [
      { method: "GET", path: "/open/system", purpose: "系统信息（isInitialized/version/branch/更新日志）" },
      { method: "GET", path: "/open/system/config", purpose: "系统配置" },
      { method: "PUT", path: "/open/system/config/log-remove-frequency", purpose: "日志清理频率（logRemoveFrequency）" },
      { method: "PUT", path: "/open/system/config/cron-concurrency", purpose: "任务并发数（cronConcurrency）" },
      { method: "PUT", path: "/open/system/config/dependence-proxy", purpose: "依赖代理（dependenceProxy）" },
      { method: "PUT", path: "/open/system/config/node-mirror", purpose: "Node 镜像（nodeMirror）" },
      { method: "PUT", path: "/open/system/config/python-mirror", purpose: "Python 镜像（pythonMirror）" },
      { method: "PUT", path: "/open/system/config/linux-mirror", purpose: "Linux 镜像（linuxMirror）" },
      { method: "PUT", path: "/open/system/update-check", purpose: "检查系统更新" },
      { method: "PUT", path: "/open/system/update", purpose: "执行系统更新并重启", destructive: true },
      { method: "PUT", path: "/open/system/reload", purpose: "重载（type=data 会替换并清空数据目录）", destructive: true },
      { method: "PUT", path: "/open/system/notify", purpose: "发送通知（title/content，可带 notificationInfo）" },
      { method: "PUT", path: "/open/system/command-run", purpose: "运行命令（响应是持续的 octet-stream 流，带 QL-Task-Pid/QL-Task-Log）" },
      { method: "PUT", path: "/open/system/command-stop", purpose: "停止命令（command 或 pid）" },
      { method: "PUT", path: "/open/system/data/export", purpose: "导出数据（流式下载；省略 type 只含 db+upload）" },
      { method: "PUT", path: "/open/system/data/import", purpose: "导入数据（multipart；还须 reload type=data 才生效）", destructive: true },
      { method: "GET", path: "/open/system/log", purpose: "系统日志（文本；startTime/endTime/limit，按文件创建日期）" },
      { method: "DELETE", path: "/open/system/log", purpose: "删除系统日志", destructive: true },
      { method: "PUT", path: "/open/system/auth/reset", purpose: "重置登录认证状态（登录错误次数等）", destructive: true },
      { method: "PUT", path: "/open/system/config/timezone", purpose: "时区（timezone）" },
      { method: "PUT", path: "/open/system/config/lang", purpose: "语言（lang）" },
      { method: "PUT", path: "/open/system/config/panel-title", purpose: "面板标题（panelTitle）" },
      { method: "PUT", path: "/open/system/config/global-ssh-key", purpose: "全局 SSH 密钥" },
      { method: "PUT", path: "/open/system/config/dependence-clean", purpose: "清理依赖缓存", destructive: true },
      { method: "GET", path: "/open/system/client-ip/config", purpose: "查询客户端 IP 代理信任配置" },
      { method: "PUT", path: "/open/system/client-ip/config", purpose: "更新代理信任配置（trustProxy）" },
      { method: "GET", path: "/open/system/client-ip/diagnose", purpose: "诊断当前请求的客户端 IP 解析" },
      { method: "PUT", path: "/open/system/storage-retention/config", purpose: "保存数据保留策略（两个保留天数必填）" },
      { method: "POST", path: "/open/system/storage-retention/preview", purpose: "预览清理范围（只读）" },
      { method: "POST", path: "/open/system/storage-retention/cleanup", purpose: "执行清理（需 confirmation=CLEAN）", destructive: true },
    ],
  },
  {
    group: "仪表盘",
    id: "dashboard",
    scope: "dashboard",
    routes: [
      { method: "POST", path: "/open/dashboard/record", purpose: "写入任务执行统计（ref_id/code/elapsed，会累加）" },
      { method: "GET", path: "/open/dashboard/overview", purpose: "总览：任务数/启停/今日运行与成败/成功率/平均耗时" },
      { method: "GET", path: "/open/dashboard/trend", purpose: "按天趋势（days 默认 7）" },
      { method: "GET", path: "/open/dashboard/top-time", purpose: "今日耗时排名（最多 5 项）" },
      { method: "GET", path: "/open/dashboard/top-count", purpose: "今日运行次数排名（最多 5 项）" },
      { method: "GET", path: "/open/dashboard/runtime", purpose: "运行中实例/排队数量/近期未执行" },
      { method: "GET", path: "/open/dashboard/labels", purpose: "按标签聚合（数量/次数/成功率/耗时）" },
      { method: "GET", path: "/open/dashboard/system", purpose: "系统资源：OS/内存/CPU/负载/进程运行时间" },
    ],
  },
  {
    group: "应用（面板 OpenAPI 应用）",
    id: "apps",
    scope: "apps",
    routes: [
      { method: "GET", path: "/open/apps", purpose: "应用列表（排除内部 system 应用；tokens 数组为空）" },
      { method: "POST", path: "/open/apps", purpose: "创建应用（name 不能是 system；scopes 数组）" },
      { method: "PUT", path: "/open/apps", purpose: "更新应用（id + name/scopes）" },
      { method: "DELETE", path: "/open/apps", purpose: "删除应用（ID 数组）", destructive: true },
      { method: "PUT", path: "/open/apps/:id/reset-secret", purpose: "重置应用密钥（清空已有 token，不可逆）", destructive: true },
    ],
  },
  {
    group: "用户与安全",
    id: "user",
    scope: "user",
    routes: [
      { method: "POST", path: "/open/user/login", purpose: "面板登录（限速 100 次/15 分钟）" },
      { method: "POST", path: "/open/user/logout", purpose: "面板登出" },
      { method: "PUT", path: "/open/user", purpose: "更新用户名/密码" },
      { method: "GET", path: "/open/user", purpose: "用户信息" },
      { method: "GET", path: "/open/user/two-factor/init", purpose: "初始化两步验证（返回密钥/二维码）" },
      { method: "PUT", path: "/open/user/two-factor/active", purpose: "激活两步验证（code）" },
      { method: "PUT", path: "/open/user/two-factor/deactivate", purpose: "停用两步验证", destructive: true },
      { method: "PUT", path: "/open/user/two-factor/login", purpose: "两步验证登录（限速 20 次/15 分钟）" },
      { method: "GET", path: "/open/user/login-log", purpose: "登录日志" },
      { method: "GET", path: "/open/user/ip-blacklist", purpose: "IP 黑名单" },
      { method: "PUT", path: "/open/user/ip-blacklist", purpose: "加入黑名单（单个 IPv4/IPv6，不支持 CIDR）" },
      { method: "DELETE", path: "/open/user/ip-blacklist", purpose: "移出黑名单" },
      { method: "GET", path: "/open/user/notification", purpose: "通知设置" },
      { method: "PUT", path: "/open/user/notification", purpose: "更新通知设置" },
      { method: "PUT", path: "/open/user/init", purpose: "初始化用户信息（仅在未初始化时可用）" },
      { method: "PUT", path: "/open/user/notification/init", purpose: "初始化通知设置" },
      { method: "PUT", path: "/open/user/avatar", purpose: "更新头像（multipart 字段 avatar，≤5 MiB）" },
    ],
  },
  {
    group: "系统应用（更新/重载/数据）",
    id: "update",
    scope: "system",
    routes: [
      { method: "PUT", path: "/open/update/reload", purpose: "应用并重载（等价 system reload）", destructive: true },
      { method: "PUT", path: "/open/update/system", purpose: "应用系统更新", destructive: true },
      { method: "PUT", path: "/open/update/data", purpose: "应用数据导入", destructive: true },
    ],
  },
  {
    group: "健康检查",
    id: "health",
    scope: null,
    routes: [
      { method: "GET", path: "/open/health", purpose: "健康检查（未认证时返回 HTTP 401）" },
    ],
  },
  {
    group: "认证",
    id: "auth",
    scope: null,
    routes: [
      { method: "GET", path: "/open/auth/token", purpose: "换取访问令牌（查询参数 client_id + client_secret；唯一免鉴权路由）" },
    ],
  },
];

/**
 * Routes the panel serves but the official CLI route table (143) does not index. They are
 * reachable through the generic request tool; the dashboard MCP tool uses them for the
 * successes/failures views.
 */
export const EXTRAS = [
  { method: "GET", path: "/open/dashboard/successes", purpose: "今日成功任务（CLI 未收录；直接 HTTP 可访问）" },
  { method: "GET", path: "/open/dashboard/failures", purpose: "今日失败任务（CLI 未收录；直接 HTTP 可访问）" },
];

const ALL_ROUTES = GROUPS.flatMap((group) =>
  group.routes.map((route) => ({ ...route, group: group.group, groupId: group.id, scope: group.scope })),
);

function pathPattern(path) {
  // ":" parameters match exactly one non-empty segment; the rest is literal.
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/:[A-Za-z][A-Za-z0-9_]*/g, "[^/]+")}/?$`);
}

/** Find the route matching a method and concrete path, or undefined. */
export function matchRoute(method, path) {
  const wanted = String(path).replace(/\/+$/, "") || "/";
  return ALL_ROUTES.find(
    (route) => route.method === method.toUpperCase() && pathPattern(route.path).test(wanted),
  );
}

export function findRoutes(term) {
  if (term === undefined || term === null || String(term).trim() === "") return ALL_ROUTES;
  const needle = String(term).toLowerCase();
  return ALL_ROUTES.filter(
    (route) =>
      route.path.toLowerCase().includes(needle) ||
      route.purpose.toLowerCase().includes(needle) ||
      route.group.toLowerCase().includes(needle) ||
      route.groupId.includes(needle) ||
      route.method.toLowerCase() === needle,
  );
}

export function routeStats() {
  const byScope = {};
  for (const route of ALL_ROUTES) {
    const key = route.scope ?? "none";
    byScope[key] = (byScope[key] ?? 0) + 1;
  }
  return {
    total: ALL_ROUTES.length,
    groups: GROUPS.length,
    destructive: ALL_ROUTES.filter((route) => route.destructive).length,
    byScope,
  };
}

export function isDestructive(method, path) {
  const known = matchRoute(method, path);
  if (known) return known.destructive === true;
  // Unknown paths fall back to intent sniffing: a DELETE, or a write whose path says it
  // deletes/overwrites/restarts. Being conservative here only costs a confirm flag.
  if (method.toUpperCase() === "DELETE") return true;
  return /delete|force|reset|clear|cleanup|import|export|reload|update$|wipe|remove/i.test(String(path));
}

export { ALL_ROUTES };
