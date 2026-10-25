# AI 持续验证

工作流：`.github/workflows/ai.yml`，GitHub Actions 中显示为 **AI validation**。

新打法迭代先依照[原版调研](ai-vanilla-strategy-research.md)和[测评协议](ai-vanilla-evaluation-protocol.md)。C18对原始14、04、0a三轮各432局均已完整核验，见[最新基线报告](ai-breakthrough-evaluation.md)。这些是新打法研究前的成绩。

首次完整运行 [40176058250](https://github.com/chenxuan520/ra2web/actions/runs/40176058250) 已全部通过，候选固定为含工程师策略的 `0a46d52`：432局140胜132负160平，零运行错误。三个原始分组经本地独立重算，与CI发布报告一致。[完整国家矩阵及实际使用情况](ai-ci-country-evaluation.md)已归档；CI绿色表示功能和数据完整性通过，本批新增工程师策略没有改变任何对局的胜负平结果。

## PR 和 master 提交

相关源码、测试、资源准备或工作流修改会触发：

1. 使用 Bun 1.3.14 和已提交的锁文件安装依赖。
2. 下载并校验项目部署所用资源包，缓存准备后的 CDN。校验值固定为 `541828fa48f31059eb5edb127b07253515c8f92adeaa1f0fd0b84d6ffa6656f3`。
3. 运行完整 Bun 回归、入口/服务端/基准类型检查及构建。
4. 运行真实引擎的辐射、巨炮、坦克、伞兵、分兵和工程师偷建筑机制场景。
5. 用当前提交对冻结旧版跑四局短烟测，检查完整加载、更新和换边流程。

工程师机制场景预置了军队和建筑，检查实际 Capture 命令与引擎所有权变化，以及已知守军阻止行动。它不代替正常资金的对局胜率。真实 PvPGN 和额外 HTTP 资源合约测试仍按各自前置条件运行或跳过。

## 完整国家矩阵

每周一 **03:00 UTC** 自动运行，也可在 Actions 页面选择 Run workflow，或执行：

```bash
gh workflow run ai.yml --repo chenxuan520/ra2web \
  -f full_matrix=true -f baseline_ref=04a9f7a
```

候选默认固定为触发工作流的提交，也可通过 `candidate_ref` 指定冻结 Bot；引擎和 runner 仍来自工作流提交并记录各自版本与源码摘要。旧版默认固定为 `04a9f7a`，`baseline_profile` 默认为 `brutal`。对升级前原始 Bot `14ffd36` 应明确使用 `normal`，保留其原始策略。完整赛程按三张地图并行，每张地图144局，合计432局：

`evaluation_set`默认`regression`，保持下表旧种子；可选`development`与`qualification_a/b/c`，具体种子在[计划JSON](ai-vanilla-evaluation-plan.json)预注册。每次run仍为432局；三组资格档案经[配对比较器](../.github/scripts/compare-ai-evaluations.py)合并为每个Bot对每个对手1296局。查看资格结果后继续改参须退役这组种子；不能把多个候选混成同一组。`full_matrix=false`只做回归与短烟测，不是战力验证。

```bash
# 同一冻结候选直接对原始 Bot；不要用后续冻结旧版的胜率代替此结果。
gh workflow run ai.yml --repo chenxuan520/ra2web --ref validation/ai-adaptive-opening-original \
  -f full_matrix=true -f candidate_ref=c18f77650e40b668064bdb913a75bebfa278f42b \
  -f baseline_ref=14ffd3613663a0e1a373593922e0f5e1c5f20f40 -f baseline_profile=normal
```

| 分组 | 地图 | 种子 | 每局上限 |
| --- | --- | ---: | ---: |
| short | mp08t2 | 10111 | 27000 tick |
| medium | tn01t2 | 20222 | 27000 tick |
| long | mp11t2 | 30333 | 27000 tick |

9国分别对其余8国，每组配置交换出生点和玩家槽位，每个国家配对共6局，每个候选国家48局。双方使用相同10000初始资金、零额外初始部队和 Normal 游戏加成；候选策略为 brutal，对手策略由 `baseline_profile` 明确记录。策略选项不改变引擎经济和战斗加成。达到上限记平局，运行异常单列。

## 结果与失败处理

- `ai-regression`：机制场景和短烟测记录。
- `ai-country-short`、`ai-country-medium`、`ai-country-long`：固定配置、逐局遥测、日志及哈希校验凭据。
- `ai-country-report`：汇总后的 `report.md`、`matrix.csv` 和 `results.json`，并显示在工作流 Summary 中。

原始分组和回归 artifacts 保留14天，汇总报告保留30天。上述首次赛程的CSV、精简逐局遥测、配置与原始报告哈希索引已提交到 `docs/ai-ci-country-*`，供 artifacts 到期后复核摘要；它们不代替完整原始采样。

汇总器要求三个分组的候选、旧版、引擎和资源一致，检查原始报告哈希、432个唯一对局，以及每个国家配对的6局；缺局、重复、混版本或运行错误会使验证失败。21项Python回归覆盖原有报告完整性、事件归属、国家/地图门槛，以及新增同对手配对比较、地图/种子关联、样本不足、篡改和饱和对手不退步检查。

主胜率为 `胜/(胜+负+平)`。完整矩阵的 report job 还要求总胜率至少80%、每国及每张地图至少70%。功能回归和战力验收分开：真实完整的对局达不到战力门槛时，保留全部结果、工作流摘要及 `strength-assessment.json` 后失败。错误、缺局和超时不能改算为胜局，也不能删除弱国或弱图。旧记录40176058250及中间候选40189995518/40189997547运行的是加入门槛之前的工作流，绿色不代表满足这些胜率要求。机制测试通过也不能证明人类无法获胜。

资源缓存只用于执行环境；上传的 artifacts 包含测试与对战证据。原有资源准备方式和本地复现命令见 [AI 实战基准](../ts-redalert2/e2e/README-ai.md)。
