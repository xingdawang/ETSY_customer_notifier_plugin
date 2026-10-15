# 插件中央协议 v1（客户端已实现，服务器待接入）

所有接口位于用户配置的 `server_base/api/extension/v1/`，使用 POST JSON。必须返回有效 HTTP 成功码及 `{"ok":true,"protocol_version":1,...}`。重定向不跟随；请求超时 7 秒；除 enroll 外使用 `Authorization: Bearer <设备令牌>`，不使用网站会话 Cookie。

## enroll

输入：`protocol_version, pairing_code, device_id, device_name, extension_version`。

返回：`ok, protocol_version, access_token, server_id`。`server_id` 为服务器身份的稳定标识。

服务器负责：管理员生成有期限的一次性配对码，校验用户与设备权限、消费配对码、限制可访问邮箱、颁发可吊销的设备令牌、限流及审计。邮箱 ID 是浏览器本地 UUID，服务器必须按设备归属校验，不能仅凭客户端报告的邮箱地址授权。

## heartbeat

输入包括：

```json
{
  "protocol_version": 1,
  "device_id": "UUID",
  "session_id": "本次 worker 生命周期的随机编号",
  "sequence": 12,
  "extension_version": "0.1.0",
  "device_name": "工作室 · Edge",
  "sent_at": "2026-10-15T12:00:00Z",
  "previous_challenge": null,
  "mailboxes": [{
    "mailbox_id": "本地邮箱 UUID",
    "provider": "outlook",
    "email": "shop@outlook.com",
    "shop": "店铺名",
    "enabled": true,
    "status": "limited",
    "last_scan_at": 1792065600000,
    "coverage": "visible_rows",
    "last_verified_at": null,
    "open_tab_count": 1
  }]
}
```

`status` 可能为 `watching, limited, initializing, paused, closed, stale, unavailable, sleeping, loading, login_required, identity_unknown, account_mismatch, wrong_folder, view_unavailable`。`watching` 也仅代表当前已渲染页面可读，不能据此声称全部收信正常。

返回可选 `challenge: {id,nonce,expires_at}`；插件在下一次新生成的心跳回传。服务器需要先验证挑战新鲜度、序号和会话，再更新存活时间，不能把旧请求的接收时间当作新的健康证据。新会话需按有效设备凭证建立挑战，不能简单永久拒绝新的 worker 会话。

每次心跳现生成；失败后不会重放旧心跳。临时失败按 30 秒起的指数退避，最长约 15 分钟，并遵守更长的 `Retry-After`；手动同步可主动重试。HTTP 401 / 403 停止自动续试并要求重新配对。

建议服务器将传输在线与扫描新鲜度分开计算；90 秒过期、3 分钟失联可作为起始参数。独立定时器发现所有可用采集实例失联时才发邮箱级告警；同类故障合并，恢复后解除。仅有浏览器页面上的 JavaScript 计时器不能实现这个功能。

## events

输入：`protocol_version, device_id, events`。每批最多 50 项。每项包含稳定 `event_id`（也保留 `id`）、`mailboxId,provider,email,shop,kind,subject,detectedAt` 等必要元数据。

买家消息：`kind=buyer_message`，附 `category,sender,confidence,identityKind,receivedAt`。`confidence=display_name` 只表示名称加主题的弱分类。时间未知时 `receivedAt=null`，不可用检测时间伪装收信时间。

事件还包含 `sourceId` 与 `sourceRevision`（规范化邮件身份或修订信息的 SHA-256），用于中央跨实例去重。客户端的 `event_id` 包含本地邮箱 UUID，不可用作唯一的跨电脑标识。

服务器持久化、完成设备和邮箱权限校验及幂等入库后返回：

```json
{"ok":true,"protocol_version":1,"acknowledged_event_ids":["已持久化的 event_id"]}
```

未确认的记录保持 pending，并沿用同一 ID 重试。未知确认 ID 忽略。服务器应在同一事务中写事件和通知队列。传输重试按设备 / 邮箱归属及事件 ID 幂等；跨实例业务去重按规范化邮箱身份、provider 和 sourceId（逐邮件标识时）或 sourceRevision（后备特征时）处理。后备特征仍可能碰撞或漏分辨，不能承诺网页模式下跨设备绝对去重。

已上报只表示中央接收；飞书发送、限流、结果不确定及重试由服务器单独处理。不要把同一主题视为同一封邮件。

## 测试邮件验证

心跳返回可选：

```json
{
  "verification_requests": [{
    "id": "request_123",
    "mailbox_id": "本地邮箱 UUID",
    "sender": "verify@example.com",
    "expires_at": "2026-10-15T12:10:00Z"
  }]
}
```

请求 ID 仅含字母、数字、下划线和连字符，最长 64 字符。服务器通过独立发信端发送主题：

```text
[Etsy Sentinel Verify:request_123] 至少16位的随机字母数字下划线或连字符
```

**随机码不出现在 verification_requests 或其他下发指令中。** 插件必须从当前账号匹配的可读列表中识别主题和真实发件地址，通过 events 上报 `kind=verification, requestId, code`。不发桌面买家提醒。

服务器核对邮箱、随机码、TTL 和一次性使用后，在之后心跳返回：

```json
{"verification_results":[{"request_id":"request_123","mailbox_id":"本地邮箱 UUID","verified":true}]}
```

插件只在对应验证事件已经被确认上传、且中央明确确认时显示验证时间。服务器应重复返回确认结果，直到邮箱心跳的 `last_verification_id` 回传对应请求 ID，避免确认结果因一次超时丢失。未收到、未通过或超时不自动视为成功。系统验证证明当时检测链路可用，不能代替 Etsy 业务邮件分类测试。

## 接入限制

当前版本没有服务器实现，没有邮件 API OAuth，也没有中央飞书发送改造。设备凭证不是硬件认证；邮箱 DOM 身份也不是服务商签发的账号证明。授权员工、网站管理员和设备之间的边界应在后续服务端实现中落实。
