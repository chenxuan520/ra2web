# 观察 API 的身份边界与分项修复

2026-10-30（Asia/Shanghai）。审计基于 F1/F2 源码 `183554e3105e6dd0e28b7f3d8d958841ebb7d0b7`。这份记录补充未关闭的边界，不改写[此前机制回执](../ai-information-boundary-evidence/receipt.json)，不表示发现了新的胜率。

## 可复现的问题

当敌对象位于已探索地形，原 `GameApi.getVisibleUnits` 只检查黑幕、真实所有者和同盟关系：未侦破的间谍、伪装成树的幻影坦克及仍处于隐形状态的潜艇，均可能进入敌军列表，过滤回调还能收到真实规则。`getUnitData/getGameObjectData` 不绑定观察玩家，曾见过的 ID 在重新遮盖后仍可返回实时位置和内部字段。

[复现输出](legacy-api-reproduction.json)调用真实 GameApi 方法，但世界和单位 trait 使用 mock；根代理独立重跑一致，[原始字节哈希](legacy-api-reproduction.sha256)为 `a23a0f8aa4e50491efa8634008b1469663d461de87f799f1be3f6b6e19bc74a7`。这是 API 缺陷复现，不是真实地图、真实潜航或战斗验证。对应 GameApi 源码 SHA256 为 `4f64655115eb45782a7bdbcd677b4215311a65750e8c32290ab67a8a14d3c218`。

玩家渲染端已经区分这些状态：`InfantryDisguisePlugin` 使用伪装的类型与颜色，`VehicleDisguisePlugin` 把未识破的幻影显示为树，`ObjectCloakPlugin` 隐藏没有共享情报的隐形敌对象。Bot 的战略输入不能绕过同类信息边界。引擎最终拒绝一次攻击，也不能消除提前知道目标位置对生产、方向和威胁评估的影响。

## 分项实现范围

F3a 先为每个 Bot 绑定明确的观察玩家，在隐形或黑幕丢失后关闭当前 ID 读取，过滤回调之前也要排除不可见对象。`BotManager` 的设 API、开始、tick、事件等入口必须使用同一个对应玩家实例，不能借“上次查询的玩家”隐式切换共享 API。未观察到就返回未知，不伪造当前位置或旧信息；若以后保留 lastSeen，须另记观察 tick 与快照。

F3a 已冻结为 [`3198391d7bc4e5ce02032ce3b4b16cdee01b212a`](https://github.com/chenxuan520/ra2web/commit/3198391d7bc4e5ce02032ce3b4b16cdee01b212a)。每个 Bot 使用独立 `GameApi.forPlayer`，全生命周期不再共享观察实例；明确的 `forDiagnostics` 保留裁判读取。可见、全部单位、平民、区域查询均先检查观察权限再调用规则过滤器，旧 ID 也重新检查。己方和共享情报数据保留；非共享对象在缺失 shroud 时关闭读取，避免败北后的回调意外得到全图敌情。没有修改物理世界、动作合法性、单位规则或伤害。

F3b 再处理伪装外观投影，不能简单删除所有伪装单位。间谍的假步兵外观仍是可见信息；实际可控制的己方库存与看起来友好的单位必须区分。规则回调、名称、规则缓存、所有者颜色与武器等字段应一致，避免改了一个名字却仍从其它字段读出真实身份。幻影树不能凭真实 techno 类型自动成为已知敌坦克。

当前实际规则中狗 `DetectDisguise=true`，但 `DetectDisguiseRange=0`；其自动反间谍能力通过攻击逻辑生效，并不把附近所有伪装者加入全军共享侦破列表。隐形探测则由真实 sensor 触发 uncloak。不得为 Bot 加新的探测范围或削掉原有引擎自动反间谍行为。

真实动作合法性、碰撞、寻路、生产成本和伤害保持引擎原样。测试比较合法信息相同、尚无物理交互时的新观察和决策；不要求隐藏实体真的碰撞后世界仍完全相同。还需审计其它 API 的内部字段、地图读取与事件通道；本项不代表全部 API 已认证。

## 验证与比较边界

下一项需覆盖两个观察者交替查询、可见后再隐形/重遮盖的旧 ID、回调与直接读取两条路径、己方数据仍完整，以及真实冷却潜航、sensor 触发显露和重新隐形。预置对象仅作机制验证，不能放进正常经济的胜率样本。

历史 Bot 的 builtIn 目录被单独冻结，但 GameApi/BotManager 来自共同引擎。因此共同 API 修复后，历史策略也在新的观察接口上运行；必须记录新的 engine/ref、重跑同条件对照，不能继承旧分数或把差异都归因于新战术。没有修复的历史策略入口也不能被描述为完全信息公平。F3a 不改写外国玩家现金/出生点为虚假值，相关兼容与剩余权限需另行明确。

这些正确性工作有充分源码证据，可与未完成的高手战术研究并行；不据此提前发布含未验证开局的实验分支。

## F3a 冻结后验证

全量 Bun 测试332通过、13跳过、0失败；跳过的真实 PvPGN/资源HTTP集成测试仍缺各自可选输入。entry/server/benchmark/两套信息 fixture 类型检查、build 及37项 Python 报告完整性测试通过。独立复核发现的“shroud缺失即放行”已修正并加入负向测试。

根代理在冻结源码后复跑真实水域 `mp10s4`：SUB 与 DLPH 各232tick、各6组交错双玩家观察，验证自然隐形→真实DEST移动探测→真实shroud重遮盖/揭示→离开后的再次隐形。显示的采样tick为18/177/232；事件记录在update内，通常早1tick。每例显露之后各有1次真实ASWLauncher开火，覆盖窗口内零伤害，没有为保持“干净”结果压制武器。己方目标始终可读，隐藏ID/名单/过滤器一致关闭。原F1/F2的四世界fixture也在该源码复跑，观察、意图、动作及状态转换与原报告一致。

另用相同引擎与冻结C18做normal和brutal各4次3000tick完整策略兼容冒烟（美国/苏俄双向配对和真实换边），共8次、零运行错误，均正常到达短时限。**这8次不计入强度样本或27000tick平局统计**，不代表非退步或资格通过。各历史策略共用新API，旧胜率不能继承。

证据见[独立回执](../ai-observed-visibility-evidence/receipt.json)、[真实可见性报告](../ai-observed-visibility-evidence/visibility-report.json)、[F1/F2复跑](../ai-observed-visibility-evidence/information-report.json)、[冒烟逐次记录](../ai-observed-visibility-evidence/smoke-games.jsonl)与[原始哈希索引](../ai-observed-visibility-evidence/SHA256SUMS)。现有CI的regression已加入两套类型检查和机制脚本；派发与CI实际结果另按精确run记录。

F3b 伪装投影仍待实现；可见敌方的factory/rally、武器cooldown、载客与采矿内部状态也未全部审计。真实裂缝发生器、完整策略公平资格与战力资格均未完成，未合并master或上线。


F3b的[实施前字段合同与回归场景](disguise-design.md)已补齐，并保留独立复跑一致的实际方法/mock世界复现。该设计仍未实现，不能把字段合同建议当作现有观察API承诺。
