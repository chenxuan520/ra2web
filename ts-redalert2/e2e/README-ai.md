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
