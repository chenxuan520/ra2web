# AI 连续迭代证据索引

本目录保存便于直接在仓库阅读的小型证据，配合[版本提升文档](../ai-iterations.md)与[逐候选审计](../ai-iterations-attempts.md)。

| 文件 | 含义 |
| --- | --- |
| `index.json` | 当前验收进度、冻结源码指纹、直接对手、每个候选的测试与国别结果，以及原始报告 SHA256 |
| `matches.csv` | 所有已经完成并核验的编号候选，每局一行，包含国家／种子／换边／原生结果／结束 tick／错误和损耗 |
| `v1-report.json` 等 | 已验收版本的完整八局核验报告，原样复制，不改赛果 |
| `v0-history-report.json` | 本次起点对旧主仓库 HEAD 的历史报告，不作为新的后继版本 |
| `t*-diagnosis-*.json` | 已通过报告／采样复核的只读诊断或候选对照摘要；复读不计新胜局，各报告明确观察范围 |
| `SHA256SUMS` | 本目录生成证据文件的字节校验和；运行 `sha256sum -c SHA256SUMS` 复核 |

这些数据来自以下本机实验根目录：

```text
/data00/home/lingchen.judy/.local/state/opencode2/tmp/opencode/ra2web-ai-10-generations-20261103/
```

完整比赛 JSON、原始日志、测试日志、机制 fixture、只读重放与源码副本保留在那里。本目录不是全部原始遥测的副本，也没有资源包、依赖、构建产物、账号或凭证。其他机器不能仅凭这个本机路径访问完整原始证据。

`sync-docs.ts` 从已核验的 `plan.json` 和报告生成本目录及主文档的两个标记统计区块；其余手写说明不会被覆盖。后续每次 `verify-iteration.ts` 完成后同步统计，新增版本的具体提升说明仍按实际改动与遥测追加。

未冻结或未完成对战的候选保留缺失数据，不能用 0 代替未知，也不会虚构八局记录。机制 fixture、诊断重放和停止的错误启动不进入 `matches.csv`。
