# AI 实战基准

使用真实 `GameFactory`、`Game.update()`、官方地图和地形数据推进对局；省略浏览器渲染和音频。采矿、生产、视野、寻路、武器伤害和胜负判断均由原游戏引擎执行。

## 准备

需要 Bun、完整 Git 历史以及已经准备好的游戏资源。资源不提交到仓库，准备方式与正常部署一致：

```bash
# 在 ts-redalert2/ 下执行，将合法来源的资源目录转换为本地 CDN。
bun deploy/prepare-resources.ts /path/to/game-files ../.cache/ai-resources/cdn
```

CDN 目录须包含 `maps/` 和 `game-res/v2/`。基准默认读取上述位置，也可使用 `--cdn PATH` 或 `RA2_BENCHMARK_CDN`。

## 固定版本对战

```bash
# 与升级前的仓库 Bot 比较，默认自动交换双方出生点和玩家槽位。
bun run test:ai --candidate-ref 04a9f7a --baseline-ref 14ffd36 \
  --map mp08t2,tn01t2 --seeds 101,202 \
  --matchups Americans:Americans,Russians:Russians \
  --max-ticks 18000 --out .artifacts/ai-benchmark/round4.json

# 与上一轮有效候选比较，两边都使用 brutal 策略。
bun run test:ai --candidate-ref 04a9f7a --baseline-ref 8fc9fc6 \
  --candidate-profile brutal --baseline-profile brutal \
  --map mp08t2,tn01t2 --seeds 101,202 \
  --matchups Americans:Americans,Russians:Russians \
  --max-ticks 18000 --out .artifacts/ai-benchmark/round4-vs-round2.json

# 校验基准：相同版本、相同策略自对打。
bun run test:ai --candidate-ref 3497729 --baseline-ref 3497729 \
  --candidate-profile brutal --baseline-profile brutal \
  --map mp08t2 --seeds 101 --matchups Americans:Americans \
  --out .artifacts/ai-benchmark/selfplay.json
```

每轮候选应先提交为独立 Git 版本，再与旧版和上一轮分别比较。`--candidate-ref working-tree` 用于调试，报告会记录已跟踪 AI 代码的未提交 diff 摘要；正式报告优先使用不可变提交。

## 公平性与结果

- 两边均使用 `AiDifficulty.Normal` 的游戏规则、相同初始资金和单位数。`--candidate-profile`、`--baseline-profile` 只选择 Bot 策略。
- 每个配置默认运行两局，交换出生点和玩家槽位；这也轮换更新顺序及共享随机数调用顺序。所有结果数组保持 `[candidate, baseline]` 顺序。
- Git 快照保留历史 Bot 的策略、生产和兜底逻辑，仅将引擎 API 与适配器外部导入重定向到同一当前引擎。
- `candidate-win` / `baseline-win` 必须由引擎胜负条件产生；达到 tick 上限是 `draw`，不是按资产估算的胜利。运行错误单独记为 `error`。
- 报告包括提交、规则及地图哈希、种子、胜负、采样经济/军队/队列/任务、伤害、战损、动作和错误记录。入账数值含退款、出售等来源，不能直接解释成纯采矿收入。
- `18000` tick 为 20 分钟模拟时间，实际运行时间取决于地图和机器。修改上限会改变平局比例，应在对照组保持一致。

先检验同版本自对打是否按换边镜像，再看不同版本胜/平/负与产能、战损。单个种子、单一地图或只有低资金时间改善，都不足以证明普遍胜率提升。

已完成的对战与局限见 [评估报告](../../docs/ai-evaluation.md)，策略来源见 [研究记录](../../docs/ai-research.md)。完整参数使用 `bun run test:ai --help` 查看。

## 全国家交叉赛程

`ai-tournament.ts` 默认安排 9 国分别对其余 8 国：每组使用三个地图/种子配置，每个配置交换出生点与玩家槽位，共 216 个成对任务、432 局。双方默认使用 brutal 策略与相同的 Normal 游戏加成、10000 初始资金。每局限时 27000 tick（30 模拟分钟），超时记平局。

```bash
# 固定候选与上一稳定版。默认包含所有国家；可先 --dry-run 检查赛程。
bun e2e/ai-tournament.ts --candidate-ref 39679b2 --baseline-ref 04a9f7a \
  --scenarios mp08t2:10111,tn01t2:20222,mp11t2:30333 \
  --concurrency 4 --out .artifacts/ai-tournament/national-v3

# 同一代码、资源、选项和目录下续跑；已完成对局不重复统计。
bun e2e/ai-tournament.ts --candidate-ref 39679b2 --baseline-ref 04a9f7a \
  --scenarios mp08t2:10111,tn01t2:20222,mp11t2:30333 \
  --concurrency 4 --out .artifacts/ai-tournament/national-v3 --resume
```

默认配置为 `mp08t2:1011,tn01t2:2022,mp11t2:3033`。每个国家配对有 6 局，每个候选国家共 48 局；这不是每张地图再分别跑三个种子。前两张地图用于开发过，最终第三版命令另用 `10111/20222/30333`，避免复用第二版开发赛程种子。

`manifest.json` 冻结提交、引擎/runner/规则/资源摘要与赛程；`jobs/` 保留每个成对任务的完整遥测、日志和校验凭据；`summary.json` 输出逐国家矩阵。主胜率为 `胜 / (胜+负+平)`，错误数另列；决胜局胜率 `胜 / (胜+负)` 仅作补充。国家胜率表示新 Bot 使用该国对上一版其他国家的结果，不能直接当作国家强弱排行。

运行期间不要提交或修改引擎、Bot API shim、runner。续跑会核对版本与资源；更换版本应使用新目录。`--resume --retry-errors` 会先归档错误任务的原始报告与日志，再重跑对应配对；归档尝试不重复计入最终矩阵。

## 特色机制与分兵场景

```bash
bun e2e/ai-specialty-scenarios.ts --repeat 2
bun e2e/ai-harassment-scenario.ts
```

这些场景使用真实引擎验证辐射展开/友军避让/残留区、巨炮、坦克冷却撤退、美国伞兵，以及已有军队分兵与受袭回防。场景会预置单位；伞兵场景还缩短充能，因此只能证明机制和控制器行为。正常经济下是否造出特色单位、是否有战力收益，须看完整对局遥测。国家特色研究见 [资料与实际规则核对](../../docs/ai-national-research.md)。

工程师偷建筑场景使用实际 `SneakCaptureMissionFactory`、`MissionController` 和引擎 Capture 命令，核对所有权真实变化及已知守军阻止行动：

```bash
bun e2e/ai-sneak-capture-scenario.ts
```

CI 入口、触发方式和报告下载见 [AI 持续验证](../../docs/ai-ci.md)。恢复历史赛程须使用原提交及相同资源；可放到固定提交的独立 worktree 中后台续跑，让主工作目录继续开发。
