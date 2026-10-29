# DESO 可见展开与辐射观察：F3b 后续单项只读设计

根代理复核说明：本文件是候选设计，未接入API或策略。已独立重跑原版INI/ART解析，输出逐字节一致（21869字节，SHA256 `41ac6930c7cfa8301975efc510d764ea0b3929ea91ee005010c0fd0bb33dcc98`）；没有运行游戏tick、渲染或像素唯一性验证。候选帧/地表像素模型是本设计的验证方案，不是所有AI工作必须先重建GPU画面的前置要求。下一主线仍可独立推进L1付费侦察机制；采用任何更粗的语义观察模型须明确边界、同外观不变性与实际回归。

本次只读审计依据源码 `0efe4dbd2efc7f62c677c07c1de2f7895327f11a`，检查时 HEAD `15eb7a7939a038aff8bc6f2172bd21142ccbcdbf`；两者 `ts-redalert2/src` 无差异。没有修改仓库、运行新比赛、派发 CI 或改变物理/伤害/规则。本地只执行了现有原版 INI/ART 解析和纯 `sequenceMap` 调用，没有运行游戏 tick、渲染帧或截图；下面的机制 fixture 均是待实施方案。

## 决策建议

优先将**受支持原版 DESO 的稳定展开外观**作为窄观察正确性子项做机制验证；不恢复原始 `stance` / `isFiring`，不同时扩展为通用动画或全地表像素系统。只有能证明所有候选可显示帧属于同一展开外观类别时，输出正向的 `visiblePosture: "deployed"`；过渡、缺素材、外观混淆或未充分观察的状态统一 unknown，不输出 false/standing。这仍是外观证据，不是“已经放射”、伤害、污染区域、持续时间或敌方归因。

此窄项可以独立推进设计/fixture，但当前源码**没有现成的确定性“当前已显示稳定帧”状态**；不能仅用 `stance===Deployed` 或一个随意等待 tick 数就声称已闭合。下面列出明确的最小实施条件与停止边界。不需要先重建通用 surface renderer，也不应阻塞 L1 付费侦察等已经有充分独立依据的工作。

辐射绿色地表另列后续观察项。`radLevel`、`radLevel>0`、辐射专属 tint、单独量化 Lighting 系数都不能当作可见污染真值。若以后实现，必须输出来源无关的合成颜色证据；绿色或颜色变化只允许成为策略层的风险估计，不能由 API 宣布“有毒/安全”。

## 1. 展开、开火与污染是三条不同的链

固定源码链接前缀：`https://github.com/chenxuan520/ra2web/blob/0efe4dbd2efc7f62c677c07c1de2f7895327f11a/ts-redalert2/`。

| 源码位置 | 已核实事实 | 观察合同含义 |
|---|---|---|
| `src/game/gameobject/trait/DeployerTrait.ts:70–94` | `setDeployed`立即改 stance；先进入 PreparingToFire，delay 为15加另一武器冷却。 | 展开动作/展开姿态不等于已经发射。不能把所有可见展开者立即记成已发生污染。 |
| 同文件`:112–151` | 延迟、弹药、既有污染冷却通过后，按 `art.fireUp` 进入 FiringUp；真实发射时 isFiring 已设回 false。 | 直接观察 isFiring 的真/假既不是放射事件也不是区域污染状态。 |
| `src/game/Warhead.ts:520–523` | 实际 weapon radLevel 和 cellSpread 才创建真实 rad site，半径 cellSpread+1。 | 只有真实机制层能确认污染生成；玩家观察不能因此自动收到隐藏真值。 |
| `src/game/trait/MapRadiationTrait.ts:55–69` | 按受害单位计算伤害，`inflictDamage(..., undefined, ...)`没有施害 owner。 | 实际伤害只按受害方统计，不能从 site 归属认领某个 DESO 的伤害。 |
| 同文件`:71–117` | 场地逐步衰减，多个 site 累加到 tile，上限1000；site 中只存 level/radius。 | 看不见/离开 DESO 不等于污染消失；不能从 getter 读取 source、expiry 或实际局部伤害。 |

## 2. 真正的 Infantry 显示链及 F3b 必须保留的限制

1. `InfantryDisguisePlugin.ts:24–61`先判真实 owner 的 sharedIntel 和 sharedDetect；未识破者采用假 rules 对应 art 与假 owner。own/shared 的视觉闪烁用 renderer time，但他们本来有真实身份；不能把该闪烁写入确定性 AI。
2. `Infantry.ts:528–534`用假 `objectArt`替换真实 art。后续序列选择必须使用这里同一个 apparent art，不能用 SPY 自己的序列表。
3. `sequenceMap.ts:160–191`先尝试 firing，再 moving，最后 still；每一层按**外观 art 可用序列**回退。raw stance 不等于实际可显示姿态。
4. `Infantry.ts:287–309`在动作变化分支将伪装 FireUp/FireProne 改为 Ready。SPY 的隐蔽 MakesDisguise 动作可能是 isFiring=true，画面却是 Ready。
5. `Infantry.ts:313–329`的 stance-transition 分支及`:369–388`的 animation-end 分支再次选序列，却没有经过同一个 FireUp/FireProne 屏蔽语句。不能宣称把 `findSequence`调用一次再 mask 就完全复刻现有 renderer。这个已有显示分支差异须记录，不能顺手改物理/伪装/攻击语义。
6. `Infantry.ts:417–451`将 sequence 与 facing 映射到具体 frame；`Animation.ts:46–65`依据传入 render time 推进，`:109–112`存在随机 loop delay；`Infantry.ts:356–400`有 idle 动作/方向随机。Bot 不可读取 animRunner/currentSequenceParams、墙钟或额外抽 RNG。

因此 F3b 对**所有外部对象**省略 raw stance/isFiring 的决定正确。不能为了 DESO 只对 SPY 删字段，普通 E1/DESO 留原始字段，否则字段存在性再次成为识破器。

## 3. 本次实际解析的原版 ART 证据

本地解析脚本：`/workspace/scratch/disguise-visible-radiation-art-read-20261030.ts`；原始结果见[实际规则与纯序列观察](visible-radiation-art-observations.json)。脚本调用真实 Rules、Art、SequenceReader 和 sequenceMap，无 Game/createWorld/tick。输入为当前已取得 `ini.mix` + `ra2cd.mix` 合并的基础规则/art，未添加地图覆盖；不是另一套线上部署资源，也未证明 SHP 像素外观。

- base INI MIX bytes SHA256：`8af9a3349b72b1946a5c02794605030ab2bbe50a487f1185f39c08766c4a1c76`
- custom MIX bytes SHA256：`79626e434f8650fb8a47141ff63382636cf29114b0b2779316aff4ffed39da66`
- DESO: deployFire=true，deployFireWeapon=1，art.fireUp=2。
- 当前 radiation 配置：radLevelMax500、radColor[0,255,0]、radLightFactor0.1、radDurationMultiple1、radApplicationDelay16、radLevelDelay90。这是规则读数，不是战术参数建议。

| apparent DESO 序列 | startFrame / frameCount / facingMult | 含义与限制 |
|---|---|---|
| Ready、Guard | 两者均0 / 1 / 1 | 同一方向显示相同帧，输出原始 SequenceType 或 Guard/None 可泄露不可见命令。必须合并同显示类别。 |
| Prone | 86 / 1 / 6 | 8方向对应86、92…128；不可把 raw Prone 直接公开，伪装 firing分支可覆盖为Ready。 |
| FireUp | 164 / 6 / 6 | 普通直射动画；未识破假 DESO/SPY 的变化分支可被覆盖为Ready。 |
| FireProne | 212 / 6 / 6 | 同上。 |
| Deploy | 299 / 15 / 0 | 展开过渡，不能立即认定稳定 Deployed。 |
| Deployed | 298 / 1 / 0 | 一个稳定展开候选帧，方向无关。 |
| DeployedFire | 292 / 7 / 0 | 帧292–298，和稳定 Deployed 共享298。单看298不能证明当次发射或新的污染。 |
| Undeploy | 0 / 1 / 1 | 与站立外观相同；显示站立也不证明历史污染消失。 |

E1、SPY、E2、ENGINEER 同样有 Ready/Guard 相同帧。E1 的 DeployedIdle 甚至是 frameCount=0，不能将“序列 key 存在”当有效可见动画。

上述是**帧索引集证据**；不同索引仍可能包含相同像素，或受遮挡/透明度影响。本轮未查看 DESO SHP 帧298/299图像，不能标成已确认视觉唯一。最小下一步应只取得现有原版 DESO 对应 SHP 的相关少量帧，按同位置/方向/颜色对齐，对298与所有合法非展开/伪装显示候选做像素/轮廓等价校验；无需解析全游戏 renderer。

## 4. 窄 DESO 稳定外观方案

### 合同

建议新增可选观测字段（名字可在实现时确定）：

```ts
// 所有外部单位走同一个外观解析器，不能以真实name或是否带DisguiseTrait决定字段。
visiblePosture?: "deployed";
```

- 固定 observer，先复用 F3b shroud/cloak/销毁门，再确定 apparent type/name/art/owner。
- 仅当 apparent art 的有效帧表和资源摘要在已验证合同内，且可显示候选帧都属于已证实的稳定展开类别，才为正。
- 非步兵、未知 art、过渡、刚发现对象、失去视野后重新出现、伪装切换或候选集合跨多个外观类别均 unknown；unknown 不等于 standing/false。不能读取隐藏时间线后补算“我早就看见展开”。
- actual SPY 假 DESO 与真实 DESO 必须经过同一 apparent-art 投影；不得 `if(realName===DESO)`才返回字段，也不得对有 disguiseTrait 的对象全部特殊省略。
- 无需暴露真实 owner、deployerTrait、原 stance、原 isFiring、weapon、ammo、cooldown、site 或“识破来源”。
- stable Deployed 与 DeployedFire 的共同帧只能证明展开外观，不证明放射；后续策略不可因此刷新已污染记忆。

### 确定性与稳定性的必要条件

纯 `findSequence(...)`不能识别现有 renderer 此刻是否还在 Deploy 过渡。API若仅加入`observedTicks>=15`也不构成证明：15只是此art的frameCount，renderer按时间累进，停帧/恢复、game speed变化、重新发现和同tick动作切换都可能不同。

最小合理实施是一个**受限的外观候选帧状态机/投影器**，仅针对本项受支持 apparent art，使用模拟 tick 与公共art数据，保存本 observer 的合法观测历史；候选集必须包含当前稳定序列及尚不能排除的过渡/显露分支。它不能调用 renderer 时间或额外随机。只有候选集被证明收敛到展开外观类才输出正值。若不能在现有渲染时序下证明收敛，不用武断等待阈值造正值，应保持 unknown，并在机制测试中报告“此实现未恢复展开观测”。

更小的先行实现可只做纯 apparent-art/frame 等价分类器及机制 fixture、不接策略。此代码已有充分源依据，可以独立验证；它不需要泛化全部对象/全部动画，也不需要等待 surface 色模型完成。若要调整 renderer 以共享确定性语义选择，须作为明确单项改动与跨帧率对照，而非偷偷把 raw stance 更名。

### 同外观反事实

1. 同ID/位置/方向/外观owner的真实E1 Ready，与 SPY伪装E1正在 MakesDisguise FireUp：现可见类别相同，字段值及键集合必须相同。
2. SPY假DESO，true stance Prone/None + firing true，被投影成Ready；与真实DESO Ready同输出，不读隐藏武器/成本/任务。
3. 真DESO Ready与Guard原始序列不同、帧相同：结果必须相同。
4. 真DESO稳定frame298，与相同apparent DESO/frame298的任何实体/动作来源：输出相同；不得借DeployedFire的隐藏来源声称刚放射。
5. 同合法历史但隐藏时段真实展开、取消、换伪装不同：仍unknown；不能以隐藏状态变化刷新stable计时。
6. 相同apparent art但原owner不同、真实SPY/DESO不同、两observer交替：结果只取决于合法外观；own/shared保持完整控制数据。
7. 伪装切换同tick、缺shroud、reset、边缘只露部分/重获目标、未知art、无效frameCount、帧重叠：应退回unknown而非借缺字段识破。

### 窄真实 fixture（尚未执行）

- 使用原版现成地图/资源，以普通ActionsApi下Deploy/Undeploy/移动，记录真实DESO的受限API输出与裁判侧stance/fire/WeaponFire/site生成，二者分开。
- 连续记录：站立→展开过渡→稳定展开→真实放射→取消→污染残留；明确首正外观tick、首实际放射tick、首次site存在，不将三者合并。
- 真实 SPY 通过 MakeupKit 拷贝 DESO与E1；包含 MakesDisguise firing/真实受伤显露。方法注入原姿态只能作附加不变性单测，不能冒充正常SPY可部署。
- 用相同有限模拟轨迹在多种确定渲染采样间隔、暂停/恢复与速度变化下核对受支持帧集合；不得让AI调用renderer时间。必须保留失败时段，若无法证明稳定正值就不接策略。
- 两observer、shared检测进入/退出、shroud reset/reveal重获；变化在合法观察之外不得提前恢复正值。
- 完整normal/brutal与历史策略同引擎短烟测。只是机制/观察正确性，不是付费生产、高手战术收益、27000tick比赛或资格。

## 5. 辐射绿色不是可以直接暴露的污染真值

源链：

- `MapRadiationTrait.ts:27–29,86–113`：真实每格radLevel，是机制状态。
- `MapRenderable.ts:142–175`：`q=min(1,radLevel/radLevelMax)`，把radColor和radLightFactor转为tileLight。没有在这段按observer筛选。
- `Lighting.ts:61–109`：ambient、ground、elevation、tileLight tint/intensity合成。
- `MapTileLayer.ts:65–95,131–141,230–255`：选TMP、isoPalette，合成光量作为vertex乘色。
- `paletteShaderLib.ts:46–84,127–130`、`PaletteBasicMaterial.ts:21–32`：真实颜色还经过palette、extraLight、vertex乘色及输出管线。
- `Building.ts:347–382`：灯柱是单独CustomBlending平面、renderOrder999995，**不在Lighting.tileLights求和内**。只取Lighting.compute仍遗漏其他实际可见灯光。
- `MapShroudLayer.ts:123–150`：高顺序999999的乘色黑幕遮罩，边缘还有半透明shroud帧。
- `Renderer.ts`实际路径为`src/engine/gfx/Renderer.ts:83–84`：NoToneMapping、sRGB输出。

不变性要求：

- rad500与rad1000已进入同一q=1，上述管线输出可相同；不得返回实际level或由它推导实际伤害。
- 辐射与灯柱/地图光照/其它效果可产生同最终颜色；相同最终可见像素/量化色，不同隐藏来源必须同输出。
- 黑色、饱和色、透明像素和最终量化可掩盖光量差异；仅量化float tint仍可区分人看不到的变化。
- 看见一格green不能给出真实半径/center/site owner/过期tick，更不能扩为完整潜在污染圆。
- 缺shroud/黑幕/模型不支持必须unknown；观察到某种颜色也不是rad=0或“安全”。

**建议将surface项独立放后面，不作为本次窄DESO或L1侦察的前置大改。** 最小可测试工具可接收已经合成的真实底色/遮罩输入，输出有限量化surface samples而非源贡献；所有来源等价/黑饱和/截顶反事实先通过，再考虑固定observer API。这里没有建议当前就实现通用像素renderer。

现存额外边界：

- `MapTileLayer.ts:80`、`TileSetEntry.ts:22–33`用渲染随机选TMP变体，不能headless自己挑一份并叫当前实际画面。
- `LightingDirector.ts:29–55`按render.onFrame time更新核爆等ambientFX；不能供AI直接读取，也不能忽略后声称全合成。
- 静态唯一素材、无遮罩无遮挡、无未建模FX可作受限fixture范围；范围判断不得根据隐藏rad或隐藏光源本身切换known/unknown，否则“unknown”又成来源oracle。可只用预登记静态coverage，或对所有允许素材/效果集合求共同可见结果；这可能导致覆盖率很低，需如实统计。
- `MapApi.isVisibleTile`当前对缺shroud用可选链取反会得true；新观察入口不能复用这个错误语义，须固定observer、无shroud拒绝。地面用offset0，不能借高空单位高度看地表。
- 已揭示地图在原版保留探索，不能私造“必须当前LOS”的新规则；reset/gap后重新拒绝。黑幕边缘、坡面、桥面、建筑遮挡另需精确覆盖模型，初版unknown。

详细独立复核留存于本地 `/workspace/scratch/radiation-visibility-review-20261030.md`，其SHA256为 `8e0381bdec7ccc1fce6333b1fe049edbbf0c14c43c89dc706e736c85ad77d427`。它是surface旁项设计，不是本任务要求立即重建整套画面的前提。

## 6. 实施顺序与验收边界

1. 先完成窄DESO的**素材等价/有效帧集合**检查和纯投影器负向单测；保留所有外部raw stance/isFiring未知。无研究等待或用户确认前置。
2. 在真实DESO/SPY固定场景验证过渡、稳定、发射、污染是不同证据。只有有足够正向覆盖且无同外观泄漏，才连接一个纯观察字段；若稳定性仍未闭合，保持unknown并归档具体缺口，不用人工阈值强过。
3. 连接策略是另一个冻结候选/消融实验。即使看见展开，也不得新建/刷新“已发生污染”记忆；当前已知己方实际部署/真实事件记忆规则要另审，不能扩大敌方推断。
4. 来源无关surface观测在后续独立评估。仅把“看见绿色/展开”和“风险估计”分开；不得用机制truth做赢局捷径。
5. L1真实付费狗侦察、高手条件研究以及其余已充分依据工作可并行，不被本视觉旁项无限阻塞。

本审计没有新胜率、没有新增对局、没有宣称已恢复敌DESO展开/辐射观察。所有实现与fixture仍待执行，旧F3b正确性结果不得当本设计通过证据。
