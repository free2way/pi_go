# 192.168.2.235 Pi Docker 部署记录

部署日期：2026-10-03（Asia/Shanghai）

## 部署结果

| 项目 | 值 |
| --- | --- |
| 主机 | `192.168.2.235` |
| 部署目录 | `/app/pi-agent` |
| Compose 项目 | `pi-agent` |
| 容器 | `pi-agent-runtime-1`、`pi-agent-web-1`，真实执行启用后另有 `pi-agent-worker-1` |
| 镜像 | `local/pi-coding-agent:1.0.0`、`local/pigo-web:0.1.0`、`local/pigo-worker:0.1.0` |
| Pi | `1.0.0` |
| Node.js | `22.23.3` |
| 运行用户 | `node`，UID/GID `1000:1000` |
| 独立网络 | `pi-agent-network` |
| 配置卷 | `pi-agent-config`、`pigo-web-data` |
| 工作目录 | `/app/pi-agent/workspace` -> `/workspace` |
| 宿主端口 | WebUI 仅绑定 `127.0.0.1:3100`；Pi runtime 无宿主端口 |
| 公网地址 | `https://pigo.ai2note.com`（Cloudflare Tunnel） |
| Runtime 资源限制 | 2 CPU、4 GiB 内存、512 PID |
| WebUI 资源限制 | 0.5 CPU、512 MiB 内存、128 PID |

容器启用了 `no-new-privileges`、移除全部额外 Linux capabilities，并使用独立网络和配置卷。部署后已验证部署前存在的其他容器全部仍处于运行状态。

## 模型与连通性验证

密钥仅保存在服务器 `/app/pi-agent/.env`，文件权限为 `0600`；源码、镜像和浏览器端均不包含密钥。

| 角色 | Provider | 模型 | 验证结果 |
| --- | --- | --- | --- |
| 开发 Agent | `deepseek` | `deepseek-flash` | 模型清单 HTTP 200；最小生成 HTTP 200 |
| 审核 Agent | `openai-proxy` | `gpt-5.6-sol` | 模型清单可见；最小生成 HTTP 200，返回 `OK` |

审核端点为 OpenAI 兼容接口 `https://pr.ai2note.com/v1`，模型配置位于 Pi 配置卷内的 `/home/node/.pi/agent/models.json`，其中只引用 `$OPENAI_API_KEY`，不保存明文密钥。

## WebUI 与 Cloudflare

- WebUI 健康检查：`http://127.0.0.1:3100/api/health`
- Cloudflare Tunnel：`ai2note-home-192-168-2-235`
- 公网路由：`pigo.ai2note.com` -> `http://localhost:3100`
- Cloudflare 自动创建 CNAME 到 Tunnel
- 已通过 Cloudflare 两个边缘地址验证 HTTPS：HTTP 200，TLS 校验通过
- WebUI 已包含真实 Agent 编排器；启用前必须先完成 Cloudflare Access 登录保护

## 项目与代码保存目录

```text
/app/pi-agent/workspace/
  projects/<项目名>/       # 用户放入或 clone 的源 Git 仓库
  runs/<run-id>/           # 每个真实任务的隔离 Git worktree 和代码结果
```

源仓库必须是干净的 Git 工作区。真实任务不会自动提交、推送或合并；审核通过的代码保留在对应 `runs/<run-id>`，由人工确认后处理。

服务器侧验证：

```bash
cd /app/pi-agent
docker compose ps
curl http://127.0.0.1:3100/api/health
docker compose exec runtime pi --list-models deepseek
docker compose exec runtime pi --list-models openai-proxy
```

## 日常运维

```bash
cd /app/pi-agent

# 状态和健康检查
docker compose --env-file .env ps
docker compose --env-file .env exec -T runtime pi --version
curl http://127.0.0.1:3100/api/health

# 进入 Pi
docker compose --env-file .env exec runtime pi

# 查看日志
docker compose --env-file .env logs --tail=200 runtime web

# 只重启 Pi 或 WebUI
docker compose --env-file .env restart runtime
docker compose --env-file .env restart web

# 停止 Pi；不会删除配置卷
docker compose --env-file .env down
```

不要使用 `docker compose down --volumes`，除非明确要删除 Pi 的登录信息和配置。不要执行宿主机级别的 `docker system prune`，以免影响同机其他应用。
