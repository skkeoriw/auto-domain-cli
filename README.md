# auto-domain

把本地端口映射成可公开访问的 Cloudflare 域名，基于 WebSocket 反向隧道，无需服务器。

## 快速开始

```bash
bash <(curl -fsSL https://skill.vyibc.com/auto-domain.sh) \
  --port=3000 --name=myapp --daemon
```

成功后输出：

```text
Tunnel is live!
   Public URL : https://myapp.chxyka.ccwu.cc
   Forwarding : https://myapp.chxyka.ccwu.cc -> http://localhost:3000
   Logs       : tail -f ~/.auto-domain/agent.log
   Stop       : bash <(curl -fsSL https://skill.vyibc.com/auto-domain.sh) --stop
```

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--port` | 是 | 本地端口 |
| `--name` | 否 | 子域名（如 `myapp` -> `myapp.chxyka.ccwu.cc`） |
| `--token` | 否 | 兼容旧配置；服务端启用 token 时才需要 |
| `--metadata` | 否 | JSON 字符串，写入 tunnel-admin 的 metadata，用于标记 SOP Runtime 等业务类型 |
| `--daemon` | 是 | 后台运行，打印公网 URL 后退出，Claude/Codex 可读取结果 |
| `--stop` | 否 | 停止后台 agent |
| `--reset` | 否 | 清除本地缓存重新初始化 |
| `--replace` | 否 | 同名 tunnel 已存在时替换旧 agent |
| `--auto-name` | 否 | 服务端自动给名称追加随机后缀，避免重名 |

> 必须使用 `--daemon`：不加此参数脚本会阻塞，Agent 收不到 URL 反馈。

## 停止隧道

```bash
bash <(curl -fsSL https://skill.vyibc.com/auto-domain.sh) --stop
```

## 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| `invalid token` | 服务端启用了 token，但当前 token 不存在或已失效 | 联系管理员重新申请，或检查本地 `~/.auto-domain/config` |
| `subdomain already in use` | 该子域名正被其他隧道占用 | 换一个 `--name`，或加 `--auto-name` |
| Timed out | 连接超时 | 检查 `tail -f ~/.auto-domain/agent.log` |

## 安装为 Claude Code Skill

```bash
bash <(curl -fsSL https://skill.vyibc.com/install-auto-domain.sh)
```

安装后 Claude 会在用户说“暴露本地服务”、“内网穿透”、“给端口分配公网域名”等时自动触发。

安装完成后执行：

```bash
~/.claude/skills/auto-domain/scripts/run.sh --port=3000 --name=myapp --daemon
```

## 仓库结构

```text
README.md
agent/
  agent.js          # Agent 本体（WebSocket 客户端 + 心跳）
  package.json
scripts/
  auto-domain.sh        # CLI 直接执行入口（同步到 skill.vyibc.com）
  install-auto-domain.sh
  publish-auto-domain.sh
  publish-skill.sh      # 维护者发布脚本
  upload-file.sh
skills/
  auto-domain/
    SKILL.md            # Claude Code skill 定义
    scripts/run.sh      # skill 执行脚本（与 auto-domain.sh 同步）
    agent/agent.js      # skill 内置 agent
    agent/package.json
```

## 维护者发布流程

客户端源文件维护在：

https://github.com/ChangfengHU/cloudflare-youtube-pipeline/tree/main/auto-domain-tunnel

不要直接修改 `auto-domain-cli` 里的客户端脚本或 README。客户端仓库是发布结果，源头在服务端项目 `cloudflare-youtube-pipeline/auto-domain-tunnel`。需要调整安装命令、运行脚本、agent 逻辑或本文档时，应先修改服务端项目，再通过 GitHub Action 同步到 `auto-domain-cli` 和 R2/CDN。

修改 `auto-domain-tunnel/auto-domain.sh`、`auto-domain-tunnel/agent/agent.js` 或 `auto-domain-tunnel/client/README.md` 后，推送到 `main` 会触发 GitHub Action：

- 同步 `agent.js` 到 `auto-domain-cli/agent/agent.js`
- 同步 `agent.js` 到 `auto-domain-cli/skills/auto-domain/agent/agent.js`
- 同步 `auto-domain.sh` 到 `auto-domain-cli/skills/auto-domain/scripts/run.sh`
- 同步 `client/README.md` 到 `auto-domain-cli/README.md`
- 上传 `agent.js` 和 `auto-domain.sh` 到 R2/CDN

手动同步也可以在 `cloudflare-youtube-pipeline/auto-domain-tunnel/` 目录执行：

```bash
bash sync-client.sh \
  --token=GITHUB_PAT \
  --cf-key=CF_API_KEY \
  --cf-email=CF_EMAIL
```

## 服务端

Worker 代码维护在：https://github.com/ChangfengHU/cloudflare-youtube-pipeline/tree/main/auto-domain-tunnel

## DNS 说明

- Agent 连接：`wss://tunnel-api.chxyka.ccwu.cc`
- 公网访问：`*.chxyka.ccwu.cc`
