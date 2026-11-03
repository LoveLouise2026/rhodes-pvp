# Ubuntu 24.04 · 公网 IP 部署

这份说明针对单台服务器、朋友间内测。浏览器网页与 WebSocket 使用同一个端口，不需要额外架设网站前端或数据库。

## 1. 安装 Docker（已安装可跳过）

下面使用 Docker 官方 Ubuntu 软件源。若机器已有 Docker 或其他容器环境，先运行 `docker --version` 和 `docker compose version`；已有可用环境就不必重装。

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
```

若安装提示旧 containerd/docker.io 冲突，按[官方安装说明](https://docs.docker.com/engine/install/ubuntu/)处理现有环境后再继续；不要直接删除已有服务或数据。

## 2. 上传并启动

把本次修复后的源码 ZIP 上传到服务器，并解压到自己的项目目录，例如 `~/ntcg`。ZIP 必须包含 Dockerfile、compose.yaml 与 rhodes-pvp-v98，进入它们所在的同一目录。

```bash
sudo apt install -y unzip
mkdir -p ~/ntcg
unzip ntcg-linux-ready.zip -d ~/ntcg
cd ~/ntcg
sudo docker compose up -d --build
sudo docker compose ps
curl -fsS http://127.0.0.1:3000/health
```

包名以实际下载的名称为准。首次构建需从 Docker Hub 和 npm 下载依赖；如果网络无法访问这些服务，需要先解决服务器的下载连通性。

若已把修复代码同步到 GitHub，也可以用已有的 GitHub SSH 密钥拉取对应分支再运行 Compose。不要把密码或访问令牌写在 clone URL 中。本次本地修复包不意味着远端 main 已更新。

## 3. 开放访问

在服务器供应商控制台的安全组/防火墙中，添加入站 TCP 3000。然后在自己的电脑打开：

```text
http://你的服务器公网IP:3000
```

若启用了 UFW，可按自己的访问范围添加规则，例如 `sudo ufw allow 3000/tcp`。Docker 的端口发布可能绕过 UFW 的常规规则，**实际入站限制以云安全组和 Docker 防火墙链为准**，不要只依赖 UFW。不要关闭整台机器的防火墙。

如果 3000 已被占用，在项目根目录创建 `.env`，内容例如 `PUBLISHED_PORT=8080`，再运行 `sudo docker compose up -d`，开放 TCP 8080，并改用 `http://IP:8080`。不要改容器内端口。

需要直接 `http://IP`（无端口）且 80 空闲时，可设 `PUBLISHED_PORT=80` 并开放 TCP 80。

## 4. 运行、更新与排障

```bash
# 查看运行状态和日志
sudo docker compose ps
sudo docker compose logs --tail=100 game

# 重启；当前对局会中断
sudo docker compose restart game

# 更新源码后重建；当前对局会中断
sudo docker compose up -d --build

# 停止
sudo docker compose down
```

容器配置了随 Docker 启动、失败重启、健康检查及日志轮转。健康状态异常时先看日志；Docker 自身不会只因为 unhealthy 自动重启容器。

服务器本机 health 正常但外部打不开：检查公网 IP、安全组、映射端口，以及服务器供应商是否限制入站 HTTP。页面打开但显示离线：检查浏览器控制台；任何外加代理都必须支持 `/ws` WebSocket 升级。

启动报 EADDRINUSE：改 `.env` 的 PUBLISHED_PORT，避免占用其他网站。

## 5. 不使用 Docker 的可选方式

自行安装官方支持的 Node.js 24 后：

```bash
cd ~/ntcg/rhodes-pvp-v98
npm ci --omit=dev --ignore-scripts
HOST=0.0.0.0 PORT=3000 node server.js
```

这适合先前台确认能启动，正式常驻需用 systemd 管理。可参考 `deploy/ntcg.service`：替换 User 与 WorkingDirectory，确认 ExecStart 指向 `command -v node` 返回的绝对路径，再安装为系统服务。Docker 方案已包含常驻管理，二者选一个。

## 6. 数据与验证范围

卡组、昵称会话及本地录像在玩家浏览器中；对局在服务器内存中。当前没有数据库或服务器账户，也没有跨重启恢复。先在无其他重要业务的目录部署，更新前通知正在玩的朋友。

本地 Windows 已通过规则回归、卡池验证、客户端语法和真实双 WebSocket 流程测试；网页已验证昵称、默认卡组、创建房间。Docker 引擎在本机未运行，尚未实测 Linux 镜像运行；部署后需完成以下验收：容器 healthy、外网两端可进同房、调度/部署/攻击/换回合/投降、刷新可恢复当前对局。

参考：[Docker Ubuntu 安装与防火墙说明](https://docs.docker.com/engine/install/ubuntu/)、[Node.js 支持版本](https://nodejs.org/en/about/previous-releases)。
