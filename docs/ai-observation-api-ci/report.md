# 观察边界修复：冻结源码的 CI 回归

这是正确性与兼容性回归，未进行强度筛选，也未发布。主候选为 `3198391d7bc4e5ce02032ce3b4b16cdee01b212a`，对照为冻结 C18 `c18f77650e40b668064bdb913a75bebfa278f42b`，两者使用 brutal；共同引擎及工作流为 `abcd5dc16ffeff3743f919b0146178bc01ed5f91`。候选与工作流的 `ts-redalert2` 树相同，文档提交不算新 AI。

[精确 CI 40944893447](https://github.com/chenxuan520/ra2web/actions/runs/40944893447) 的全部五个作业已读取：regression 成功；country-matrix、tactic-screen、report、tactic-report 因 `full_matrix=false/tactic_schedule=none` 正常跳过。本轮没有国家矩阵或国家报告，不能作为432局资格。唯一 `ai-regression` artifact 的 ZIP、全部13个成员、两份烟测原始报告及回执均按原始字节复算 SHA256。

## 检查结果

| 项目 | 结果与范围 |
| --- | --- |
| Bun | 332通过、13跳过、0失败；跳过项目仍为缺少可选输入的真实PvPGN/资源HTTP集成项 |
| Python | 37项报告完整性测试通过 |
| 类型与构建 | entry、server、benchmark、偷取/护卫/两项信息fixture的类型检查及build通过 |
| F1/F2真实机制 | normal/brutal各两种隐藏出生配置，共四世界，每世界180tick；六次采样、一次实际指令，配对观察/意图/指令一致、敏感读取及运行错误为0 |
| F3a真实机制 | SUB/DLPH各232tick，实际隐形、DEST移动探测、重遮盖与再显露、离开后重新隐形；各六组双观察者快照，旧ID/名单/过滤器一致，零错误 |
| 完整策略烟测 | 美国/苏俄双向配对并物理出生与玩家槽换边，共4次，均正常到3000tick，零错误/警告 |

烟测是刻意截短的兼容测试，**不计入27000tick强度样本或资格平局统计**。预置单位机制没有证明正常付费生产、新战术收益、完整策略公平性或非退步。F3a每例检测后各一次真实ASWLauncher发射，覆盖窗口内零伤害；没有为了测试抑制武器或改规则。

根代理重新调用仓库 `validateJobReport` 和汇总逻辑，复算 manifest 指纹、全部原始回执、实际换边和资源/版本一致性；从冻结 Git 对象复算GameApi/BotManager等文件、game树、runner、共同引擎及lock/resource-loader哈希。两份信息机制结果与[本地冻结证据](../ai-observed-visibility-evidence/receipt.json)逐字段相同，唯一差别为正确记录的文档/工作流commit；没有改写CI原始元数据。

独立复核另完成687项断言，核对相同Git对象、全部ZIP成员和冻结版本纯验证器，结论一致；详见[独立核验摘要](independent-review.json)。

## 可复查材料与未完成项

[核验回执](receipt.json)、[ZIP及全部成员原始SHA索引](artifact-members.json)、[原始manifest](smoke-manifest.json)、[两份raw回执](raw-receipts.json)、[全部四次紧凑记录](smoke-games.jsonl)保留在仓库，完整ZIP和日志只保留本地/CI。烟测胜率不在这里作为性能指标。

F3b伪装外观、敌方内部字段、玩家元数据及事件通道仍待审计与分项修复，真实裂缝发生器未覆盖。分支仍含未通过强度验证的开局草稿，不据本轮绿灯合并master或上线。后续实际策略继续依据[高手研究](../ai-expert-decision-research.md)和[登记测评计划](../ai-vanilla-evaluation-plan.json)，使用公平、同引擎的当前Bot/消融对照，不继承旧胜率。
