# 红警 2 AI 策略研究与对局验证

资料查阅日期：2026-10-25。以下页面均已实际打开阅读。攻略用于提出可测假设；它们和单元测试都不能证明本项目 AI 已提高胜率，更不能证明人类无法获胜。

## 来源与适用范围

| 来源 | 已核对的要点 | 适用范围与限制 |
| --- | --- | --- |
| [RA2 原版手册镜像](https://manualmachine.com/gamespc/commandconquerredalert2/1117998-user-manual/)：Game Basics、Ore Refinery | 矿车可以提前回厂卸货；宝石价值约为普通矿两倍；零现金暂停生产，低电拖慢生产；已完成建筑未落地会阻塞后续建筑生产。 | 原版 RA2 规则说明。当前项目的实际数值与命令效果仍以本地规则、引擎验证为准。 |
| [CnCNet：tank spaming](https://forums.cncnet.org/topic/6943-tank-spaming/)，2017 年讨论 | 扩重工前需要可持续矿业收入；炼厂距离、坡道和不必要支出会影响相同矿车数量下的实际产量。 | RA2/YR 混合讨论；其中快捷键整队取消明确标注为 YR 专属。 |
| [CnCNet：Micr0 Pocket book](https://forums.cncnet.org/topic/6650-micr0-pocket-bookdo-you-even-micro-bro/)，2017 年讨论 | 受击前排单位后拉，优先攻击近处可有效输出的目标；压力可以来自控图和攻击弱点。 | 文中的“单重工四矿车后再扩重工或科技”明确标注为 **YR** 经验，不是本项目的固定门槛。 |
| [Planet CnC：General Strategies](https://planetcnc.gamespy.com/View7495.html?game=5&id=35&view=Strategies.Detail)，Brent Kim | 坦克前排、光棱/V3 后排；分组齐射、侦察、选择交战地形。 | 位于原版 RA2 栏目；取战术原则，不复制旧文章中的生产速度判断。 |
| [Planet CnC：Allied Vehicles](https://planetcnc.gamespy.com/Viewcd56.html?game=5&id=40&view=Strategies.Detail)，Joe Montgomery | 保持续造主战坦克，避免投入明显劣势战斗；光棱需要护卫，IFV 提供防空支援；超时空矿车受威胁时可返厂。 | 原版 RA2。旧文有部分单位细节争议，数量比例与具体秒数不作为实现常量。 |
| [Planet CnC：Soviet Vehicles](https://planetcnc.gamespy.com/Viewd11f.html?game=5&id=45&view=Strategies.Detail)，Joe Montgomery | 灰熊需要开阔地展开以发挥数量；防空履带车对装甲薄弱，应避免承担坦克前排。 | 原版 RA2；是否能拉扯、能否开火须按当前单位射程、速度与冷却计算。 |
| [Planet CnC：Tech Structures](https://planetcnc.gamespy.com/View088c.html?game=5&id=49&view=Strategies.Detail)，Joe Montgomery | 油井收入值得争夺，但应考虑保护和持续控制；破坏敌方油井可削弱经济。 | 原版 RA2；捕获收益、可建造邻接范围以当前地图规则为准。 |
| [CnCNet：Soviet build order](https://forums.cncnet.org/topic/12733-what-is-the-build-order-for-soviets-in-red-alert-2-yuris-revenge/)，2024 年起讨论 | 地图大小、矿区和宝石分布、起始资金、对手是否快攻决定开局。 | 明确讨论 **Yuri's Revenge**；工业工厂等资料片内容不直接移植至原版 RA2。 |
| [CnCNet：Red Alert 2 Laboratory，第 3 页](https://forums.cncnet.org/topic/7500-red-alert-2-laboratory/page/3/)，2017 年讨论 | 不同客户端规则、建造倍率及录像帧率使生产时间测量出现差异。 | 包含 `rulesmd.ini`、XWIS 与 CnCNet 的 YR 对比；用本项目模拟 tick 和实际规则验证，不照抄网上秒数。 |

检索中 XWIS 的 Tips N Tricks 页面抓取超时，StrategyWiki 的 Allied units 返回 403，未将它们作为已核对证据。红警 1、重制版及其他模组的攻略也未用于数值推断。

## 候选改进与可测假设

下列项目是实验建议，不代表已完成实现或已取得对局提升。

| 优先级 | 假设与当前代码切入点 | 观察指标 |
| --- | --- | --- |
| 1 | 在 `buildingRules.ts`、`BasicBuilding` 中，让额外重工和实验室投资服从可持续收入，可能减少过早投资造成的断钱。当前仅按建筑数量、优先级和现金余额判断不足以反映收入。 | 零现金 tick 占比、固定 tick 的矿车和主战坦克数、首次有效进攻时间、胜/平/负。 |
| 2 | 在低现金或遇袭时适量干预矿车，可能减少停产和矿车损失。`UnitData` 已提供载矿量，命令 API 提供 `Dock`、`Gather`；需要按模拟 tick 节流，避免频繁打断采矿。 | 单位时间入账、闲置矿车 tick、矿车损失、返厂命令次数、生产停顿。 |
| 3 | 在 `combatSquad.ts`、`tacticalTargeting.ts` 中加入可达的展开阵型、炮兵护卫和集结条件，可能提高同时开火比例，减少长队逐个接战。 | 同等初始军队价值下的交战胜率、伤害/损失、同时开火比例、寻路失败和重复命令次数。 |
| 4 | `EngineerMission` 按路径风险与守住目标的能力选择油井，可能提高工程师投入回报。 | 油井净收入、占领持续时间、工程师损失、为保护油井投入的军队价值。 |

保持坦克基本盘与按需支援；不要因为出现少量空军就无条件让防空车占据整个车辆生产队列。战术目标评分应同时考虑可攻击性、距离、实际护甲伤害、局部敌我火力和已分配伤害。

## 对局迭代方法

1. 固定历史 bot 的提交版本，并记录候选代码版本、地图及规则摘要、阵营、种子、起始资源、游戏选项和难度加成。旧版与候选使用相同资源和加成，通过真实模拟与命令 API 对战。
2. 每个地图、种子和阵营组合交换出生点成对测试。至少包含不同地形与资源分布的多张地图，避免把单张地图优势解释为普遍能力。
3. 每轮只改变一类策略，同时与冻结旧版及上一轮候选比较。保留逐局记录，不能只保留胜局或只汇报汇总百分比。
4. 胜负以模拟结果为准。达到模拟 tick 上限记为平局；加载失败、运行异常或工具超时记为错误，不能算胜局。额外输出经济、生产、伤害和单位损失指标来解释结果。
5. 对退步地图查看记录或重放，区分运营不足、目标不可达、任务解散、阵型拥堵和命令无效，再提出下一轮改动。单元测试检查具体决策和失败条件，真实对局检验整体效果。
6. 报告样本量、地图范围、胜/平/负及错误数，再描述观察到的变化。未测试的人类对局、地图和对手不包含在结论中。

对局结果应由实际运行记录另行填写；本文不预设胜率和最优参数。
