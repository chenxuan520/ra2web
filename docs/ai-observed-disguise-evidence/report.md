# F3b 冻结后的真实机制与兼容回归

源码冻结为 [`0efe4dbd2efc7f62c677c07c1de2f7895327f11a`](https://github.com/chenxuan520/ra2web/commit/0efe4dbd2efc7f62c677c07c1de2f7895327f11a)。本项是[观察合同修复](../ai-observed-disguise-contract.md)，不是高手战术或强度升级验收；未合并master、未上线。后续文档提交不是另一候选。

根代理在冻结后重新运行真实机制脚本：6场景全部通过、0运行错误、1357项runner断言、26组交错双观察者快照。源码前后相同且干净，654个game TS文件、12项单文件、runner与4项资源哈希均从冻结Git对象/实际资源独立复算。开发工作树的运行只作开发记录；其非源码元数据内容与冻结运行相同，不将dirty报告充当冻结证据。

| 场景 | 冻结实际结果 | 边界 |
| --- | --- | --- |
| SPY复制E1 | 3tick，真实MakeupKit/Snapshot执行；外部SPY与真实E1的字段集合、表观规则和健康等级一致；重遮/揭示检查通过 | 位置/ID不同，不是全空间反事实；对应方法测试另覆盖相同空间输入 |
| DOG局部识破 | 378tick，实际一击100HP并移除SPY；200tick普通MTNK等待窗口无自动发射 | 狗未赋予玩家共享识破；一击同更新内移除，不能虚构中间真SPY观察帧 |
| ADOG局部识破 | 同样378tick、一击100HP，整个连续trace共享识破为false | 与DOG分别存证，不推广为任何局势自动成功 |
| MGTK树形 | 162tick，自然树→真实移动显露→冷却树；实射100敌HP，真实炮弹67入伤造成树形显露 | 炮弹强攻可见树的地砖；没有让Bot预先读取真坦克ID，未改原伤害 |
| ENGINEER/FV | 149tick，真实上下车、RepairBullet切换；实际16HP损伤后恢复16HP，卸载后同一工程师ID和原武器恢复 | 损伤由明确强攻设置；HealthChange本身没有来源，订单/发射/恢复分别保留 |
| 原版NAPSIS | 193tick，原规则范围15；真实移动进出切换ENGINEER/SPY外观，底层伪装不变；卖电厂导致真实低电并清共享识破 | NAPSIS/NAPOWR是预置，实际售卖返款600单列；不是正常付费建造、供电恢复或同盟切换验证 |

原始加载规则确实含NAPSIS：TechLevel10、Cost1000、Prerequisite NATECH/NACNST、Powered=true、Power=-50、DetectDisguiseRange15、AIBuildThis=no。不能笼统声称“原版没有共享识破建筑”，也不能将预置成功说成AI正常造出了该建筑。狗的范围仍是0，其局部自动攻击与NAPSIS共享识破是不同机制。

根复算与独立只读复核分别记录。独立审计另有392项重建检查，末两场景有1076项交叉检查；这些不同层次的断言不相加为对局数量。源码审查还发现并修复原始发射/姿态可能越过伪装动画的问题，见[源码审查](independent-source-review.md)。

## 其它回归与完整策略兼容

- 最终Bun **364通过、13跳过、0失败，2921断言**；Python完整性检查37通过；entry/server/benchmark/新fixture类型检查及build通过。跳过项未当通过；build现有动态导入提示仍保留。
- F1/F2、F3a、L0、分兵、工程师和狗机制脚本也在冻结源码重新执行并通过。各自报告哈希见[机制回归索引](real-regression-index.json)，缺失的errorCount仍为null，预置机制不计真实战略收益。
- 冻结候选分别对14/normal、04/brutal、0a/brutal、C18/brutal、356/brutal、L0/brutal，以及当前normal自测，每组4次3000tick，共28次。另对C18做4次9000tick交战窗口。共 **32次、0运行错误/警告**，全部使用同一冻结引擎/资源、10k资金、0额外兵、难度4，交换物理出生与玩家槽。
- 八组的原manifest、16份成对raw/回执哈希和全部32条紧凑记录保留；冻结验证器重算输入指纹、版本/profile、真实换边、raw SHA与汇总通过。9000tick四次均有双方实际发射/伤害；这只能说明所覆盖策略路径可运行。

**32次都是刻意截短的兼容运行，全部排除27000tick战力与资格样本。** 原始tick-limit/draw照录，不转成资格平局，不计算“升级胜率”。历史Bot源码没有修改，但新公共观察合同改变了其输入，零运行错误也不代表历史目标选择/强度完全不变；后续因果对照必须明确这种版本与合同边界。

## CI、留存与未完成项

[新回归CI40958211507](https://github.com/chenxuan520/ra2web/actions/runs/40958211507)的candidate与engine/workflow均为0efe4db，对C18，双方brutal，development/direct，full_matrix=false、tactic_schedule=none。归档时正常运行；后续须通过已连接GitHub读全部作业、artifact成员及日志后独立验收。预计regression执行、另四项配置跳过，无国家/战术矩阵报告是正常。此处本地结果不能替代CI结果。

[紧凑机制报告](compact-fixture.json)完整保留6场景的设置、订单、事件、26组快照、结果和限制；省略的1263行连续trace另有[内容哈希索引](trace-index.json)。原始报告2583365字节，SHA256 `db682d5d5f3978d2c7a601b9d907e6a491ac860c1f029f501ce6f28a4d7c635e`。完整raw留本地；新CI配置也将上传其独立运行的完整报告，最终字节另验。不提交大报告/ZIP、资源或媒体。另存[根回执](root-fixture-receipt.json)、[独立fixture复核](independent-fixture-review.json)、[兼容复算](compatibility-verification.json)、[32条记录](compatibility-games.jsonl)、[验证回执](validation-receipt.json)和[目录SHA](SHA256SUMS)。

仍须解决外部DESO部署/辐射观察缺口，以及后续MapApi、事件、玩家元数据等边界；外部真实姿态缺失后不能声称敌方辐射避让完整。分支的旧开局草稿仍未达标。正常生产、L1付费分路侦察、当前Bot/消融实战、独立资格和最终集成部署均未被本轮替代。
