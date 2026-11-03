# Rhodes PVP v98

v98 基于 v97 继续联机服务器权威化，重点修复身份、猜拳重复开战、部署/攻击规则、基地生命结算与客户端状态覆盖问题，并恢复攻击/基地生命的服务器结果驱动动画。

## 启动

```powershell
npm.cmd install
npm.cmd start
```

浏览器打开 `http://localhost:3000`。公网测试仍可使用：

```powershell
cloudflared tunnel --url http://localhost:3000
```

## v98 重点

- 重连需要服务器生成的 reconnect token；战斗操作身份只取当前 WebSocket 绑定身份。
- 猜拳增加锁，重复消息不能重复安排开战。
- Lv1 基地不能部署 Lv3 干员。
- `cannotAttack`、刚部署禁攻、同回合重复攻击均由服务器校验。
- 基地生命为 0 后再次受到合法直击，由服务器判定败北。
- 调度完成与 battle begin 分开发送，避免最后一次调度动画被覆盖。
- 客户端拒绝旧 revision / 错误 gameId 快照，避免旧状态反写。
- 攻击与基地生命翻牌由服务器结果驱动视觉动画。
- 投降继续由服务器权威判定。

## 检查

```powershell
npm.cmd run check
npm.cmd run validate:cards
npm.cmd run test:v98
```

`test:v98` 是无网络依赖的服务器逻辑回归测试。真实双端浏览器动画、重连、Cloudflare 环境仍需人工测试。
