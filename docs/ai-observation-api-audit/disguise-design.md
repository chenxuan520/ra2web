# F3b 原版 SPY/MGTK 观察投影设计审计（未实现）

基准源码：F3a `3198391d7bc4e5ce02032ce3b4b16cdee01b212a`，本次读码时文档 HEAD `abcd5dc16ffeff3743f919b0146178bc01ed5f91`。本项仅作设计审计，未实现伪装修复；根代理独立复跑方法复现，输出字节一致。研究文档正常归档不代表源码已采用方案。F3a 的黑幕/隐形/旧 ID 观察边界已完成，不能据此宣称伪装身份也已修复。本文件是实施前设计，不是完整公平或战力验收。

## 已执行证据

本地方法复现脚本已运行并由根代理独立复跑；完整脚本留本地，结果见[原始复现JSON](disguise-method-reproduction.json)。

结果已存 [原始复现JSON](disguise-method-reproduction.json)，包含四个被调用源码的 SHA256。调用实际 `GameApi.forPlayer`、`DisguiseTrait`、`AttackTrait.canAttackThroughDisguise`、`InfantryDisguisePlugin` 方法；world/rules/渲染接收器为 mock。**不是完整真实引擎 fixture。** 示例15 tick冷却为测试输入，不能当原版INI计时。

已确认：

- 实际步兵显示插件将SPY显示为GI / E1 / viewer颜色，同一时刻F3a观察API仍把它放进enemy并返回SPY、enemy owner与真实rules。
- 树形MGTK仍进入单位filter，返回MGTK/Vehicle/真实enemy。
- 实际伪装攻击谓词：DOG自动→假己方SPY=true；普通坦克自动=false；普通坦克显式攻击SPY=true；DOG自动→树形MGTK=false；坦克强制攻树=true。没有模拟射程、LOS、目标竞争与伤害，不能说实际已击杀。
- sharedDetect集合加入SPY时渲染显示SPY，移出又显示GI。
- 当前SPY受伤显露后100个mock tick仍不重新伪装；MGTK伤后冷却再变树。普通坦克自动谓词对带disguiseTrait的静止、已显露SPY仍为false，这是既有引擎实现，不应在API正确性修复内顺手改。

此前原版资源规则索引 本地 `fair-identity-rules-20261030.json`：SPY.permaDisguise=true；MGTK.disguiseWhenStill=true；DOG/ADOG.detectDisguise=true而detectDisguiseRange=0。本次没有宣称重新取得另一套原版资源规则。

## 真实调用链

下列链接固定F3a提交；行号指具体入口。

| 文件 | 已核实规则 |
| --- | --- |
| [DisguiseTrait.ts:20](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/gameobject/trait/DisguiseTrait.ts#L20) | getDisguise仅active时返回rules/owner。disguiseAs复制被模仿对象的规则与owner，reveal清active并发事件。 |
| [DisguiseTrait.ts:42](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/gameobject/trait/DisguiseTrait.ts#L42) | SPY默认外观取自身阵营默认步兵，默认颜色仍为真实owner；不是出生即自动伪装敌色。 |
| [DisguiseTrait.ts:65](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/gameobject/trait/DisguiseTrait.ts#L65) | 非perma单位移动/JustFired显露，静止冷却后树形；SPY跳过整个onTick块。受伤通用reveal。不能猜测SPY会按冷却自动恢复。 |
| [Projectile.ts:699](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/gameobject/Projectile.ts#L699) | MakesDisguise命中经disguiseAs建立伪装。完整fixture应经过真实订单与弹头，不把手动trait状态当完整流程。 |
| [InfantryDisguisePlugin.ts:24](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/plugin/InfantryDisguisePlugin.ts#L24) | 非sharedIntel且未在viewer.sharedDetectDisguise集合中，显示假rules和假owner。共享检测显示真身；own/allied可识真并有显示闪烁。 |
| [InfantryDisguisePlugin.ts:63](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/plugin/InfantryDisguisePlugin.ts#L63) | UI名也使用假rules.uiName。仅改sprite、不改name仍泄露。 |
| [VehicleDisguisePlugin.ts:69](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/plugin/VehicleDisguisePlugin.ts#L69) | 未识破敌MGTK目标外观为树；shared detection为坦克；own/allied可识真。淡入淡出和己方闪烁是渲染时间，不得灌入确定性AI时钟。 |
| [VehicleDisguisePlugin.ts:240](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/plugin/VehicleDisguisePlugin.ts#L240) | 未识破树形无单位UI名且禁止高亮，不能作为已确认敌坦克。 |
| [MinimapModel.ts:74](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/map/MinimapModel.ts#L74) | 先查真实owner的sharedIntel和共享检测，然后用假owner颜色/地形颜色；显示颜色不授予控制权。 |
| [SharedDetectDisguiseTrait.ts:97](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/trait/SharedDetectDisguiseTrait.ts#L97) | 共享识破按真实detector范围、供电、敌对关系更新owner及其allies集合。观察层应读实际集合，不再造一套半径。 |
| [SharedDetectDisguiseTrait.ts:125](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/trait/SharedDetectDisguiseTrait.ts#L125) | 非零detectDisguiseRange才注册共享detector。狗为0，局部detectDisguise不能提升为玩家共享SPY名单。 |
| [AttackTrait.ts:166](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/gameobject/trait/AttackTrait.ts#L166) | 未force的敌树形无shared detection先拒绝；自动索敌另处理自身detectDisguise、静止、假友方owner。狗能力不越过前面的地形伪装拒绝。 |
| [AttackTrait.ts:373](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/gameobject/trait/AttackTrait.ts#L373) | scanForTarget以false/true/true调用谓词，之后仍有真实射程、LOS与目标排序。保持狗Guard/AttackMove原引擎自动行为。 |
| [AttackOrder.ts:73](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/order/AttackOrder.ts#L73) | 显式/强制攻击不等于自动索敌。不能认为引擎必定拦下真实ID攻击，从而允许观察输入透出。 |
| [DefaultActionHandler.ts:31](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/gui/screen/game/worldInteraction/DefaultActionHandler.ts#L31) | 普通选择拒绝非sharedIntel敌树形；此分支未检查sharedDetectDisguise，和已识破渲染可能不同。记录既有UI差异，不顺手改。 |
| [UnitSelectionHandler.ts:174](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/gui/screen/game/worldInteraction/UnitSelectionHandler.ts#L174) | 框选按真实owner===player，编组也拒绝单个他人单位。假己方色SPY不能进入己方可控库存。 |
| [MoveTask.ts:270](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/gameobject/task/move/MoveTask.ts#L270) | 树形影响真实阻挡；代码另有疑似反向sharedDetect集合检查，本次仅记录，不为观察不变性移除世界障碍或改寻路。 |

## 当前API泄漏入口

- [GameApi.ts:140](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/api/GameApi.ts#L140)：all/neutral/area虽过F3a可见性，仍按真实techno或真实neutral owner枚举。filter接收真实rules，进入单位名单本身可识破树形MGTK。
- [GameApi.ts:160](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/api/GameApi.ts#L160)：enemy/hostile按真实owner/combatant分类，假己方SPY直接暴露为敌。仅改data不能修复关系分类和filter泄漏。
- [GameApi.ts:195](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/api/GameApi.ts#L195)：type/name/rules/owner/maxHP均真；只改name仍可通过armor/strength/type/owner反推。
- [GameApi.ts:215](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/api/GameApi.ts#L215)：getUnitData spread后又写真实owner；另有真实sight/purchaseValue/武器实例与冷却、任务idle、乘员/矿载/factory/rally等。通用层投影后必须防止这里重新覆写。
- [rulesCache.ts:8](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/ai/thirdpartbot/builtIn/bot/logic/common/rulesCache.ts#L8)：每次用getGameObjectData.name查公共规则，所以name必须一起投影。当前按rulesApi+name缓存，比按对象永久缓存真实身份好；不能在新缓存再次保存隐藏真名。
- [EventsApi.ts:58](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/game/api/EventsApi.ts#L58)：广播spawn/unspawn/destroy ID、ownerChange真owner、attacker真实player/weapon名。未转发DisguiseChange。当前builtIn仅用己方attacker击杀更新stalemate，不把剩余能力夸大为已利用策略。
- MapApi对象名单、PlayerData敏感字段、SW仍有另行边界。公共规则全表本身可公开；漏洞是隐藏对象和真规则的关联。真实canPlace/碰撞/寻路不可为隐藏这些输入而伪造。

## 最小正确方案

### 一、单个纯appearance解析器

固定observer，先过F3a观察门。不通过返回undefined。own或真实owner sharedIntel允许真身份；无active disguise或viewer.sharedDetectDisguise.has(obj)也显示真身份；否则取disguise.rules与disguise.owner，Terrain伪装无owner。不要输出isDisguised、realType、trueOwner、识破来源等额外隐情标志。

纯读取、不掷随机、不改trait、不创建Weapon或世界对象、不用renderer的wall clock。树种随机由真实引擎生成，解析器只读结果。优先不加缓存以免同tick变装/伤害后变陈旧；如需缓存，失效条件须覆盖真实disguise/可见/检测变化。

### 二、视觉关系和可控库存分开

- self保持真实owner===observer的完整可控制单位。allied保持真实sharedIntel的已知友军，不将假色SPY当成可控队友。
- enemy/hostile按**外观owner**和公开联盟关系判定；未知owner不从隐藏真owner补齐。
- getAllUnits为当前可见“单位外观”，包括假己方色SPY；filter收到外观rules。可加getObservedUnits明确入口，供以后判断可疑轨迹；不能hide-all-spy。
- neutral按外观owner是否neutral，area也按表观unit类别筛选。
- 树形MGTK不进unit名单；generic data可返回所见Terrain外观。真实树和MGTK树的getUnitData必须同语义：不能一个抛异常另一个undefined或Vehicle，形成识别器。
- 对树/objects观察入口也需一致；原getAllTerrainObjects仅实际Terrain，和单位/API/MapApi名单做差可识破真type。若后续分项处理此通道，明确尚未闭合，不称完整身份公平。
- 真己方E1与假己方SPY并非有效全信息相等反事实，因为玩家本来知道自己库存。应用同位置、同第三方敌色SPY/真实E1，或两个真实owner不同但假owner相同SPY，对齐合法控制信息。

### 三、所有外部单位统一数据合同，不能仅伪装者删字段

普通E1有weapon而伪装E1缺weapon，则字段存在性又成识破oracle。推荐own/sharedIntel保留完整UnitData，所有其它外观对象使用同一ObservedUnitData合同，并由解析器供列表/filter/getGameObjectData/getUnitData兼容层共享。字段存在性只依可观察外观/合法权限，不依隐藏“是否伪装”。

| 字段 | 建议 |
| --- | --- |
| id、外观type/name/rules、apparentOwner、当前可见位置/方向/bridge | 可提供。id是目标句柄，不带真实类别保证。 |
| 控制权 | 只由self/授权查询表达，不在假色对象上附加真实敌owner。 |
| 血量 | UI显示血条比例/离散pip，[PipOverlay.ts:403](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/PipOverlay.ts#L403)不显示真实maxHP数字。可给健康等级/比例；不能继续透出SPY真maxHP。按外观strength估算HP应在策略层命名为估计，不冒充实际hitPoints。 |
| 名义成本/武器/装甲/视野 | 可从外观公开rules推导预期值，不读取真实对象weapon实例/购买价/射程修正/冷却。不要把估计值塞回原“实际值”字段。 |
| 发射、姿态、移动 | 只保留有可见依据的动画/位置变化；hasTasks并非静止，不作为外部isIdle。未知不填false/0。 |
| 乘员、驻兵、矿载、弹药、factory/rally | UI已经对外部owner屏蔽：[PipOverlay.ts:555](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/PipOverlay.ts#L555)、[:580](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/PipOverlay.ts#L580)、[:952](https://github.com/chenxuan520/ra2web/blob/3198391d7bc4e5ce02032ce3b4b16cdee01b212a/ts-redalert2/src/engine/renderable/entity/PipOverlay.ts#L952)。外部一致unknown，own/sharedIntel保持真实。 |
| veteran、维修等 | 不应无差别全删：当前veteran indicator没有外部owner过滤，维修wrench也有显示。逐项按真实UI验证后保留，未验证的项列待核。 |

当前UnitData的sight/purchaseValue/guardMode/isIdle是必填。返回残缺对象再强转as UnitData不是正确合同。最小实施必须包含接口及受影响消费点的unknown处理，不能为省改动填0。无需重写战术，只做读取合同的必要适配、测试和真实回归。own运输/维修/生产/微操的完整数据不能被全局删字段误伤。

### 四、狗的能力仍留在引擎

不新增“狗周围真SPY列表”，不复制共享detector，不使坦克继承detectDisguise。普通Guard/AttackMove的真实auto-acquire保持。可观察狗的实际转向、咬击、显露结果可以成为后续怀疑策略依据，但不能在狗尚未行动前从隐藏目标取真名。新增可疑路线/靠近检查属于独立策略研究与成本对照，不计作本次API修复收益。

## 冻结切分与回归风险

最小可审计核心应同冻：resolver、单位名单关系/filter、direct data、一致外部字段合同、必要消费点适配。只改name不是有效独立修复。树/terrain名单与事件可分后续冻结，但保留未闭合标志；完整公平验收前必须处理，不把半成品当发布资格。

事件需按**事件发生时**viewer观察与己方反馈权限筛选/投影。destroy之后对象可能不在world，不能事后拿getUnitData(undefined)决定事件可见。需要独立事件时快照测试；只过滤spawn而保留ownerChange原文仍可串联身份。

缓存、awareness和target记忆不能永久保存真UnitData作当前事实；曾见信息应带tick，不能跟读最新隐藏状态。MGTK转树后的unknown/maxHP缺失可能触发NaN或断言，需真实场景验收。apparentOwner不能被策略误认为实际可命令权限。名单保持稳定世界顺序，不增加RNG调用。SelectAction/shared detector、MoveTask反向集合等既有差异另记，不顺手改引擎。

冻结14/04/0a/C18/356也使用当前共享GameApi。外部字段合同改变可能改评分甚至导致旧策略异常，必须先逐个原profile真实烟测，再共同引擎真实矩阵；明确“历史策略在新观察API下”，不能沿用旧胜率、改旧提交或异常填平。F3b不是高手打法收益。

## 可执行回归场景（真实场景尚未执行）

1. **方法复现**：本地方法脚本已执行，输出展示未修泄漏/现有谓词。不是未来通过证据。
2. **SPY双viewer**：真实SPY经MakesDisguise订单取得E1外观。同tick交错A/B查询，A未识破只得E1假owner；真owner得到SPY。假己方SPY不入self，却保留在全观察单位。改变隐藏真实owner/武器/购买价但保持外观与合法库存同一，A输出及字段存在集合不变。
3. **同外观反事实**：固定ID/位置/方向/健康显示，同第三方敌色SPY与真实E1；所有外部字段/filter一致。比较合法观察输入，不要求它们物理受击伤害相同。
4. **狗与坦克**：实际DOG/ADOG从射程外接近到自动攻击，sharedDetect集合不凭狗新增；API不提前标真SPY。普通坦克相同观察不因此全局识破，狗仍能真实索敌。记录首攻/首伤/显露/首次API识别tick；一击死亡应记移除，不要求凭空存在显露窗口。
5. **shared检测**：先确认原版实际有无非零DetectDisguiseRange单位。若无，集合直接add仅算解析器单测，不用YR/改规则冒充原版实战。真实trait场景须标预置/非正常生产，覆盖范围、供电、同盟变化与退出。
6. **MGTK**：真实静止→树→移动→坦克→静止冷却→树，另测开火/受伤。树不进unit/filter；generic Terrain与真实树一致；own/sharedIntel维持真实MGTK。允许曾见历史记忆，不允许getter直接穿透当前树形。
7. **F3a叠加**：伪装期间重遮盖/缺失shroud先拒绝；隐藏ID移动/换伪装不泄露。不能因投影绕过cloak/黑幕。
8. **缓存与元数据**：filter副作用、rulesCache路径、getUnitData owner覆写、同tick变化、双Bot/第二地图不同规则；普通同类对象和伪装对象未知字段存在性相同。own运输/IFV/生产/矿载仍正常。
9. **命令与物理**：狗auto、普通显式attack、force攻树、树阻挡/绕路保持原引擎；观察层不改伤害/订单合法性/障碍。记录策略观察、订单和真实效果分别，拒单不是观察合法的替代品。
10. **共同引擎**：当前及冻结14normal/04brutal/0abrutal/C18brutal短真实烟测、镜像交替更新、普通难度、零错误。通过后才按登记新seed/原门槛资格，不混旧样本。

拟议后续fixture接口可为 `bun e2e/ai-observed-disguise.ts --resources ... --map ... --seed ... --report ...`；**文件未创建、该命令未执行**。完整报告须有source/rules/map/terrain/runner SHA、状态tick、双viewer输出、真实动作与效果、错误及断言，明确“预置机制场景，不代表实战收益”。

源码依据足以支持独立的观察正确性修复，不必拿战术研究未齐拖延；但外部字段合同和剩余terrain/事件边界必须先明确。本文未实施方案、未验证新侦察/反偷/幻影微操收益。
