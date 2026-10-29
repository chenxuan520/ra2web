# L0 侦察目标队列：冻结源码 CI 回归

本轮验证侦察目标队列的两处正确性修复与既有策略兼容性，未测定新战术收益，未发布。候选、共同引擎和工作流均为 `8f295c9c40bd24a4782164a31e668b0754039bd7`；对照为冻结 C18 `c18f77650e40b668064bdb913a75bebfa278f42b`，双方使用 brutal。后续文档提交与正在开发的源码未混入本次结果。

[精确 CI 40947340059](https://github.com/chenxuan520/ra2web/actions/runs/40947340059) 全部 **5 个作业、1 个 artifact、14 个 ZIP 成员**均已核对。regression 成功；country-matrix、tactic-screen、report、tactic-report 因 `full_matrix=false`、`tactic_schedule=none` 正常跳过。本轮没有国家矩阵或国家报告，不是432局资格。

## 正确性与兼容性结果

| 检查 | 结果与边界 |
| --- | --- |
| Bun | 339通过、13跳过、0失败；跳过项目未作为通过计数 |
| Python | 37项报告完整性检查通过 |
| 类型与构建 | CI中的entry、server、benchmark及机制fixture类型检查、build通过 |
| L0 自身点坐标 | 真实隐藏己方出生点反例中，排除坐标相同的自身点，保留其余3个公共可能出生点；对象实例不同不再误认敌方目标 |
| L0 空队列续扫 | 初始27个目标被分配后，3840/3959tick不补；3960tick按既有16→33扩圈规则补95个可见度不足0.8的区域，含94个未知中心、1个已见中心；同tick不重复补充 |
| L0 已探区域 | 全已探场景3960tick仍为0目标；两个推进场景均0生产/战斗事件、资金不变、0运行错误 |
| F1/F2 机制兼容 | normal/brutal各两种隐藏出生配置，共四世界，各180tick、六次采样、一次实际指令；配对观察/意图/指令一致、隐藏敏感读取0 |
| F3a 机制兼容 | SUB/DLPH各232tick、六组交错观察快照；实际隐形、DEST移动探测、重遮/揭示和再隐形，旧ID/名单/filter一致；检测后各一次ASWLauncher发射，覆盖窗口0伤害 |
| 完整策略烟测 | 美国/苏俄双向配对，各交换物理出生及玩家槽，共4次；10k资金、0额外兵、引擎难度4，均正常到3000tick，0错误/警告 |

L0 的 `assignedTargetCount` 是分配量，不是已到达或已揭雾量；`revealedTargetCount` 为 null。真实Awareness缓存在检查点充分预热，因此本例不认证正常增量调度、完整策略中的探索效率、正常MCV开局机会成本、多狗协作或胜率。

烟测原始结果为3000tick到时，紧凑记录保留 `draw/tick-limit` 与 `qualificationEligible=false`。**这4次刻意截短的兼容烟测不计入27000tick强度样本或资格平局，不能推出新AI胜率。** 预置机制不能证明正常付费生产、完整公平性或对旧Bot非退步。

## 核验来源

根代理通过已连接GitHub读取全部作业、artifact和回归日志；用冻结版本的纯 `validateJobReport`、`summarizeTournament` 复算manifest指纹、两份raw回执、烟测完整性和汇总，生成本目录的4条紧凑记录。其可持久复查的输入、脚本和输出哈希见[核验来源](verification-provenance.json)，不虚构根代理断言计数。

独立只读审计另完成 **744 项断言**：核对ZIP全部成员CRC/原始字节/SHA、冻结Git源码及runner/资源哈希、manifest与raw回执、实际物理出生和玩家槽换边，并再次调用冻结纯验证器重算报告。作业清单来源仍是根代理的connected GitHub读取，不冒称子代理重复远程取证。审计过程中没有启动新游戏、fixture或CI。

新增 `scouting-queue.json` 与仓库冻结 `ef1ffb6` 中的[本地证据](../ai-scouting-queue-evidence/report.json) **50836字节完全一致**，SHA256为 `07a56c90d80284c21179410fa7751a702df5afca87e5cf249d3b2bfa57c68ed0`。F1/F3a与此前冻结证据的非源码元数据内容相同；变更后的8f源码元数据从冻结Git对象单独重算，没有改写CI原始报告或将旧raw冒充本轮结果。

## 留存材料与范围

[核验回执](receipt.json)、[全部作业](jobs.json)、[ZIP/14成员SHA](artifact-members.json)、[源码与资源哈希](source-hashes.json)、[原始manifest](smoke-manifest.json)、[原始summary](smoke-summary.json)、[raw回执索引](raw-receipts.json)、[全部4次紧凑记录](smoke-games.jsonl)、[独立审计](independent-review.json)及[目录SHA索引](SHA256SUMS)随源码归档。manifest、summary、两份verified回执和独立审计保留原始字节；不提交ZIP、完整日志、游戏资源、媒体、凭据或签名下载链接。

本轮只确认L0与已覆盖机制。伪装外观、其他观察边界和完整策略收益另需验证；分支仍继承未通过强度验证的开局草稿。不能凭本轮CI成功合并发布，也不据此认领多狗、偷建筑、多线或任何新打法收益。后续真实对照继续遵循[研究](../ai-expert-decision-research.md)与[登记测评计划](../ai-vanilla-evaluation-plan.json)。
