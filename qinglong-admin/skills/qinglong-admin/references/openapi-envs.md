> 来源：青龙官方文档 https://qinglong.online/（抓取日期 2026-10-01，面板版本 2.20.0-1）。逐字整理，未改写事实。

# 环境变量 API 文档#

## 基础路径#

/envs

## 接口列表#

### 获取环境变量列表#

```
GET /
```

查询参数

```
{
 searchValue?: string // 搜索关键词
}
```

### 创建环境变量#

```
POST /
```

请求体

```
[
 {
 name: string, // 变量名（必须以字母或下划线开头，只能包含字母、数字和下划线）
 value: string, // 变量值
 remarks?: string // 备注（可选）
 }
]
```

### 更新环境变量#

```
PUT /
```

请求体

```
{
 id: number, // 环境变量ID
 name: string, // 变量名
 value: string, // 变量值
 remarks?: string // 备注（可选）
}
```

### 删除环境变量#

```
DELETE /
```

请求体

```
number[] // 环境变量ID数组
```

### 移动环境变量位置#

```
PUT /:id/move
```

请求体

```
{
 fromIndex: number, // 原位置
 toIndex: number // 目标位置
}
```

### 禁用环境变量#

```
PUT /disable
```

请求体

```
number[] // 环境变量ID数组
```

### 启用环境变量#

```
PUT /enable
```

请求体

```
number[] // 环境变量ID数组
```

### 批量更新变量名#

```
PUT /name
```

请求体

```
{
 ids: number[], // 环境变量ID数组
 name: string // 新变量名
}
```

### 获取单个环境变量#

```
GET /:id
```

获取指定ID的环境变量详情。

### 上传环境变量文件#

```
POST /upload
```

请求

- Content-Type: multipart/form-data

- 字段: env (文件)

文件格式要求

- JSON格式

- 每条数据必须包含 name 和 value 字段

支持单个 JSON 对象或对象数组，name 和 value 不可为空；可同时提供 remarks、labels。导入会创建新变量，不按文件中的 id 更新已有变量。示例：

```
[{"name":"EXAMPLE","value":"demo","remarks":"Example","labels":["demo"]}]
```

## 错误处理#

- 所有接口遵循统一的错误处理机制

- 成功响应返回 { code: 200, data: ... }

- 错误日志由 Winston logger 处理

## 注意事项#

- 使用 celebrate/Joi 进行参数验证

- 变量名必须符合命名规范

- 支持批量操作（删除、启用、禁用等）

- 文件上传使用 multer 处理

## 权限、标签与置顶#

完整基础路径为 /open/envs，应用需要 envs 权限。创建和更新还可传入 labels?: string[]；更新必须同时提供 id/name/value，不能只提交修改的标签。

| 方法 | 路径 | 请求体 |
|---|---|---|
| PUT | /pin | 环境变量 ID 数组，例如 [1,2] |
| PUT | /unpin | 环境变量 ID 数组 |
| POST | /labels | { "ids": [1,2], "labels": ["demo"] } |
| DELETE | /labels | { "ids": [1,2], "labels": ["demo"] } |

标签操作的 ids 和 labels 均必填且至少包含一项；标签会去除首尾空白，不可为空字符串。添加/删除标签接口修改指定标签，不要求重新提交变量值。

```
ql env pin 1 2 --json
ql env labels-create --data '{"ids":[1,2],"labels":["demo"]}' --json
ql env list --query '{"searchValue":"EXAMPLE"}' --json
```

列表成功响应示例（字段可能随面板版本扩展）：

```
{
 "code": 200,
 "data": [
 { "id": 1, "name": "EXAMPLE", "value": "demo", "remarks": "", "labels": ["demo"] }
 ]
}
```
