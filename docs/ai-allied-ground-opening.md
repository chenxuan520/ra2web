# 近距离盟军先重工：单项开发试验

2026-10-26，先登记后实现。依据[原版打法研究](ai-top-player-playbooks.md)的收入与地面接战同时运营原则，以及[共同对手资格败局](ai-mobile-defense-common-opponent-ci/report.md)，本项只检验盟军建筑开局次序。不是声称录像提供了固定tick建造表。

B折法国对美国、mp08t2:720101未换边的真实败局：空指部2688tick就绪、重工4784tick就绪，补矿车9707tick出厂，整局灰熊0、飞行兵6，11188tick败；对手重工3344、补矿车5287、首灰熊7673，并有多功能步兵车。它提示需要验证近距离先空指是否挤压收入及地面军队，不把单例当成唯一败因。

## 单项改动边界

仅brutal的美国/韩国/法国/德国/英国：沿用既有公开可能出生点判断（最近可能敌出生点≤90格或缺少起点信息），第一重工之前暂缓新空指部。重工之后沿用既有矿车/装甲与科技门槛，不同时改飞行兵预算、坦克出击、微操、守备、造价或可见性。已经在建的空指部继续，避免重工被毁时取消投入。远距离开局、苏军和normal保持原有行为；不查未侦察敌人的实际位置。

## 冻结与对照

从356派生新冻结候选，版本号在实现与检查完成后登记。开发赛程`allied_ground`：两图mp08t2/tn01t2，三个已暴露开发seed610101/610202/610303；八个有向配对：French:French、Americans:Americans、French:Americans、Americans:French、French:Russians、Russians:French、Americans:Russians、Russians:Americans；每对物理出生和玩家槽换边，共96局，每图48、法国36/美国36/苏俄24。该赛程不能代表所有盟军国家或独立资格。

四个同引擎对照：新候选直接对C18、新候选直接对356、新候选对0a、356对0a。后两组同身份配对，区分修改增益与对手强弱；前两组W>L只算开发正线索，不能当发布资格。全部10k/0额外兵/engineDifficulty4/27000tick，两边brutal，真实可见性、成本和前提。错误/缺局不作平局；平局只允许真实tick-limit。

必须报告首重工/首空指/首矿车补充/首灰熊出厂及开火tick与覆盖、真实工厂产量、收入/矿车存续、装甲实伤与损耗、国家/地图/换边结果。没有出空指或灰熊如实写未发生，不能因缺事件让中位数看起来提前。保留全部败局与超时。

后续若冻结候选进入资格，使用新登记的[地面开局测评计划](ai-allied-ground-evaluation-plan.json)，三套新seed810101/810202/810303、820101/820202/820303、830101/830202/830303，尚未运行，不用于开发调参。旧710/720/730资格已暴露并退休给后续修改版，不能复用冒称未见。新计划沿用原80/70/70、非退步和目标改善门槛，保留原计划文件不改写。

本项不填补独立战术对手、精确机制消融、镜像全覆盖、普通难度或合并引擎验证等其他条件。当前master继续保留C18及他人资源/部署/Terrain改动，不自动推广。沿用同一“RA2 对战完成汇报”任务，不新建重复监控。

## 已冻结候选与精确CI

候选/共同workflow-engine `ffb438108f1aaadeeeb4a951b753bc5d64c3a426`，ts-redalert2树`27cd9af3220eb7356c59722bdfcb3d8ad0b3922d`。实际游戏改动只有economyPlan的近距离盟军首重工门槛；报告脚本额外记录真实重工/空指/矿车/灰熊时序，旧pilot/development赛程保留。源码检查311 Bun通过、13跳过、0失败；37 Python完整性测试通过，entry/server/benchmark类型检查与build通过。机制测试不当胜率。

| 用途 | 精确CI |
| --- | --- |
| ffb对C18直接开发对照 | [40261838672](https://github.com/chenxuan520/ra2web/actions/runs/40261838672) |
| ffb对356直接开发对照 | [40261849670](https://github.com/chenxuan520/ra2web/actions/runs/40261849670) |
| ffb对0a共同对手试验 | [40261862795](https://github.com/chenxuan520/ra2web/actions/runs/40261862795) |
| 356对0a同条件控制 | [40261876695](https://github.com/chenxuan520/ra2web/actions/runs/40261876695) |

四条各96局，共384，都是full_matrix=false/tactic_schedule=allied_ground。首轮连接GitHub确认四条已进入regression；输入日志及实际raw/report尚待独立核验。country-matrix和历史report预期skip，不是缺少432局资格。

另以B折已暴露的French:Americans、mp08t2:720101原败局条件做两侧机制复现，单独留存；不计这384局，不称未见资格，不用其单例结果代替上述四组对照。
