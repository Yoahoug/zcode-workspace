> 来源：青龙官方文档 https://qinglong.online/（抓取日期 2026-10-01，面板版本 2.20.0-1）。逐字整理，未改写事实。

# 脚本管理 API 文档#

## 基础路径#

/scripts

## 接口列表#

### 获取脚本列表#

```
GET /
```

查询参数

```
{
 path?: string // 脚本路径
}
```

注意

- 排除黑名单文件夹（node_modules, .git 等）

- 目录优先排序

### 获取脚本详情#

```
GET /detail
```

查询参数

```
{
 path?: string, // 脚本路径
 file: string // 文件名
}
```

### 上传/创建脚本#

```
POST /
```

请求体 (multipart/form-data)

```
{
 file?: File, // 上传的文件
 filename: string, // 文件名
 path?: string, // 文件路径
 content?: string, // 文件内容
 originFilename?: string, // 原文件名
 directory?: string // 目录名（创建目录时使用）
}
```

### 更新脚本内容#

```
PUT /
```

请求体

```
{
 filename: string, // 文件名
 path?: string, // 文件路径
 content: string // 文件内容
}
```

### 删除脚本#

```
DELETE /
```

请求体

```
{
 filename: string, // 文件名
 path?: string, // 文件路径
 type?: string // 类型
}
```

### 下载脚本#

```
POST /download
```

请求体

```
{
 filename: string, // 文件名
 path?: string, // 文件路径
}
```

### 运行脚本#

```
PUT /run
```

请求体

```
{
 filename: string, // 文件名
 content?: string, // 文件内容
 path?: string // 文件路径
}
```

此接口用于调试传入的 content：它会生成并执行同目录下的临时文件（例如 demo.js 对应 demo.swap.js）。省略 content 会写入空内容，不会读取原脚本。要执行已保存的定时任务，请使用定时任务 API 的 PUT /open/crons/run。

### 停止脚本#

```
PUT /stop
```

请求体

```
{
 filename: string, // 文件名
 path?: string, // 文件路径
 pid?: number // 进程ID
}
```

### 重命名脚本#

```
PUT /rename
```

请求体

```
{
 filename: string, // 原文件名
 path?: string, // 文件路径
 newFilename: string // 新文件名
}
```

## 错误处理#

- 所有接口遵循统一的错误处理机制

- 成功响应返回 { code: 200, data: ... }

- 错误日志由 Winston logger 处理

## 注意事项#

- 使用 multer 处理文件上传

- 文件路径安全检查

- 支持文件备份

- 临时文件自动清理

## 已下线接口#

GET /open/scripts/:file 返回业务代码 410。请使用 GET /open/scripts/detail，通过 file 和可选 path 查询文件。
