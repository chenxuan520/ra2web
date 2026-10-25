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

协作与验证约定见 [AGENTS.md](AGENTS.md)。

默认分支为 `master`。建议在工作分支提交修改后发起 Pull Request：

```bash
git switch -c feature/my-change
git add <修改的文件>
git commit -m "Describe the change"
git push -u origin feature/my-change
```

## AI 难度与策略

在遭遇战大厅的电脑玩家下拉菜单中选择 **AI-冷酷**，启用最高难度内置策略；选择会随大厅设置保存。普通难度继续使用内置 AI，简单难度保留训练靶机行为。

冷酷 AI 的增强包括：

- 按已观察到的空军和防御工事调整坦克、防空、炮兵配比，早期组织小队施压，经济成熟后扩大进攻波次。
- 矿车损失后自动补产，低资金时优先保障高优先级生产；这些经济故障修复也适用于普通 AI。
- 每个单位独立搜索附近目标，按武器与装甲匹配、威胁、剩余生命分配集火，减少对同一目标的过量火力。
- 残血单位尝试撤离；具备射程优势且武器处于冷却时尝试拉扯，避免打断正在进行的攻击。
- 提前防守矿厂和兵工厂，抑制重复命令，并对因阻塞而空闲的单位重试命令。

决策使用模拟 tick，普通每 3 tick、冷酷每 2 tick 更新；冷酷小队战术每 6 tick 更新。通过现有游戏 API 生产和下达命令，本次改动没有增加金钱或伤害加成。

AI 专项回归命令（在 `ts-redalert2/` 下运行）：

```bash
bun test src/test/BrutalAiIntegration.test.ts src/test/BuiltInAiRuntime.test.ts src/test/BuiltInCombatMicro.test.ts src/test/ai/ProductionStrategy.test.ts
```

这些测试覆盖难度接入、经济恢复、兵种选择、集火和命令行为，不代表真人对战胜率。实战评估应固定地图、阵营、初始资金和游戏版本，分别验证快攻、空袭、矿车骚扰和阵地战；尚未建立“人类无法获胜”的对局证据。

## 许可与资源说明

客户端的权利声明见 [客户端 README](ts-redalert2/README.md) 和 [客户端 LICENSE](ts-redalert2/LICENSE)；PvPGN 的许可见 [PvPGN LICENSE](pvpgn-server/LICENSE)。游戏资源的使用须遵循相应许可。
