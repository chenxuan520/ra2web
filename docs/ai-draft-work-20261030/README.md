# 2026-10-30：暂停时未提交工作的归档

本提交保存此前留在工作区的研究代码、实验草稿与失败记录。用户已停止自动研究和开发，本次仅整理提交；不恢复定时任务、不派发对战、不合并master、不部署。以下历史笔记中的“下一步”“正在推进”不代表现在仍在执行。

此前完成的F3b源码已经在 [`0efe4db`](https://github.com/chenxuan520/ra2web/commit/0efe4dbd2efc7f62c677c07c1de2f7895327f11a)，CI验收和后续文档已推送至 `fc1b1c8`。见[观察合同](../ai-observed-disguise-contract.md)、[真实机制与兼容证据](../ai-observed-disguise-evidence/report.md)、[精确CI结果](../ai-observed-disguise-ci/report.md)。本次没有新增游戏策略或证明战力提升。

## 付费侦察：未完成草稿

- [runner](../../ts-redalert2/e2e/ai-paid-scouting.ts)与[类型配置](../../ts-redalert2/e2e/tsconfig.ai-paid-scouting.json)保存S1一狗顺序、S2两狗同路、R2两狗分路的实验框架。S2/R2计划保持生产政策相同，仅比较目标分配；S1是数量和成本参考。
- [原计划](../ai-paid-scouting-plan.json)中的48次运行是**计划数，完成数为0**，不是已得到48局结果。setup-only未成功，精确布局尚未登记，正式路线对照和边界实验没有完成。
- [原始失败输出](paid-scouting-setup-failure.json)记录 `Actual factory exit is impassable`。该输出属于停止前的开发尝试；保存的源码还包含当时后续写入但未成功复跑的修改，因此不能把这份失败输出当作最终保存字节的冻结回执。
- [只读审查清单](paid-scouting-review.md)与[未执行的复算脚本草稿](paid-scouting-verifier-draft.py)一并保存。后者需要不存在的完整冻结48次报告，未作为验收使用。

预置设施的机制也不能回答正常MCV开局的重工、矿车和坦克延迟。请求、队列受理、实际扣款、退款、在产和出厂仍须逐项实测，不能用现金差替代完成狗花费。揭雾仅计划统计全队union，每狗归因保持null。

保留的已知限制：隐藏置换草稿交换的是两个既有位置的建筑类型，并非空候选与目标位置置换；命令前缀比较还可能空过，不能声称信息不变性已经通过；计划的 `defended-first-route` 与runner的 `defended` 是同一意图但命名尚未统一；记账context标签本身不证明实际退款来源。当前完整Bot仍是单个globalScout，草稿没有接入正常策略。

原先工作区为该runner增加的两条CI命令已撤下。失败草稿不接入自动regression，也没有运行新矩阵。

## 可见辐射兵：素材和动画原型

[分类器](../../ts-redalert2/e2e/lib/apparent-sprite-classifier.ts)、[六项负向测试](../../ts-redalert2/src/test/ai/ApparentSpriteClassifier.test.ts)、[原型runner](../../ts-redalert2/e2e/ai-visible-deso-prototype.ts)与专用类型配置从隔离工作区归档。分类器仅接收已取得的完整像素摘要，不读取真实单位身份、姿态、武器或辐射值，未接入GameApi或策略。

原版DESO素材共644帧。稳定298与过渡313的二值轮廓相同，实际像素有差别；原始未重映射、未照明的完整像素域可以区分298，轮廓模型不能。在真实Animation类的隔离执行中，相同结束时间1100ms、不同采样频率分别落在298、310和300。它说明固定模拟等待时间不能直接代替当前画面；不是GPU截图或真实对局，也不证明当前已产生污染。

保存[644帧摘要及规则来源](visible-deso/material.json)、[原型报告](visible-deso/prototype-report.json)、[原始回执](visible-deso/prototype-receipt.json)、[素材/代码索引](visible-deso/receipt.json)、[本地准备资源一致性检查](visible-deso/prepared-cross-check.json)及[历史笔记](visible-deso-prototype-notes.md)。`visible-deso/extract.ts`、`check-prepared.ts`是原始本地脚本，保留原路径供审查，尚未整理成可移植CLI；不自动执行。没有提交SHP、MIX、调色板、截图或依赖。

该原型仍缺合法、确定的当前可见样本生产端，没有恢复敌方DESO展开/辐射观测。部署外观与实际放射分开；已记录的功能风险仍见[候选设计](../ai-observation-api-audit/visible-radiation-design.md)。

## 本次提交检查

分类器6项测试通过、21断言；付费侦察、可见DESO与benchmark类型检查通过，entry/server类型检查和build通过。归档素材运行原型33项断言通过，并与原报告逐字节比较；没有再次运行对战或把原型结果记为战力样本。检查记录与文件摘要见[归档回执](archive-receipt.json)、[SHA256索引](SHA256SUMS)。

可手动复查的小范围命令：

```sh
cd ts-redalert2
bun test src/test/ai/ApparentSpriteClassifier.test.ts
bun --bun tsc -p e2e/tsconfig.ai-paid-scouting.json
bun --bun tsc -p e2e/tsconfig.ai-visible-deso-prototype.json
bun e2e/ai-visible-deso-prototype.ts --material ../docs/ai-draft-work-20261030/visible-deso/material.json --out /tmp/visible-deso-prototype.json
```

此次提交只保存工作，不代表新战术完成、发布门槛通过或已上线。后续需要用户重新明确发起工作；不使用定时唤醒自动续跑。
