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

已完成的本地432局国家交叉赛程为140胜132负160平、零运行错误；详见[逐国胜率、矩阵与实际触发记录](docs/ai-country-evaluation.md)。该赛程固定在加入工程师策略之前的版本；包含工程师策略的新版本由[独立 CI 赛程](https://github.com/chenxuan520/ra2web/actions/runs/40176058250)评测。

在遭遇战大厅的电脑玩家下拉菜单中选择 **AI-冷酷**，启用最高难度内置策略；选择会随大厅设置保存。普通难度继续使用内置 AI，简单难度保留训练靶机行为。

冷酷 AI 的增强包括：

- 按已观察到的空军和防御工事调整坦克、防空、炮兵配比，早期组织小队施压，经济成熟后扩大进攻波次。
- 矿车损失后自动补产，低资金时优先保障高优先级生产；这些经济故障修复也适用于普通 AI。
- 每个单位独立搜索附近目标，按武器与装甲匹配、威胁、剩余生命分配集火，减少对同一目标的过量火力。
- 残血单位尝试撤离；具备射程优势且武器处于冷却时尝试拉扯，避免打断正在进行的攻击。
- 提前防守矿厂和兵工厂，抑制重复命令，并对因阻塞而空闲的单位重试命令。
- 集结期间保持生产请求，避免坦克尚未造好就解散任务、反复取消订单；换目标时同步更新进攻区域。
- 优先建筑没有合法落点时，尝试其他可建候选，避免一个放不下的重工堵住后续建设。
- 按可见敌军和经济阶段选择伊拉克辐射兵、英国狙击手、德国坦克杀手、苏俄磁能坦克及后期支援；法国在实际地面压力下投资巨炮，美国使用已充能的伞兵支援。
- 辐射部署会评估友军、生产出口和行军通道，收起后仍保留污染记忆；坦克在真实武器冷却窗口撤退，V3保持固定目标与后排职责。
- 兵力有富余时，从已有主力抽出独立经济骚扰队；保留主力核心，基地受袭或遭遇包夹时回防。
- 目标已侦察、路线和入口没有已知火力覆盖时，派工程师夺取敌方基地、重工或矿厂；限制资金投入、同时任务和失败重试，发现危险时返回。

决策使用模拟 tick，普通每 3 tick、冷酷每 2 tick 更新；冷酷小队战术每 6 tick 更新。通过现有游戏 API 生产和下达命令，本次改动没有增加金钱或伤害加成。

AI 专项回归命令（在 `ts-redalert2/` 下运行）：

```bash
bun test src/test/BrutalAiIntegration.test.ts src/test/BuiltInAiRuntime.test.ts src/test/BuiltInCombatMicro.test.ts src/test/ai
```

这些测试覆盖难度接入、经济恢复、兵种选择、集火和命令行为，不代表真人对战胜率。实战评估应固定地图、阵营、初始资金和游戏版本，分别验证快攻、空袭、矿车骚扰和阵地战；尚未建立“人类无法获胜”的对局证据。

已完成的逐轮对照、失败实验和独立种子复测见 [AI 对战评估](docs/ai-evaluation.md)。复现命令见 [AI 实战基准](ts-redalert2/e2e/README-ai.md)，攻略来源与待验证假设见 [AI 策略研究](docs/ai-research.md)。

国家特色、长期战和微操的依据见 [国家策略研究](docs/ai-national-research.md)。全国家对战工具默认安排 432 局，并输出逐国家配对矩阵；各项特色的实际触发次数与战力结论须结合完整对局记录，不能只看配置或机制场景。

[AI 持续验证](docs/ai-ci.md) 已接入 GitHub Actions：PR/master 提交执行回归、真实机制场景与短对局，每周或手动运行完整国家矩阵，自动保存胜率报告、CSV 与逐局战报。机制场景预置军队用于验证行为，不能替代正常经济对战结论。

## 许可与资源说明

客户端的权利声明见 [客户端 README](ts-redalert2/README.md) 和 [客户端 LICENSE](ts-redalert2/LICENSE)；PvPGN 的许可见 [PvPGN LICENSE](pvpgn-server/LICENSE)。游戏资源的使用须遵循相应许可。
