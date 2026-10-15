# 插件专用凭证协议 v2

客户端与中央服务已接入。当前网站使用 UU 登录名和密码完成首次验证，签发独立插件令牌。该凭证标识每个插件，与邮箱登录和网站用户账户分开管理。

接口：配置地址下的 `/api/extension/v2/{login,heartbeat,events,logout}`。全部 POST JSON，除 login 外使用 `Authorization: Bearer <access_token>`。不跟随重定向，不使用网站登录 Cookie。HTTP 成功、`ok:true` 和 `protocol_version:2` 必须同时满足。

## 1. 预设凭证

中央管理员为每个插件创建独立账户、密码、稳定 `device_id` 和启用状态。密码使用安全哈希保存，验证及错误限流在服务器执行。不要用插件上报的邮箱或本地 UUID 作为授权依据。

`installation_id` 为本浏览器扩展安装时生成的 UUID。建议首次验证时将专用凭证绑定到安装，重复安装或更换电脑由管理员重置，避免同一凭证被无意复制到多个实例。具体绑定策略由中央决定。

## 2. 登录验证

请求：

```json
{
  "protocol_version": 2,
  "account": "plugin-001",
  "password": "服务器预先分配的插件密码",
  "installation_id": "本地安装 UUID",
  "extension_version": "0.2.2"
}
```

验证成功：

```json
{
  "ok": true,
  "protocol_version": 2,
  "account": "plugin-001",
  "device_id": "中央分配的稳定插件 ID",
  "access_token": "有期限且可撤销的会话令牌"
}
```

返回的 account 必须与提交值一致，device_id 非空。普通网页登录成功、HTTP 200 HTML、旧 v1 配对结果都不等于插件身份验证。凭证错误或停用返回 401 / 403。插件不保存密码，后续只使用设备会话令牌；令牌失效后要求重新验证。

## 3. 在线心跳

请求包含 `protocol_version,account,device_id,installation_id,session_id,sequence,extension_version,sent_at,previous_challenge,pending_event_count,last_upload_error,mailboxes,unidentified_pages`。

mailboxes 中每项为：

```json
{
  "mailbox_id": "本地按插件身份及邮箱计算的标识",
  "provider": "outlook",
  "email": "mailbox@outlook.com",
  "status": "limited",
  "last_scan_at": 1792065600000,
  "open_tab_count": 1,
  "coverage": "visible_rows"
}
```

没有 shop / 店铺名称字段，无需手动绑定。无法识别邮箱地址的页面计入 unidentified_pages，不把这种情况当作邮件检测正常。

响应必须包含：

```json
{"ok":true,"protocol_version":2,"account":"plugin-001","device_id":"中央分配的稳定插件 ID"}
```

服务器通过令牌确定身份并核对请求中的 account / device_id；插件也核对响应中的身份。可返回 `challenge:{id,nonce,expires_at}`，插件在下一次新心跳回传。中央验证挑战、序号、安装和会话后才更新在线时间；客户端时钟和旧心跳补传不能刷新在线证据。

插件约每 30 秒生成心跳，失败指数退避，尊重 Retry-After。中央可从 90 秒过期、3 分钟失联开始配置独立检测任务；应给延迟容差，不能把浏览器关闭、电脑休眠和断网都断言为同一种原因。没有网页状态界面，不影响后台报告这些事实。

## 4. 邮件事件

请求：`protocol_version,account,device_id,installation_id,events`，每批最多 50 项。

每项包括 `event_id,id,mailboxId,provider,email,kind,subject,category,confidence,sender,sourceId,sourceRevision,identityKind,receivedAt,detectedAt,attempts`。不含店铺名、密码、令牌或正文。`confidence=display_name` 表示弱分类候选；`receivedAt=null` 表示无法确认邮件到达时间。

持久化确认：

```json
{
  "ok": true,
  "protocol_version": 2,
  "account": "plugin-001",
  "device_id": "中央分配的稳定插件 ID",
  "acknowledged_event_ids": ["已持久入库的 event_id"]
}
```

插件只完成明确确认且身份一致的事件；其他记录保持原编号重试。中央将事件和飞书通知队列在同一事务中写入。传输幂等用设备及 event_id；跨实例业务去重用规范化邮箱、provider、逐邮件 sourceId 或后备 sourceRevision。后备网页特征不能保证绝对去重。

队列与服务器地址、专用账户、稳定 device_id 关联。切换凭证不会把旧事件交给新插件身份；重新使用相同身份可继续原队列。

## 5. 退出与停用

logout 请求：`protocol_version,account,device_id,installation_id`，中央撤销当前会话令牌后按同一身份格式返回成功。网络失败时，插件仍立即在本地清除令牌并停止采集，中央通过心跳超时发现离线。服务器应设置令牌期限，支持管理员停用及撤销。

HTTP 401 / 403 会使插件停止采集并要求重新输入专用凭证。服务端错误正文不直接显示，避免回显敏感信息。

## 边界

心跳证明最近有持有专用凭证的实例与中央通信，不是硬件证明或无漏报保证。网页元数据检查、插件在线和飞书送达需要在中央分别记录。当前版本不发送端到端测试邮件，也没有 Graph / Gmail API OAuth。
