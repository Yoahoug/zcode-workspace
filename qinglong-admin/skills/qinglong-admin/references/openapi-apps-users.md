> 来源：青龙官方文档 https://qinglong.online/（抓取日期 2026-10-01，面板版本 2.20.0-1）。逐字整理，未改写事实。

# 开放平台 API 文档#

## 基础路径#

/

## 接口列表#

### 应用管理#

#### 获取应用列表#

```
GET /apps
```

获取已创建的应用，排除内部 system 应用；响应中的 tokens 数组为空。

#### 创建应用#

```
POST /apps
```

请求体

```
{
 name?: string, // 应用名称（不能为'system'）
 scopes?: string[] // 权限范围
}
```

#### 更新应用#

```
PUT /apps
```

请求体

```
{
 id: number, // 应用ID
 name?: string, // 应用名称
 scopes?: string[] // 权限范围
}
```

#### 删除应用#

```
DELETE /apps
```

请求体

```
number[] // 应用ID数组
```

#### 重置应用密钥#

```
PUT /apps/:id/reset-secret
```

重置指定应用的密钥，并清空已有令牌。调用方需要使用新密钥重新获取 token。

### 认证#

#### 获取访问令牌#

```
GET /auth/token
```

查询参数

```
{
 client_id: string, // 客户端ID
 client_secret: string // 客户端密钥
}
```

## 错误处理#

- 所有接口遵循统一的错误处理机制

- 成功响应返回 { code: 200, data: ... }

- 错误日志由 Winston logger 处理

## 注意事项#

- 使用 celebrate/Joi 进行参数验证

- 应用名称不能使用保留字 'system'

- 支持批量删除应用

- 密钥重置操作不可逆

---

# 用户管理 API 文档#

## 基础路径#

/user

## 接口列表#

### 用户登录#

```
POST /login
```

请求体

```
{
 username: string, // 用户名
 password: string // 密码
}
```

注意

- 限制速率：每15分钟最多100次请求

### 用户登出#

```
POST /logout
```

### 更新用户信息#

```
PUT /
```

请求体

```
{
 username: string, // 用户名
 password: string // 密码
}
```

### 获取用户信息#

```
GET /
```

### 两步验证相关#

#### 初始化两步验证#

```
GET /two-factor/init
```

#### 激活两步验证#

```
PUT /two-factor/active
```

请求体

```
{
 code: string // 验证码
}
```

#### 停用两步验证#

```
PUT /two-factor/deactivate
```

#### 两步验证登录#

```
PUT /two-factor/login
```

请求体

```
{
 code: string, // 验证码
 username: string, // 用户名
 password: string // 密码
}
```

两步验证登录每 15 分钟最多 20 次请求。

### 登录日志#

```
GET /login-log
```

### IP 黑名单#

GET /ip-blacklist 查询黑名单；PUT /ip-blacklist 加入黑名单；DELETE /ip-blacklist 移出黑名单。后两者使用 JSON 请求体：

```
{"ip":"192.0.2.1"}
```

ip 必填，支持单个 IPv4 或 IPv6 地址，不支持 CIDR 网段。

### 通知设置#

#### 获取通知设置#

```
GET /notification
```

#### 更新通知设置#

```
PUT /notification
```

### 初始化设置#

#### 初始化用户信息#

```
PUT /init
```

请求体

```
{
 username: string, // 用户名
 password: string // 密码
}
```

#### 初始化通知设置#

```
PUT /notification/init
```

### 更新头像#

```
PUT /avatar
```

请求体

- Content-Type: multipart/form-data

- 字段: avatar (文件)

- 仅允许一个文件，最大 5 MiB；支持 PNG、JPEG、GIF、WebP、AVIF，扩展名必须与 MIME 类型匹配。

## 错误处理#

- 所有接口遵循统一的错误处理机制

- 成功响应返回 { code: 200, data: ... }

- 错误日志由 Winston logger 处理

## 注意事项#

- 使用 celebrate/Joi 进行参数验证

- 文件上传使用 multer 处理

- 头像文件名使用 UUID 生成

- 演示环境下部分功能受限
