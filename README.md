# ra2web

红色警戒 2 网页项目，包含 TypeScript 游戏客户端、Bun 联机网关和 PvPGN 服务端，支持通过 Docker Compose 一起部署。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `ts-redalert2/` | React、TypeScript、Three.js 客户端及 Bun 联机网关 |
| `pvpgn-server/` | PvPGN 服务端源码 |
| `deploy/` | 容器启动和健康检查脚本 |
| `Dockerfile`、`compose.yaml` | 完整服务的构建与部署配置 |

## 初始化开发环境

安装 [Bun](https://bun.sh/) 1.3+；Docker 构建当前使用 Bun 1.3.14。

```bash
git clone https://github.com/chenxuan520/ra2web.git
cd ra2web/ts-redalert2
bun install --frozen-lockfile
bun run dev:bun
```

开发服务器地址为 `https://localhost:4000`，本地开发证书由 Vite 自动生成。游戏资源可在页面中导入。

在 `ts-redalert2/` 下运行检查和构建：

```bash
bun run typecheck:entry
bun run typecheck:server
bun test
bun run build
```

部分资源测试和 PvPGN 集成测试需要额外资源或已安装的 PvPGN；缺少前置条件时会跳过。完整说明见 [客户端文档](ts-redalert2/README.md)。

## Docker 联机部署

安装 Docker Engine 和 Compose 插件，在仓库根目录执行：

```bash
docker compose up -d --build
docker compose logs -f game
```

服务地址为 `http://localhost:8080`。首次启动默认下载并校验游戏资源，账号和资源缓存保存在 `game-data` 卷。

也可将游戏副本中的 `ra2.mix`、`language.mix`、`multi.mix` 放入根目录的 `game-files/`，关闭自动下载后启动：

```bash
RA2WEB_AUTO_DOWNLOAD_ASSETS=false docker compose up -d --build
```

Compose 可通过环境变量配置：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `RA2WEB_BIND` | `0.0.0.0` | 绑定地址 |
| `RA2WEB_PORT` | `8080` | 对外端口 |
| `RA2WEB_AUTO_DOWNLOAD_ASSETS` | `true` | 是否自动下载游戏资源 |
| `RA2WEB_PUBLIC_ORIGIN` | 空 | 反向代理部署时浏览器访问的 HTTPS Origin |

公网部署需要 HTTPS/WSS，反向代理需支持 `/ws` WebSocket 升级并保留 COOP/COEP 响应头。更多联机说明见 [客户端文档](ts-redalert2/README.md#docker-联机部署)。

## 提交修改

默认分支为 `master`。建议在工作分支提交修改后发起 Pull Request：

```bash
git switch -c feature/my-change
git add <修改的文件>
git commit -m "Describe the change"
git push -u origin feature/my-change
```

## 许可与资源说明

客户端的权利声明见 [客户端 README](ts-redalert2/README.md) 和 [客户端 LICENSE](ts-redalert2/LICENSE)；PvPGN 的许可见 [PvPGN LICENSE](pvpgn-server/LICENSE)。游戏资源的使用须遵循相应许可。
