# F3b 观察合同：精确CI回归验收

[AI validation 40958211507](https://github.com/chenxuan520/ra2web/actions/runs/40958211507)成功。候选和共同引擎/workflow均为 `0efe4dbd2efc7f62c677c07c1de2f7895327f11a`，对照C18 `c18f77650e40b668064bdb913a75bebfa278f42b`，双方brutal。后续文档HEAD不是新AI版本。本项不合并master，不代表上线或战力提升。

通过已连接GitHub核对全部 **5作业、1个artifact、15个ZIP成员**：regression `123743826062`成功；country-matrix、tactic-screen、report、tactic-report因full_matrix=false/tactic_schedule=none正常skip。实际日志的candidate、baseline、profile、development/direct/none均已核实；本轮没有国家矩阵或国家报告，不能误报缺局。

唯一artifact `12934482360 / ai-regression`，ZIP **92103字节**，SHA256 `77104884e5ce0af852ceb7b7e85b8724c7d4851f27137b922d7270c3242ca9d0`。全部成员CRC、字节数与SHA已核；七个真实机制JSON均与[冻结后根代理本地复跑](../ai-observed-disguise-evidence/report.md)逐字节一致，包括新增F3b原始2583365字节报告的SHA `db682d5d5f3978d2c7a601b9d907e6a491ac860c1f029f501ce6f28a4d7c635e`。没有拿旧8f/319报告充当本次结果。

| 项目 | 实际结果 |
| --- | --- |
| Bun/Python | 364通过、13跳过、0失败；37项Python完整性检查通过 |
| 类型/build | entry/server/benchmark及现有机制类型检查、新F3b类型检查、build均成功 |
| F3b | 六真实场景、26组双观察者快照、1357项runner断言、0运行错误；SPY、DOG/ADOG、MGTK、工程师FV维修、原版NAPSIS共享识破分别留证 |
| 其它机制 | F1/F2、F3a、L0、分兵、工程师与狗机制脚本通过；出厂/指令/命中不合并解释成策略收益 |
| 完整策略兼容 | 美国/苏俄双向配对，各交换物理出生与玩家槽，共4次3000tick，0运行错误/警告；10k、0额外兵、难度4 |
| 报告完整性 | 冻结验证器重新核manifest指纹、精确版本/profile/资源、2份成对raw回执、4唯一身份与汇总；共同引擎/资源/runner与本地冻结兼容运行一致，CI按1.3.14固定Bun |

**四次3000tick是兼容烟测，不是27000tick资格平局。** 原始draw/tick-limit与`qualificationEligible=false`同时保留，不计算升级胜率，也不和本地32次兼容运行拼成战力样本。机制预置与真实付费开局、完整策略收益仍分开。

根代理完成connected清单、全部原字节和冻结验证器复算；独立只读审计另通过776项主检查及46项日志交叉检查，分别记录且不相加。复核使用精确0efe的654个game文件、70个builtIn文件、1226个引擎文件和16个runner文件摘要；没有拿当前文档HEAD的工作树替代冻结版本。

[全部作业](jobs.json)、[artifact及成员SHA](artifact-members.json)、[根复算回执](root-verification.json)、[原始manifest](smoke-manifest.json)、[原始summary](smoke-summary.json)、[raw及回执索引](raw-receipts.json)、[四次紧凑记录](smoke-games.jsonl)、[独立复核](independent-review.json)与[目录SHA](SHA256SUMS)已归档。ZIP、完整日志、资源、依赖、凭据、签名下载链接不提交。

通过范围限于[F3b合同](../ai-observed-disguise-contract.md)和已覆盖机制。敌方DESO可见部署/辐射观察仍缺失，是明确的功能和发布风险；MapApi/事件/玩家元数据等边界亦未因此全面关闭。旧开局草稿仍未通过强度资格，不能凭此次CI绿灯发布或宣称人类无法获胜。
