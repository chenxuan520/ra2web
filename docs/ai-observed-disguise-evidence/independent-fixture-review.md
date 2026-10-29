# F3b 冻结真实机制报告独立复核

结论：在本地冻结机制范围内通过。未重跑游戏、fixture或CI，未修改仓库。本报告不验收正在进行的CI 40958211507，也不验证32次兼容烟测、强度或发布。

- 冻结源码：`0efe4dbd2efc7f62c677c07c1de2f7895327f11a`。
- 原始报告：`observed-disguise.frozen.json`，2,583,365字节，SHA256 `db682d5d5f3978d2c7a601b9d907e6a491ac860c1f029f501ce6f28a4d7c635e`。
- sourceBefore/sourceAfter逐字段相同，记录精确0efe及干净源码状态。654个game TypeScript文件从冻结Git对象重算，digest `33c627cab687d1d62104f2c851fd8121b46a95c9fb8cd648a9c6f05e87d08417`；runner及12个单文件SHA、地图/地形/ini.mix/ra2cd.mix实际字节SHA均一致。
- 6个完整case、26组双观察者快照、1263行连续tick记录、0运行错误。原runner断言计数分别130/190/190/306/242/299，共1357；这是原执行计数。本次另做392项源码/数据重建检查；末两场景另由只读辅助完成1076项交叉检查。三种计数不相加，不冒称重执行原1357项断言。

## 核验结果

| 场景 | 原始证据与独立核对 |
| --- | --- |
| SPY复制E1 | 2tick真实MakeupKit发射及ObjectDisguiseChange，3tick外部只见E1；同色真实E1与SPY的外部字段/已定义字段、公开rules、healthLevel一致。真实HP100/125不暴露；两对象ID、位置、方向不同，不能称完整空间反事实。实际shroud reset/reveal正确封闭旧ID。 |
| DOG / ADOG | 原版DetectDisguise=true、共享范围0。各365tick真实咬击发射、377tick100HP伤害并销毁SPY，378tick采样已移除。整段378tick共享检测均false，外部从未提前获得SPY真名；普通坦克200tick窗口及后续没有射击。不存在可单列的“显露后存活快照”。 |
| MGTK | 1tick树→2tick实际移动坦克→73tick到达后重新树。后续一发MirageGun造成100HP真实出伤；对方120mm在161tick造成67HP入伤，162tick采样HP133、树显露。同一入伤update无MGTK自身射击，入伤原因隔离。ForceAttack目标为可见树的地块坐标，未传隐藏对象ID。 |
| ENGINEER/FV | 同ENGINEER1368在事件112tick登车，trace113从world查询消失但未销毁；事件148卸载，trace149同ID/75HP返回。己方API的武器/乘员为HoverMissile/0→RepairBullet/1→HoverMissile/0。实际友军导弹先造成16HP伤害，143tick一次RepairBullet发射、同tick坦克384→400HP。 |
| 原版NAPSIS | 原始规则范围15、TechLevel10、NATECH+NACNST、Cost1000、耗电50、AIBuildThis=no。真实移动在trace43入圈、70出圈、97再次入圈，139是到达并静止快照。底层ENGINEER伪装始终保留，仅外部投影随共享检测变换。139tick发真实卖电厂指令，192tick PowerLow/ObjectSell，trace193供电150→0、耗电50、共享检测退出。实际返款600单独记录。 |

事件tick发生在game.update内部，trace/snapshot通常是其后tick+1；上表不混用事件与采样时间。26个快照分别核对名单、直接查询、真实owner权限、外部私有字段缺失及记录的A/B/A相等标志；raw只保存相等的前观察与owner观察，第三次观察不另存，因此不伪称可以用三份payload独立复算相等。

ENGINEER登车事件只记录运输车ID，乘员连续身份由trace中的1368、未销毁状态、卸载返回以及冻结runner的对象membership断言交叉支持。HealthChange无治疗来源字段；RepairBullet发射与同窗16HP恢复分别留证，不把事件伪造为带来源治疗。600为本引擎AI所有者卖预置电厂的实际返款，冻结SellTrait不对AI应用人类refundPercent；不代表正常人类卖价或付费生产收益。

## 复现比较及边界

开发版原始报告在来源元数据之外与冻结报告逐字段完全一致；开发版记录18361b7与dirty状态，明确不是本冻结候选证据。没有改写其元数据，正式核验以0efe冻结报告为准。

这些是预置单位、no-op bot、显式真实shroud操作的机制测试；没有正常付费生产、MCV开局、完整策略或胜率结论。NAPSIS覆盖原版真实供电与范围退出，未覆盖恢复供电或联盟转移。树对比使用另一真实树种/位置；不宣称相同空间完整反事实。MapApi、事件时观察、PlayerData等边界、敌方DESO展开/污染观察缺口与最终发布门槛仍需处理。

机器可读核验、检查清单及完整源码/资源SHA见`independent-fixture-review.json`；额外交叉核验见`independent-transport-detector-review.json`。二者仅限本地冻结机制报告，不代替GitHub所有jobs/artifacts/raw/manifest/receipt的后续CI验收。
