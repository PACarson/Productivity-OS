/**
 * 00_ADR.gs
 * Productivity OS v4.8 — Architecture Decision Records
 *
 * 本文件收录本项目"影响后续所有开发判断"的重大架构决策，格式固定为
 * Metadata（V4.3 新增，见下方字段定义） + Context / Decision /
 * Consequences 三段式。跟 00_Project_State.gs 的区别：State 是会被覆盖的
 * "当前快照"，ADR 是不会被覆盖的"决策历史"——一旦某条 ADR 被后续 ADR
 * 取代，旧的 ADR 保留在这里并标注 Status: Superseded by ADR-xxxx，不删除、
 * 不改写。
 *
 * 本文件对应 Universal Domain OS Blueprint「0. Governance → ADR (Optional)」
 * 这一格（00_Project_Constitution.gs P4 之前原本写"暂无"，V4.1 起改为
 * 指向本文件）。
 *
 * 【2026-07-15 新增】第六轮外部审计两项架构级修复的正式记录：
 *   - ADR-2026-07-15-009——Soft Lock 粒度从 chatId 收紧到
 *     identity（细化 ADR-2026-07-06-003，不是取代——Gate/Soft Lock
 *     两层结构和"per-user 不再互相排队"的核心决定不变，只是把 Soft Lock
 *     的 key 从"每用户一把"进一步收紧到"每条创建请求本身一把"）。
 *   - ADR-2026-07-15-010——EventBus.publish 与 ProjectionEngine.dispatch
 *     的调用关系从硬编码改成 Subscriber 模式，注册逻辑放在
 *     15_Setup.gs（Composition Root）。
 * 两条都源自同一次外部审计（原文档 HIGH RISK 1 / MEDIUM RISK 5），完整
 * 代码改动见 09_IdempotencyManager.gs / 21_RecurringEngine.gs /
 * 20_TaskEngine.gs / 02_EventBus.gs / 10_ProjectionEngine.gs /
 * 15_Setup.gs 各自的文件头。
 *
 * 【2026-07-13 新增】ADR-2026-07-13-008——Due Time Support（完整设计见
 * 00_Architecture_Review.gs「七、Review #3」）的两项设计决策正式记录：
 * identity 计算改用 resolveIdentityDueValue() 辅助函数而不改
 * generateTaskIdentity() 签名；due_datetime 没有具体时间时为空字符串，
 * 不默认成午夜。
 *
 * 【2026-07-11 新增】ADR-2026-07-11-006 / 007——00_Architecture_Review.gs
 * （UEF v1.0 Domain Profile Review #1）Finding D1-1 的正式记录：两条此前
 * 已经实现、且论证已经存在（分别在 Constitution 零之四和
 * 05_SheetUtils.gs 文件头），但没有对应正式 ADR 条目的"维持现状"决定，
 * 本次补记归档。是补充归档，不是重新做决定，两条决定的内容和实现都不变。
 * 同时修正本文件头版本号——此前 ADR-2026-07-06-005（V4.6 的决定）已经
 * 收录在下方正文，但文件头一直没跟着改成 v4.6（Review Finding D3-1
 * 顺带发现的第二个实例，见该 Finding）。
 *
 * 【V4.6 新增】ADR-2026-07-06-005（TaskStatistics 从事件驱动实时投影
 * 降级为每日批量重算，第五轮外部审计 HIGH RISK 1+4 的正式记录）。
 *
 * 【V4.5 新增】ADR-2026-07-06-004（Projection 消费端必须对重复事件保持
 * 幂等，第四轮外部审计 HIGH RISK 1 的正式记录）。
 *
 * 【V4.4 新增】ADR-2026-07-06-003（Per-User Soft Lock 取代全局 ScriptLock，
 * 第二轮外部审计 MEDIUM RISK 1 的正式记录）。
 *
 * 【V4.3 变更】
 *   1. 所有 ADR 统一补充 Metadata 区块（字段：ADR Number/Status/
 *      Decision Date/Supersedes/Superseded By/Affected Modules/
 *      Related ADR/Consequences/Notes）。ADR-2026-07-06 的原有 Context/
 *      Decision/Consequences 正文内容保持不动，只在最前面加了这个区块。
 *   2. 新增 ADR-2026-07-06-002（Schema Authority）。
 */

// ============================================================
// ADR-2026-07-06：Dashboard 不是 Projection，是 Read Composition
// ============================================================

/**
 * ── Metadata（V4.3 补充）──────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-06
 *   Status          : Accepted
 *   Decision Date   : 2026-07-06
 *   Supersedes      : （无，本项目第一条 ADR）
 *   Superseded By   : （无，仍然生效）
 *   Affected Modules: 12_TaskQueryEngine.gs, 24_ViewEngine.gs,
 *                     25_DashboardEngine.gs, 15_Setup.gs（不建 Dashboard
 *                     Sheet，故 setupSheets() 不含这张表）
 *   Related ADR     : ADR-2026-07-06-002（Schema Authority——两者都在
 *                     回答"这类数据该不该有自己的物理表"这个同一大类问题，
 *                     但结论方向相反：Dashboard 明确不建表，Schema 明确
 *                     "当前用一个文件承载即可，不需要现在拆表/拆文件"）
 *   Consequences    : 见下方 Consequences 正文（V4.1 原文，未改动）
 *   Notes           : 本 ADR 首次提出 Write Model → Projection → Query
 *                     Layer → View Layer 四层模型，后续 00_Roadmap.gs 和
 *                     00_Project_Constitution.gs 的 Architecture Principles
 *                     第6条（Views Never Persist）均以本 ADR 为权威依据，
 *                     修改本 ADR 前请一并检查这两处是否需要同步更新。
 *
 * Status: Accepted
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * V4 原始设计草案（升级需求文档 Projection Design 小节）把 Dashboard 列在
 * 跟 TaskStatistics/TaskFilters 同一条投影链上：
 *
 *   Events → Tasks → TaskStatistics → TaskFilters → Dashboard
 *
 * 隐含的意思是 Dashboard 也应该是一张物理 Projection Sheet，跟 Tasks/
 * ActiveTasks 一样由 Event 增量维护。V4 落地时发现这个类比不成立：
 * Tasks/ActiveTasks/TaskStatistics/TaskFilters 的共同特点是"可以完全由
 * Event 历史推导，不依赖查询发生的那一刻"——
 *
 *   TASK_CREATED   → Tasks（新增一行）
 *   TASK_COMPLETED → TaskStatistics（done_count+1）
 *   TASK_CANCELLED → ArchiveTasks（最终会被归档）
 *
 * 而 Dashboard 里 Today / Overdue / This Week / Upcoming 这几个板块的内容
 * 取决于"现在几点"，不取决于 Events 本身。同一组 Events、同一份 Tasks
 * 数据，在 2026-07-06 23:58 查和 2026-07-07 00:00 查，"今天"指的是完全
 * 不同的日期——Events 没变、Tasks 没变，Dashboard 自己变了。这跟
 * Projection 的定义（"给定同一份 Event 历史，任何时刻重放结果都相同"）
 * 是矛盾的，Dashboard 不满足 Projection 的这个基本性质。
 *
 * 持久化一张 Dashboard Sheet 需要每天定时 delete+rebuild+rewrite（或者
 * 每次查询前重算覆写），换来的不是一致性或性能收益——反而多一张要跟着
 * 每次 Schema 变更走迁移流程的表，且这张表永远只是"别的 Read Model 在
 * 某一刻的组合视图"，本身不携带任何独立信息。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * 本项目的数据流分四层，Dashboard 属于第四层，不属于第二层：
 *
 *   1. Write Model（唯一真相，只追加）
 *        Events
 *
 *   2. Projection Layer（可被 Event 历史完全推导，增量维护，物理落盘）
 *        Tasks / ActiveTasks / ArchiveTasks / TaskStatistics / TaskFilters
 *        （未来如需要：TaskPriority 缓存表，见下方 Consequences）
 *
 *   3. Query Layer（对外唯一查询入口，只读第2层，不重放 Events）
 *        12_TaskQueryEngine.gs
 *
 *   4. View / Presentation Layer（依赖"查询发生的那一刻"，永不落盘）
 *        24_ViewEngine.gs（今天/本周/逾期... 等逻辑视图）
 *        25_DashboardEngine.gs（把多个逻辑视图 + 统计数字组合成最终展示文案）
 *
 * 正式条款（沿用需求方原始措辞，具有约束力，后续任何 PR 违反以下任一条
 * 视为架构违规）：
 *
 *   - Dashboard SHALL be generated on demand（禁止预先算好存起来）。
 *   - Dashboard SHALL compose existing Read Models（只能读第2层已经落盘的
 *     投影表，通过 12_TaskQueryEngine 读，不允许自己开 Sheet 连接）。
 *   - Dashboard SHALL never replay Events（不允许调用 EventBus.getAllEvents
 *     或任何 deriveXxxState_ 函数）。
 *   - Dashboard SHALL never become a persistent Sheet（不建物理 Dashboard
 *     表，现在不建，以后除非有新的 ADR 明确推翻本条，否则不建）。
 *   - Dashboard belongs to the Presentation Layer, not the Projection Layer
 *     （00_File_Map.gs 的模块关系图、00_Project_Constitution.gs 的 Blueprint
 *     映射表，均以本条为准）。
 *
 * 引擎职责进一步拆清楚（V4.1 明确化，V4 初版实现已经基本符合，本次只是
 * 把"为什么这样分"写成正式条款，避免以后不小心把职责混回去）：
 *
 *   12_TaskQueryEngine  → 只做"取数据"：批量读 Read Model 一次，转交给下一层
 *   24_ViewEngine       → 只做"整理数据"：过滤/排序/分组，产出 Today/Week/
 *                          Overdue 等逻辑视图，纯函数，不知道"Telegram"是什么
 *   25_DashboardEngine  → 只做"组合展示"：把多个逻辑视图 + PriorityEngine/
 *                          AnalyticsEngine 的输出拼成一份完整 Dashboard 文案，
 *                          纯函数，同样不知道"Telegram"是什么
 *   06_TaskIntentParser → 只做"面向 Telegram 的呈现"：调用上面三层拿到文案，
 *                          决定怎么发给用户
 *
 *   TaskQueryEngine → ViewEngine → DashboardEngine → (Telegram / 未来的
 *   Web / App / 语音助手)
 *
 *   这条链路里任何一层都不直接依赖"Telegram"这个呈现介质——ViewEngine 和
 *   DashboardEngine 产出的是纯数据/纯文本，不是 Telegram 消息格式。这意味着
 *   未来如果本项目被 Web 前端或语音助手复用，可以直接复用 ViewEngine +
 *   DashboardEngine 这两层，只需要新写一层"呈现"逻辑替换
 *   06_TaskIntentParser，不需要碰 Query/View/Dashboard 三层的任何代码。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - 少维护一张表，少一处需要跟着 Schema 变更走迁移流程的地方
 *   - 不存在"Dashboard Sheet 跟 Tasks 数据不一致"这类 bug 的可能性
 *     （因为 Dashboard 每次都是现查现算，不可能 stale）
 *   - Engine 分层职责单一，未来换前端（Web/App/语音）只需要换呈现层
 *
 * 需要接受的代价：
 *   - 每次查询 Dashboard 都要重新扫一遍 Read Model + 现算 ViewEngine/
 *     AnalyticsEngine——在当前数据量级（个人任务系统，几百到几千行）下
 *     完全不是问题；如果未来数据量大到需要缓存，应该缓存的是"计算结果"
 *     本身有没有 Event 驱动的必要性（比如 TaskPriority Score，如果发现
 *     每次查询都重算很贵，可以加一张 TaskPriority 缓存表，由 TASK_CREATED/
 *     TASK_UPDATED/REMINDER_SENT 事件增量维护——这属于第2层 Projection，
 *     不影响本 ADR 关于 Dashboard 本身不落盘的结论），当前版本没有观察到
 *     这个必要性，列入 00_Project_State.gs"下一步"待将来验证。
 *
 * 相关文件：00_Project_Constitution.gs P4/P7（已改为指向本 ADR）、
 * 00_File_Map.gs（12/24/25 三个 Engine 的依赖关系图已按本 ADR 的分层描述）。
 */

// ============================================================
// ADR-2026-07-06-002：Schema Authority
// ============================================================

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-06-002
 *   Status          : Accepted
 *   Decision Date   : 2026-07-06
 *   Supersedes      : （无）
 *   Superseded By   : （无，仍然生效）
 *   Affected Modules: 15_Setup.gs（Schema 唯一权威来源）
 *   Related ADR     : ADR-2026-07-06（同属"要不要为某类关注点单独建物理
 *                     实体"这个问题，结论相反，见该 ADR 的 Related ADR 说明）
 *   Consequences    : 见下方正文
 *   Notes           : 本 ADR 是纯治理决策，不涉及任何代码改动——15_Setup.gs
 *                     现在的内容不需要动一行。
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * 本项目五张 Read Model 表（Tasks/ActiveTasks/ArchiveTasks/TaskStatistics/
 * TaskFilters）的表头定义（字段名、顺序、类型）目前只存在于一个地方：
 * 15_Setup.gs 的 setupSheets()（建表用）和 _repairOneSheetHeader_()（修复
 * 用）里各自维护一份字面量数组。这不是理想状态——同一份"标准表头"字面量
 * 在文件里出现了两次（setupSheets 一次、repairSheetHeaders 一次），
 * 如果以后加一个字段，两处都要改，忘改一处就会出现"建表建对了，修复却把
 * 表头修复成旧版本"这种细微不一致。
 *
 * 但现在还没有到"必须拆出一个独立 04_Schema.gs 文件"的程度——本项目的表
 * 结构变化频率低（V3 到 V4 半年才加了两列 + 两张表），拆出一个新文件只是
 * 把"两处字面量不一致"换成"15_Setup.gs 和 04_Schema.gs 两个文件不一致"，
 * 问题的本质（表头定义有没有单一权威来源）并没有被解决，只是徒增一个
 * 文件、一条新的依赖边（15_Setup.gs → 04_Schema.gs），却没换来任何好处。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * 建立正式规则：Schema Authority（Schema 必须有唯一权威来源），但暂不
 * 拆分代码：
 *
 *   - 目前：15_Setup.gs 是全部五张 Read Model 表 Schema 的唯一权威来源。
 *   - 15_Setup.gs 内部的 setupSheets() 和 _repairOneSheetHeader_() 各自的
 *     表头字面量数组，视为同一份权威定义的两份手工同步副本——修改任何一张
 *     表的字段时，两处必须同时改，这是本 ADR 明确要求的纪律，不是建议。
 *   - 未来触发拆分的条件（满足任一条即应该拆出独立的 04_Schema.gs，
 *     15_Setup.gs 届时只保留 Create/Repair/Migration 三类操作性函数，
 *     Schema 定义本身完全交给 04_Schema.gs 输出常量供两边引用）：
 *       (a) Read Model 表的数量超过 8 张，或
 *       (b) 单张表的字段数量频繁变化（半年内变化 3 次以上），或
 *       (c) 除了 15_Setup.gs 之外，出现第三个需要读取"标准表头是什么"的
 *           消费方（目前只有 setupSheets 和 _repairOneSheetHeader_ 两个
 *           消费方，都在同一个文件内）。
 *   - 在触发条件出现之前，不要因为"感觉应该拆得更细"而提前拆分——
 *     Architecture Principles 第7条（Single Responsibility）追求的是
 *     "职责边界清楚"，不是"文件数量越多越好"；没有第二个消费方之前，拆出
 *     独立 Schema 文件不会让职责更清楚，只会多一层间接。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - 现在不用为了满足"看起来更规范"而做一次没有实际收益的代码拆分
 *   - 触发条件写清楚了，以后真的要拆的时候，不需要重新论证"要不要拆"，
 *     只需要确认"是不是满足了这几条里的至少一条"
 *
 * 需要接受的代价：
 *   - 在拆分之前，15_Setup.gs 内部两处表头字面量仍然要靠人工纪律保持
 *     同步，理论上还是有"改了一处忘了改另一处"的风险——这个风险目前
 *     被认为可以接受（表结构变化频率低，且 15_Setup.gs 本身不大，两处
 *     字面量在同一个文件里，review 时容易发现不一致）。
 */

// ============================================================
// ADR-2026-07-06-003：Per-User Soft Lock 取代全局 ScriptLock
// ============================================================

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-06-003
 *   Status          : Accepted
 *   Decision Date   : 2026-07-06
 *   Supersedes      : （无——V4.2 的"锁等待时间 10s→3s"修复不算被取代，
 *                     那次解决的是"等太久"，这次解决的是"不该等别人"，
 *                     是两个不同维度的问题，见 Context）
 *   Superseded By   : （无，仍然生效）
 *   Affected Modules: 09_IdempotencyManager.gs
 *   Related ADR     : （无）
 *   Consequences    : 见下方正文
 *   Notes           : 本 ADR 是第二轮外部审计 MEDIUM RISK 1 的正式记录。
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * 09_IdempotencyManager.createTaskIfNotExists 用 LockService.getScriptLock()
 * 包住"读 Read Model 判重 + 写 Events + 写 Sheet"整段逻辑。GAS 的
 * ScriptLock 作用域是整个部署级别——跨所有用户、跨所有并发执行。V4.2 把
 * 等待时间从 10 秒降到 3 秒（HIGH RISK 1 修复），解决的是"排队排太久导致
 * Webhook 超时"，但没有解决更本质的问题：User B 的创建请求会被 User A
 * 完全无关的写入请求无差别锁住——哪怕两人要创建的是八竿子打不着的任务，
 * 也要排队。系统用户数一多，这种无谓排队会频繁触发 SYSTEM_BUSY，且报错
 * 的原因（"有一个陌生人也在建任务"）对被拒绝的用户来说完全不可理解。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * 用"每 chatId 一把的软锁"取代全局 ScriptLock，分两层：
 *
 *   1. Gate：一把作用域仍然是全局的 ScriptLock，但只用来保护"读
 *      CacheService + 写 CacheService"这一步本身的原子性（CacheService
 *      没有原生的 compare-and-set，需要靠这把锁補上"检查+占位"这一下的
 *      原子性）。这一步是内存级操作，耗时几毫秒，等待窗口设得很短
 *      （GATE_WAIT_MS=500ms）。
 *   2. Soft Lock：真正的业务锁，键是 chatId，存在 CacheService 里，只锁
 *      同一个用户，不同用户之间的 Soft Lock 是不同的 key，天然不冲突。
 *      设 LOCK_TTL_SECONDS=15s 作为安全过期兜底。
 *
 * 效果：不同用户之间不再因为"抢同一把全局锁"而互相排队——Gate 持有时间
 * 短到可以忽略，User B 实质上只会在"跟 User A 恰好在同一毫秒抢同一个
 * Gate"这种极小概率场景下才会有感知得到的等待，且等待时间是毫秒级而不是
 * 整个创建流程的耗时。同一个用户内部的并发请求（双击/Telegram 重试）仍然
 * 被 Soft Lock 严格拦截，行为跟原来一致。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - 不同用户之间的创建请求不再互相阻塞，解决了"系统用户越多、
 *     SYSTEM_BUSY 越频繁"这个原来会随用户规模变差的问题
 *   - 对外契约不变：拿不到锁仍然抛 "SYSTEM_BUSY:" 前缀的 Error，
 *     06_TaskIntentParser.gs 的 catch 逻辑不用改一行
 *
 * 需要接受的代价（不回避）：
 *   - CacheService 本身不提供原子操作，Gate 解决的是"检查+占位"这一步的
 *     原子性，但如果 GAS 执行在 Gate 释放之后、finally 释放 Soft Lock
 *     之前被平台强制中断（理论上只有撞到 6 分钟硬上限这种极端情况才会
 *     发生，正常创建任务的耗时远远够不到），Soft Lock 会一直占用到
 *     LOCK_TTL_SECONDS 过期才自动释放——这是"最终会自愈"而不是"绝对
 *     不会发生"，比原来 ScriptLock"进程结束必然释放"的保证弱一点。
 *   - DeduplicationEngine.findExistingTask（防线3）作为最终兜底的角色不变，
 *     仍然是即使前两层软锁都侥幸被绕过时的最后一道防线；这次修复没有
 *     让系统变得"完全不可能重复创建"，只是把"绝大多数情况下靠强互斥锁
 *     保证"换成了"绝大多数情况下靠软锁保证，极端情况下靠 identity 判重
 *     兜底"，用一点点理论上的严谨性换取实际的并发表现。
 *   - 单元测试层面这个改动几乎无法在 GAS 编辑器里做真正的并发验证（见
 *     09_IdempotencyManager.gs 的 testDifferentChatsDontBlock 函数头注释），
 *     真实并发表现需要用多个真实 Telegram 用户同时发消息验证。
 */

// ============================================================
// ADR-2026-07-06-004：Projection 消费端必须对重复事件保持幂等
// ============================================================

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-06-004
 *   Status          : Accepted
 *   Decision Date   : 2026-07-06
 *   Supersedes      : （无）
 *   Superseded By   : （无，仍然生效）
 *   Affected Modules: 10_ProjectionEngine.gs（当前落地：projectTaskCompleted_/
 *                     projectTaskCancelled_）
 *   Related ADR     : ADR-2026-07-06-003（Per-User Soft Lock——两条 ADR
 *                     一起构成"生产者尽力去重 + 消费者天然幂等"这套双重
 *                     防线，见 Context）
 *   Consequences    : 见下方正文
 *   Notes           : 本 ADR 是第四轮外部审计 HIGH RISK 1 的正式记录，
 *                     同时把这次修复背后的判断提升为本 OS 所有未来
 *                     Projection 消费函数都要遵守的通用规则，不只是
 *                     这两个函数的一次性 bugfix。
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * 20_TaskEngine.completeTask/cancelTask（V4.4 起）在发布事件前会检查任务
 * 当前状态，已经是终态就拦截——但这个检查本身没有加锁。真正并发场景下
 * （两个 GAS 执行几乎同时处理同一个 taskId 的完成/取消请求），两次调用
 * 都可能在对方写回 Sheet 之前读到同一份 PENDING 快照，双双通过检查，
 * 各自发布一次 TASK_COMPLETED/TASK_CANCELLED。10_ProjectionEngine.gs 的
 * projectTaskCompleted_/projectTaskCancelled_ 之前对每个到达的事件都无
 * 条件执行 _bumpStatistics_ 增量扣减/累加，两个重复事件到达后，
 * TaskStatistics 会被扣减/累加两次，产生漂移（pending_count 可能变成
 * 负数）。
 *
 * 摆在面前有两种修复思路：(a) 在 completeTask/cancelTask 入口加一把
 * per-taskId 锁，降低重复事件被发布的概率；(b) 让 Projection 消费端自己
 * 对"同一个任务收到两次终态事件"这件事保持幂等，不管重复事件因为什么
 * 原因产生、产生了几次，结果都正确。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * 选择 (b)，作为本 OS 的通用规则，而不是只给这两个函数打个补丁：
 *
 *   Projection 消费函数（10_ProjectionEngine.gs 里 dispatch() 分发到的
 *   每一个 project*_ 函数）在对 TaskStatistics 这类增量计数器做
 *   _bumpStatistics_ 之前，必须先判断"这次事件代表的状态变化，在事件
 *   发生之前是不是已经生效过一次"——如果是，跳过增量更新这一步，只让
 *   Tasks/ActiveTasks 这类"覆写为最终值"的操作照常执行（覆写同一个值/
 *   删除已经不存在的行本身就是幂等的，不需要额外判断）。
 *
 * 理由：Events 是本 OS 唯一的事实来源（Architecture Principles 第1条
 * Single Source of Truth），但"事实只会被写入一次"这个假设本身在分布式/
 * 并发场景下没有办法被生产端 100% 保证——09_IdempotencyManager.gs 的
 * Soft Lock（ADR-2026-07-06-003）已经明确写清楚了它是"尽力而为"而不是
 * "绝对互斥"。既然生产端没法保证事件绝对不重复，消费端就必须自己扛住
 * 重复——这是事件溯源架构里一条通用原则，不是本 OS 的临时补丁。
 *
 * 相应地，本次没有额外给 completeTask/cancelTask 加 per-taskId 锁——
 * 加锁只能降低重复事件出现的概率，不能保证清零；而让消费端幂等，则是
 * 不管重复事件发不发生、发生几次，结果都保证正确，是更强的保证。两者
 * 不是互斥的（以后如果有其他理由需要加锁，比如别的原因导致的竞态，
 * 仍然可以加），但作为这次的主要修复手段，消费端幂等收益更高、复杂度
 * 更低，优先选它。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - 不管未来还会不会出现新的并发路径导致重复事件（不只是这次发现的
 *     completeTask/cancelTask 双击场景），只要 Projection 消费函数遵守
 *     这条规则，TaskStatistics 就不会因为重复事件而漂移
 *   - 这条规则比"给每个可能有竞态的入口都加锁"更容易维护——以后新增
 *     Engine Contract Standard（00_Project_Constitution.gs 零之三）里的
 *     Projection 字段标 YES 的函数，写的时候就会想到要检查这一点
 *
 * 需要接受的代价：
 *   - 每个 project*_ 函数需要多读一次"事件发生前的状态"（本来就在读，
 *     比如 current 变量，多数情况下不需要额外的 Sheet I/O，只是多一个
 *     判断），不是零成本，但成本很小
 *   - 这条规则只覆盖"增量计数器"这一类操作；如果未来出现别的非幂等
 *     副作用（比如"每次事件都发一条 Telegram 通知"），需要针对那类
 *     副作用单独设计幂等策略，本 ADR 的结论不能不假思索地照搬过去
 */

// ============================================================
// ADR-2026-07-06-005：TaskStatistics 从实时投影降级为每日批量重算
// ============================================================

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-06-005
 *   Status          : Accepted
 *   Decision Date   : 2026-07-06
 *   Supersedes      : ADR-2026-07-06-004 的适用范围（该 ADR"Projection
 *                     消费端必须幂等"这条原则本身继续成立，不是被推翻，
 *                     但它在 _bumpStatistics_ 上的具体应用已经不存在了，
 *                     因为 _bumpStatistics_ 本身被移除，见 Context）
 *   Superseded By   : （无，仍然生效）
 *   Affected Modules: 10_ProjectionEngine.gs（移除 _bumpStatistics_ /
 *                     _adjustStatisticsForUpdate_）、
 *                     11_ProjectionRebuilder.gs（新增
 *                     recomputeStatisticsFromTasks_() /
 *                     triggerDailyStatisticsRecompute()）、
 *                     15_Setup.gs（新增每日触发器）
 *   Related ADR     : ADR-2026-07-06-004（Projection 消费端幂等——这条
 *                     ADR 记录的问题被本次修复"顺带"解决了，不是因为
 *                     004 的方案错了，而是发现了更彻底、成本更低的解法）
 *   Consequences    : 见下方正文
 *   Notes           : 第五轮外部审计 HIGH RISK 1 + HIGH RISK 4 的正式
 *                     记录，两条发现指向同一个架构决策。
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * TaskStatistics 从 V4 起由 10_ProjectionEngine.gs 在每个 Task 生命周期
 * 事件（create/update/complete/cancel/reminder）触发时同步做增量更新
 * （_bumpStatistics_：读一行、内存里加减、写回）。第五轮外部审计同时指出
 * 两个问题：
 *
 *   HIGH RISK 1：_bumpStatistics_ 的"读-改-写"不是原子操作。同一 chatId
 *   的两个并发请求（哪怕是两个完全不同的任务，比如同一用户几乎同时完成
 *   两个不同的待办事项）会同时读到同一份旧统计行，其中一个的增量会被
 *   另一个覆盖丢失（lost update），TaskStatistics 的计数器永久性漂移。
 *
 *   HIGH RISK 4：12_TaskQueryEngine.getStatistics()（本 OS 里 /stats
 *   指令实际调用的函数）早就完全不读 TaskStatistics 这张表——V4 设计
 *   TaskStatistics 时就留了一句"这里现算，TaskStatistics 表仍然维护，
 *   供未来需要跨 chatId 聚合总览时用"，但"未来的需要"至今没有出现，
 *   而"同步维护"这个代价一直在稳定支付：每一次 create/update/complete/
 *   cancel/reminder，都在为一张零查询依赖的表额外付一次 Sheet 读写。
 *
 * 这两个问题不是相互独立的两件事，而是同一件事的两个侧面：一条被证实
 * 没人依赖、纯属浪费的同步写入路径，同时还不是线程安全的。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * 不给 _bumpStatistics_ 加锁（那样只会让 HIGH RISK 4 更严重——花更多时间
 * 去做一件已经证明没人需要做实时的事）。而是采纳 HIGH RISK 4 审计原文
 * 自己给出的方向：把 TaskStatistics 从"事件驱动的实时投影"降级为"低频、
 * 异步的每日批量维护"：
 *
 *   - 10_ProjectionEngine.gs 的 dispatch() 分发到的 5 个 project*_ 函数
 *     全部移除 _bumpStatistics_ 调用；_bumpStatistics_ 和
 *     _adjustStatisticsForUpdate_（V4.2 专门为处理 TASK_UPDATED 场景写的
 *     增量调整逻辑）两个函数本体一并删除。
 *   - 新增 11_ProjectionRebuilder.recomputeStatisticsFromTasks_()：从
 *     Tasks 表（不是 Events）按 chat_id 分组重新聚合，整体覆写
 *     TaskStatistics。之所以从 Tasks 表算而不是从 Events 重放算（后者是
 *     rebuildStatisticsProjection() 已经在做的事）：Tasks 本身已经是
 *     可信的 Read Model（有自己的一致性保障和 rebuildTasksProjection()
 *     兜底），从它聚合比重放全部历史 Events 便宜得多，也不需要每天都去
 *     摸一遍那张只增不减、持续变大的 Events 表。
 *   - 15_Setup.gs 新增每日触发器 triggerDailyStatisticsRecompute()
 *     （凌晨3点，跟冷归档的凌晨2点错开）。
 *   - TaskStatistics 的表和 Schema 都不删除——万一未来真的出现
 *     "跨 chatId 聚合总览"的查询需求，这张表还在，只是语义变成"最多
 *     24 小时前的快照"而不是"实时值"。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - HIGH RISK 1（并发 lost update）自动消失——批量重算是"从当前状态
 *     完整重新计算"，不是"在旧值上累加"，没有"读-改-写"竞争这个概念
 *   - HIGH RISK 4（冗余同步写入）直接解决——create/update/complete/
 *     cancel/reminder 五条路径都少了一次 Sheet I/O
 *   - 09_IdempotencyManager.gs 的并发处理（Gate+Soft Lock，
 *     ADR-2026-07-06-003）现在只需要为"创建路径的去重判断"负责，不用
 *     再间接为 TaskStatistics 的准确性兜底，职责更单一
 *
 * 需要接受的代价：
 *   - TaskStatistics 现在最多有 24 小时的延迟（如果真的有查询路径需要
 *     "刚刚发生的变化立刻反映在统计里"，这张表不再满足这个要求——但
 *     目前没有任何查询路径提出过这个要求，getStatistics() 本来就是现算）
 *   - 如果 setupSheets()/createTriggers() 是旧版本部署的，需要重新跑一次
 *     createTriggers() 才能补上新的每日触发器（15_Setup.gs 已在文件头
 *     注明）
 *   - ADR-2026-07-06-004 记录的"Projection 消费端必须幂等"这条原则，
 *     它当初的具体应用场景（_bumpStatistics_）已经不存在，但原则本身
 *     对本 OS 未来任何新增的、真正需要同步增量维护的 Read Model 仍然
 *     适用，不能因为这次的问题被绕开就忘记这条原则
 */

// ============================================================
// ADR-2026-07-11-006：21_RecurringEngine.gs 复用
// 09_IdempotencyManager.gs 的幂等去重路径（Dependency Rules 唯一例外，
// 补记归档）
// ============================================================

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-11-006
 *   Status          : Accepted
 *   Decision Date   : 2026-07-11（本条 ADR 的归档日期——决定本身在 V4.3
 *                     就已经实现并生效，见 00_Project_Constitution.gs
 *                     零之四；本条是 00_Architecture_Review.gs Finding
 *                     D1-1 触发的补记，不是新做一次决定，Decision/
 *                     Consequences 描述的是当初实际做出、现在仍然生效
 *                     的那个决定）
 *   Supersedes      : （无）
 *   Superseded By   : （无，仍然生效）
 *   Affected Modules: 21_RecurringEngine.gs, 09_IdempotencyManager.gs
 *   Related ADR     : （无——这是 Dependency Rules 层面的决定，跟其它
 *                     几条 ADR 关注的问题维度不同）
 *   Consequences    : 见下方正文
 *   Notes           : 本 ADR 是 00_Architecture_Review.gs（UEF v1.0
 *                     Domain Profile Review #1）Finding D1-1 的正式记录
 *                     之一——审查发现这个决定虽然论证充分，但只写在
 *                     Constitution 零之四的行内注释里，没有对应的正式
 *                     ADR 条目，不满足 UEF Constitution §5.2 对
 *                     "Won't fix / 维持现状"类决定"必须能引用一条 ADR"
 *                     的要求。本条只是把已经存在、已经生效的论证正式
 *                     归档到它该在的地方，不重新审视这个决定本身是否
 *                     应该改变（UEF 00_Review_Framework.md §6：Review
 *                     不重新审判已有决定）。
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * 00_Project_Constitution.gs「零之四、Dependency Rules」把本项目内部
 * 分成 Presentation → Application → Domain → Infrastructure 四层，规则
 * 是依赖只能往下指，Domain 层不得依赖 Application 层。
 * 21_RecurringEngine.gs（Domain 层，负责 recurring 规则/下一次到期日
 * 计算/续期生命周期）的 spawnNextIfNeeded()——完成一个 recurring 任务后
 * 自动生成"下一次"实例——需要保证这个"下一次实例"的创建走跟用户手动
 * 建任务完全一样的幂等去重判断（同一个 identity 判重逻辑），否则如果
 * 同一个到期事件因为某种原因被处理两次（比如 completeTask 被重复调用），
 * 会生成两条重复的下一次实例。而幂等去重判断目前只存在于
 * 09_IdempotencyManager.gs（Application 层）的 createTaskIfNotExists()
 * 里。
 *
 * ── Options Considered ───────────────────────────────────────────────────
 *
 * 1. 复用 09_IdempotencyManager.createTaskIfNotExists()——
 *    21_RecurringEngine.gs 直接调用它，接受"这是本 OS 唯一一处 Domain
 *    依赖 Application"这个对 Dependency Rules 的例外。
 * 2. 在 21_RecurringEngine.gs 内部重新实现一遍幂等判重逻辑，保持
 *    Dependency Rules 零例外。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * 选项 1：复用 09_IdempotencyManager.createTaskIfNotExists()，接受这一处
 * 有名有姓、边界清楚的例外，并在 00_Project_Constitution.gs 零之四
 * 「已知例外」明确记录、承诺"不再新增第二个"。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - "下一次 recurring 实例"和"用户手动建任务"永远走同一套判重逻辑，
 *     不存在两条判重代码长期演进出行为差异的风险
 *   - 不需要在 21_RecurringEngine.gs 里维护一份平行的幂等/锁逻辑
 *
 * 需要接受的代价：
 *   - Dependency Rules 从"零例外"变成"一个例外"，本 OS 承诺这个例外
 *     数量不再增加（见 00_Roadmap.gs「六、Architecture Evolution」）——
 *     如果未来出现第二个类似需求，应该先考虑能不能调整 Engine 职责边界
 *     避免它，而不是默认再记一条例外
 *   - 选项 2（重新实现一遍）本可以保持"零例外"这个更干净的状态，被否决
 *     的原因是：两套判重逻辑要保持同步演进，长期看比"记录一个例外"风险
 *     更大——这个权衡在 21_RecurringEngine.gs 的需求没有发生实质变化前，
 *     应该持续成立
 */

// ============================================================
// ADR-2026-07-11-007：05_SheetUtils.gs / 09_TemporalParser.gs
// 裸全局工具函数维持现状，不包进命名空间（补记归档）
// ============================================================

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-11-007
 *   Status          : Accepted
 *   Decision Date   : 2026-07-11（本条 ADR 的归档日期——这项评估在
 *                     V4.5 LOW RISK 1 首次做出，V4.6 MEDIUM RISK 3
 *                     复核后维持同一判断，本条是 00_Architecture_
 *                     Review.gs Finding D1-1 触发的补记，两轮评估的
 *                     结论和理由都不变，只是把它从"审计发现记录"补记成
 *                     正式 ADR）
 *   Supersedes      : （无）
 *   Superseded By   : （无，仍然生效——但见下方 Consequences，这是一条
 *                     "当前判断"，不是"永久判断"）
 *   Affected Modules: 05_SheetUtils.gs, 09_TemporalParser.gs
 *   Related ADR     : （无）
 *   Consequences    : 见下方正文
 *   Notes           : 本 ADR 是 00_Architecture_Review.gs Finding D1-1
 *                     的正式记录之一——这项"维持现状"的判断此前两轮
 *                     （V4.5 LOW RISK 1 / V4.6 MEDIUM RISK 3）都只记录
 *                     在 00_Project_State.gs 的审计历史和
 *                     05_SheetUtils.gs 文件头，没有对应的正式 ADR 条目，
 *                     不满足 UEF Constitution §5.2 对"Won't fix"类
 *                     disposition"必须能引用一条 ADR"的要求。本条同样
 *                     只是补记归档，不重新评估这个判断本身。
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * 05_SheetUtils.gs 和 09_TemporalParser.gs 里有十几个裸全局函数（不包在
 * 任何 IIFE/命名空间里，比如 getSheet_/getHeaderMap_/parseDueDate_/
 * round1_/round2_ 等）——这是历史遗留（这两个文件是从 Core 项目"逐字
 * 未改"继承的共用工具文件，见 00_File_Map.gs Foundation 分类）。GAS 的
 * 全局命名空间是扁平的：如果本项目未来任何一个文件不小心定义了同名
 * 函数，会静默覆盖这里的声明，不会报错，只会在运行时出现难以定位的
 * 业务异常。这个风险在 V4.5 外部审计 LOW RISK 1 被提出，V4.6 MEDIUM
 * RISK 3 复核时再次确认属实。
 *
 * ── Options Considered ───────────────────────────────────────────────────
 *
 * 1. 把这十几个函数包进一个命名空间（比如 SheetUtils.getSheet_(...)/
 *    TemporalParser.parseDueDate_(...)），同步修改项目里几乎所有调用点。
 * 2. 维持现状，不做这次重构，只记录风险和触发重新评估的条件。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * 选项 2：维持现状。这是"当前阶段"的判断，不是"永久不做"的判断——见
 * Consequences 里"什么情况下应该重新评估"。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - 避免了一次牵动项目里几乎所有调用点的大范围重构，这类重构本身就
 *     有引入新 bug 的风险，尤其是在"这几轮审计的前提是不改架构/不做
 *     重构"的背景下（V4.5 LOW RISK 1 记录的原话）
 *
 * 需要接受的代价（不回避）：
 *   - 命名冲突风险本身没有消除，只是被判断为"当前发生概率低、一旦发生
 *     难以快速定位"这类风险，选择继续承担
 *   - 这个判断已经连续两轮被复核（V4.5→V4.6）而结论不变，如果不设定
 *     一个会触发"这次真的该做了"的具体条件，容易变成"每次都用同一个
 *     理由拖延，从来不重新评估"——本条 ADR 正式设定触发条件：(a) 本
 *     项目新增第三个共用工具文件、且同样需要裸全局函数模式时，或
 *     (b) 命名冲突真的发生过一次（哪怕只是开发过程中被发现，未流入
 *     生产）时，无论哪个先发生，都应该重新打开这个决定，不能再套用
 *     "投入产出不成比例"这个理由不做评估就直接维持现状
 */

// ============================================================
// ADR-2026-07-13-008：Due Time Support — identity 计算方式与
// due_datetime 空值语义
// ============================================================

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-13-008
 *   Status          : Accepted
 *   Decision Date   : 2026-07-13
 *   Supersedes      : （无）
 *   Superseded By   : （无，仍然生效）
 *   Affected Modules: 07_IdentityEngine.gs, 09_IdempotencyManager.gs,
 *                     20_TaskEngine.gs, 21_RecurringEngine.gs,
 *                     11_ProjectionRebuilder.gs
 *   Related ADR     : ADR-2026-07-06-002（Schema Authority——本次新增
 *                     due_time/due_datetime 两列走的是该 ADR 已经定义
 *                     好的"向后兼容追加列"迁移模式，不是新模式）
 *   Consequences    : 见下方正文
 *   Notes           : 完整设计过程见 00_Architecture_Review.gs「七、
 *                     Review #3」，Carson 2026-07-13 批准后实现。
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * Due Time Support 给 Task 新增 due_time/due_datetime 两个字段后，有两个
 * 设计点会长期影响这个 Schema 怎么被使用，值得正式记录而不只是留在
 * Review 文档里：
 *
 * (1) 07_IdentityEngine.generateTaskIdentity(chatId, title, dueDate,
 *     repeatRule, priority, category) 的 dueDate 参数位，以后应该继续
 *     只接受 due_date，还是要感知 due_time？
 *
 * (2) due_datetime 在"只有 due_date、没有 due_time"时，应该是空字符串，
 *     还是默认成"该日期 00:00:00"？
 *
 * ── Options Considered ───────────────────────────────────────────────────
 *
 * 关于 (1)：
 *   A. 修改 generateTaskIdentity() 签名，新增第七个参数 dueTime，函数
 *      内部自己拼接。
 *   B. 签名不变，调用方在 dueDate 参数位传入"有 due_time 就用合并后的
 *      due_datetime，否则退回 due_date"这个值——即本次新增的
 *      07_IdentityEngine.resolveIdentityDueValue(task) 辅助函数。
 *
 * 关于 (2)：
 *   A. due_datetime 默认成"该日期 00:00:00"，任何有 due_date 的任务都有
 *      一个可用的 due_datetime。
 *   B. due_datetime 只在真的有 due_time 时才非空，否则是空字符串。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * (1) 选项 B：不改 generateTaskIdentity() 签名，新增
 *     resolveIdentityDueValue() 辅助函数解析出正确的传入值。
 *
 * (2) 选项 B：due_datetime 没有具体时间时为空字符串，不默认成午夜。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - (1) 选项 B 让全部存量任务（due_time 恒为空）的 identity 哈希在
 *     迁移前后逐字节不变——这是一条可以直接写单元测试验证的具体不变量
 *     （见 07_IdentityEngine.testIdentity() 新增的第 5/6 组断言），不是
 *     "应该没问题"这种无法验证的说法。
 *   - (1) 同时保留了"相同标题+不同 due_date（含不同 due_time）→ 不同
 *     identity"这条早在 V3 就已经生效的行为——此前自然语言解析器偶尔
 *     把时间折叠进 due_date 字符串本身，这条效果是间接成立的，现在变成
 *     显式规则，不是新引入的行为变化。
 *   - (2) 选项 B 避免了"用户真的说了凌晨0点"和"用户根本没提具体时间"
 *     这两种情况在 due_datetime 这一个字段上变得无法区分——这正是
 *     Review #3 发现的、现有系统里已经存在的同一种歧义（09_TemporalParser
 *     此前偶尔把时间嵌进 due_date 字符串，但从没有一个显式字段回答
 *     "这个任务到底有没有具体时间"这个问题），选择空字符串能让这个歧义
 *     被结构性地解决，而不是从"字符串格式里的隐含歧义"平移成"数值
 *     默认值带来的同一个歧义"。
 *
 * 需要接受的代价（不回避）：
 *   - (1) resolveIdentityDueValue() 是一个新增的间接层——以后任何人读
 *     "identity 到底是怎么算出来的"，需要多看一个函数才能看全，不是
 *     所有输入都在 generateTaskIdentity() 一处摊开。这是刻意的取舍：
 *     用一层薄薄的间接换取"4 个调用点不用各自重复同一句 fallback 表达式"
 *     （08_Review_Knowledge_Base.md KB-2 的教训）和"签名不用破坏性变更"
 *     两个好处。
 *   - (2) due_datetime 为空不代表"这个任务没有到期时刻"——它只代表
 *     "没有比 due_date 更精确的信息"。任何未来消费 due_datetime 的代码
 *     （比如 Reminder OS，如果/当它开始读这个字段）必须自己处理"空
 *     due_datetime 但有 due_date"这种情况，不能假设 due_datetime 永远
 *     非空。这条代价已经在 00_Known_Limitations.gs 补记，避免以后被
 *     当成遗漏去修。
 *   - 两条决定都只覆盖 Productivity OS 自己的 Task 概念——如果未来
 *     Reminder OS/其他 Domain OS 也有类似"精确到期时刻"的需求，需要
 *     各自评估是否适用同样的空值语义，不能假设这条 ADR 自动约束别的
 *     项目。
 */

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-15-009
 *   Status          : Accepted
 *   Decision Date   : 2026-07-15
 *   Supersedes      : （无——细化 ADR-2026-07-06-003，不是取代）
 *   Superseded By   : （无）
 *   Affected Modules: 09_IdempotencyManager.gs（Soft Lock key）、
 *                     21_RecurringEngine.gs（spawnNextIfNeeded 重试与失败
 *                     信号）、20_TaskEngine.gs（completeTask 转发失败信号）、
 *                     06_TaskIntentParser.gs（TASK_DONE 回复文案）
 *   Related ADR     : ADR-2026-07-06-003（Per-User Soft Lock，本条在此基础
 *                     上进一步收紧粒度）、ADR-2026-07-06-004（Projection
 *                     幂等消费，同一套"防止重复"的纵深防御体系里的另一层）
 *   Consequences    : 见下方正文
 *   Notes           : 第六轮外部审计 HIGH RISK 1 的正式记录
 *
 * ── Context ───────────────────────────────────────────────────────────────
 *
 * ADR-2026-07-06-003 把 Soft Lock 从全局 ScriptLock 收紧到 per-chatId，
 * 解决了"不同用户互相阻塞"的问题。但第六轮外部审计指出一个当时没有被
 * 覆盖到的场景：同一个 chatId 在短时间内并发触发两次*不同*任务的创建——
 * 最典型的例子是 21_RecurringEngine.spawnNextIfNeeded 在几乎同一时刻为
 * 同一用户的两个不同 recurring 任务生成下一次实例（比如用户在 Telegram
 * 上几乎同时点击完成了两个不同的重复任务）。这两次调用会因为共用同一把
 * chatId 级别的锁而互相拦截，其中一次会拿到
 * SYSTEM_BUSY_RETRY_IN_PROGRESS。
 *
 * 真正的问题不是"被锁挡住"本身（ADR-003 的原始设计里，同一用户内部的
 * 并发请求本来就应该被严格拦截，这是"Telegram 重试同一条消息"场景需要的
 * 行为）——而是 spawnNextIfNeeded 内部有一个宽泛的 try/catch，把包括
 * SYSTEM_BUSY 在内的所有异常一律静默吞掉。ADR-003 设计的"拦截+fail-fast，
 * 让上游重试"这个模式，隐含假设是"调用方是一次外部 webhook 请求，fail
 * 之后外部会自然重试"——但 spawnNextIfNeeded 是系统内部调用，没有任何
 * 外部重试机制，fail-fast 在这里等于永久丢弃。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * 分两部分修复，缺一不可：
 *
 * (1) 09_IdempotencyManager.gs：Soft Lock 的 key 从 chatId 改成 identity。
 *     identity 本身的哈希组成就包含 chatId（07_IdentityEngine.
 *     generateTaskIdentity 的第一个分量），所以这个改动只会让锁"更精确"：
 *     同一 identity 的真正重复请求（比如 Telegram 对同一条消息的 webhook
 *     重试）仍然会争用同一把锁、仍然严格串行，行为跟 ADR-003 设计的
 *     "防止重复创建"这个初衷完全一致；唯一变化的是"同一用户但不同
 *     identity"的两个请求不再需要互相排队。Gate（瞬时全局锁，保护
 *     CacheService 检查+占位这一步的原子性）不受影响。
 *
 * (2) 21_RecurringEngine.gs：spawnNextIfNeeded 作为纵深防御，对
 *     SYSTEM_BUSY 类错误做有限次数（3次）的线性退避重试——(1) 的修复
 *     之后，本来就该很少见的场景变得更加罕见，重试主要是给 Gate 层极端
 *     并发这种更罕见的残余情况兜底。重试仍然失败、或者遇到任何非
 *     SYSTEM_BUSY 的错误（不重试——对确定性失败没有意义），不再返回
 *     跟"这本来就不适用"完全无法区分的裸 null，而是返回
 *     { spawn_error: true, message }。这个信号沿 20_TaskEngine.
 *     completeTask → 06_TaskIntentParser.gs 一路转发，最终让用户在
 *     "完成"回复里看到"续期没成功"的提示——但"完成这一次"本身依然保证
 *     成功，不受续期失败影响，这条 ADR-003 就已经确立的原则不变。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - 同一用户的不同 recurring 任务并发续期不再互相阻塍，这是本次审计
 *     描述的主要场景，由 (1) 直接解决。
 *   - 即使收紧粒度之后仍然理论上可能撞见的残余 SYSTEM_BUSY（Gate 层
 *     极端并发），由 (2) 的重试兜住，绝大多数情况下用户根本不会看到
 *     任何影响。
 *   - 万一重试仍然失败，用户第一次能够看到"续期失败"这件事本身（此前
 *     是完全静默的），可以自己决定要不要手动补建下一次任务——这是本条
 *     ADR 相对 ADR-003 的关键改进：不只是"减少冲突"，还把"冲突之后
 *     怎么办"这件事从"悄悄丢弃"变成"用户可见、可行动"。
 *
 * 需要接受的代价（不回避）：
 *   - identity 级别的锁比 chatId 级别的锁多了一次
 *     IdentityEngine.resolveIdentityDueValue() 的计算成本——这个计算本身
 *     很轻量（字符串拼接+哈希），可以忽略不计。
 *   - spawnNextIfNeeded 的重试会让 completeTask 的响应时间在遇到繁忙冲突
 *     时增加最多约 2.4 秒（3次重试的线性退避总和）——这是有意识的取舍：
 *     用偶尔增加的一点延迟换取"续期不会无声丢失"，对一个 Telegram Bot
 *     场景来说，多等 2 秒远比"任务默默消失、用户自己都不知道该去查"
 *     划算。
 *   - 这条 ADR 不改变"同一个 identity 的重复请求仍然被严格拦截"这个
 *     ADR-003 就已经确立的行为——如果未来出现"同一用户需要真正并行地
 *     创建两个逐字相同的任务"这种此前从未设想过的新需求，需要重新评估，
 *     不能假设这条 ADR 自动允许那种场景。
 */

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-15-010
 *   Status          : Accepted
 *   Decision Date   : 2026-07-15
 *   Supersedes      : （无——EventBus.publish 与 Read Model 同步更新这个
 *                     核心行为本身不变，只改变"内部怎么找到该通知谁"这个
 *                     实现细节）
 *   Superseded By   : （无）
 *   Affected Modules: 02_EventBus.gs（新增 subscribe/_subscribers，publish
 *                     内部改为订阅者循环）、10_ProjectionEngine.gs（文档
 *                     说明，dispatch 函数本体不变）、15_Setup.gs（新增
 *                     Composition Root 小节，注册
 *                     EventBus.subscribe(ProjectionEngine.dispatch)）
 *   Related ADR     : （无直接前置 ADR——这是 EventBus/ProjectionEngine
 *                     关系第一次被正式记录为 ADR，此前这层耦合只在两个
 *                     文件各自的 Engine Contract 里以 Dependencies/
 *                     Forbidden Dependencies 字段隐含存在）
 *   Consequences    : 见下方正文
 *   Notes           : 第六轮外部审计 MEDIUM RISK（原文档5）的正式记录
 *
 * ── Context ───────────────────────────────────────────────────────────────
 *
 * EventBus.publish() 原来的实现里，硬编码检查
 * `typeof ProjectionEngine !== 'undefined'` 再直接调用
 * `ProjectionEngine.dispatch(event)`。EventBus 作为本项目"发布事件"这个
 * 概念的唯一入口，因此必须在源码层面"认识"ProjectionEngine 这个具体
 * 名字——如果未来想接入除 Projection 以外的第二个消费方（比如异步队列、
 * 中间件、离线场景只发布不投影），或者想把 Projection 换成完全不同的
 * 实现，都得回来改这份"本该是通用总线"的代码，这是一种不必要的架构
 * 刚性。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * EventBus 新增通用的 subscribe(handler) / _subscribers 订阅者列表，
 * publish() 内部改成遍历订阅者依次调用（每个订阅者独立 try/catch）。
 * EventBus 自己不再在任何地方出现"ProjectionEngine"这个字面名字——
 * 依赖方向彻底反过来，变成"谁关心 Event 就自己（或者由 Composition Root
 * 代为）来订阅"，不是"EventBus 主动认识谁"。
 *
 * ProjectionEngine 的注册代码不能放在 10_ProjectionEngine.gs 自己文件里
 * ——该文件的 Engine Contract 明确写着 Forbidden Dependencies 包含
 * 02_EventBus.gs（不得反向调用），这是为了防止
 * publish→dispatch→（万一）反过来调 publish 形成调用环，这条既有规则
 * 本条 ADR 不改变。注册逻辑改放在 15_Setup.gs（Application 层，被
 * 00_Project_Constitution.gs 零之四明确允许同时依赖 EventBus 和
 * ProjectionEngine 两个 Infrastructure 层模块），作为本项目的
 * Composition Root，不需要为此新增一条"已知例外"。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - EventBus 变成真正通用的总线，未来注册额外订阅者（比如异步处理、
 *     多播到其它系统）不需要再改 EventBus.gs 本身一行代码。
 *   - 依赖方向符合 Clean Architecture 的一般原则：底层组件（EventBus）
 *     不认识上层/同层的具体消费者，消费者自己注册。
 *   - 运行时行为完全向后兼容——目前只注册了 ProjectionEngine 一个订阅者，
 *     event.projection_ok 字段的语义、_alertAdminProjectionFailure_ 的
 *     告警文案和触发条件都不变。
 *
 * 需要接受的代价（不回避）：
 *   - 15_Setup.gs 新增了一段不属于任何函数体、直接写在顶层的可执行
 *     wiring 语句——这是该文件目前唯一一处这种写法（其余全部是需要手动
 *     调用的函数），依赖 GAS"每次执行都会先跑一遍全部顶层代码"这个隐含
 *     行为。这不是本项目第一次依赖这个假设（编号前缀 00/01/02.../26 本来
 *     就是刻意利用文件加载顺序），但确实是第一次利用它来做"跨文件方法
 *     注册"而不只是"定义好独立可用的模块"，需要在 15_Setup.gs 里保留
 *     足够的注释说明，避免以后被误当成可以随意删除的死代码。
 *   - event.projection_ok 这个字段名保留了"projection"这个具体字眼，
 *     没有跟着这次通用化改成更抽象的名字（比如 subscribers_ok）——目前
 *     确实只有 ProjectionEngine 一个订阅者，字段名语义完全准确，属于
 *     "不为了理论上的通用性提前抽象"的刻意选择；如果未来注册了第二个
 *     订阅者并且它也可能失败，需要重新评估这个字段是否还够精确，届时
 *     再改，不是现在就要解决的问题。
 *   - 本文件是跟 Personal AI Core 独立演进的本地副本（见 02_EventBus.gs
 *     文件头），本条 ADR 和这次改动只覆盖 Productivity OS 自己这份
 *     副本，不影响 Core 项目的独立副本——Core 是否有同样的耦合、是否
 *     需要同样的修复，需要在 Core 项目里单独评估，本条 ADR 不能替 Core
 *     项目下结论。
 */

/**
 * ── Metadata ──────────────────────────────────────────────────────────────
 *   ADR Number      : ADR-2026-07-17-011
 *   Status          : Accepted
 *   Decision Date   : 2026-07-17
 *   Supersedes      : （无）
 *   Superseded By   : （无，仍然生效）
 *   Affected Modules: 06_TaskIntentParser.gs, 09_TemporalParser.gs,
 *                     20_TaskEngine.gs, 15_Setup.gs,
 *                     11_ProjectionRebuilder.gs, 00_Known_Limitations.gs
 *   Related ADR     : ADR-2026-07-06-002（Schema Authority——本次新增
 *                     reminder_policy 一列走的是该 ADR 定义好的"向后兼容
 *                     追加列"迁移模式）；ADR-2026-07-13-008（Due Time
 *                     Support——这次解析范围扩展沿用同一套"确定性时间
 *                     解析 vs. 语义判断"测试）；Reminder OS 侧
 *                     00_ADR_006_Reminder_Policy_Override.gs（对称的另
 *                     一半决策，覆盖 Reminder OS 如何消费这个字段）
 *   Consequences    : 见下方正文
 *   Notes           : 完整跨项目架构审查见
 *                     Reminder-Policy-Override_Architecture-Review.md，
 *                     Carson 2026-07-17 批准后实现。
 *
 * ── Context ──────────────────────────────────────────────────────────────
 *
 * 原始需求：用户创建任务时可以直接覆盖 Reminder OS 的默认提醒策略
 * （"remind me 30 minutes before"这类短语）。三个需要正式记录的设计点：
 *
 * (1) 覆盖信息（reminder_policy）该长在哪——Task 记录上，还是 Reminder OS
 *     自己的表？
 *
 * (2) 识别"提前N分钟/小时/天提醒"这类短语，算不算这份文档
 *     00_Known_Limitations.gs 里"自然语言解析范围止于 due_date/recurring"
 *     这条既有边界该扩展的对象？
 *
 * (3) 这个字段该不该影响 IDENTITY_AFFECTING_FIELDS / UPDATABLE_FIELDS？
 *
 * ── Options Considered ───────────────────────────────────────────────────
 *
 * 关于 (1)：
 *   A. reminder_policy 作为 Task 的一个新字段，Productivity OS 负责解析
 *      和存储，Reminder OS 通过既有只读通道（QueryEngine.getPendingTasks()）
 *      读取。
 *   B. Personal AI Core 直接调用 Reminder OS 的 Connector，写入 Reminder
 *      OS 自己的规则表——需要先给 Reminder OS 的 Connector 打开写能力
 *      （现状六个写操作全部 supported:false，且 Reminder OS Constitution
 *      P2 明确"不接受被当 Library 调用、不接 webhook"）。
 *
 * 关于 (2)：
 *   A. 沿用跟 due_time 那次一样的判断标准（是否需要语义/领域判断），
 *      认定 offset 短语属于确定性时间解析，扩展既有边界。
 *   B. 认定这是一种新的、不同类的能力，需要一条全新的、独立的边界定义。
 *
 * 关于 (3)：
 *   A. 加入 IDENTITY_AFFECTING_FIELDS 和/或 UPDATABLE_FIELDS。
 *   B. 都不加——本次只覆盖 Create 流程，且提醒策略不是任务的身份特征。
 *
 * ── Decision ──────────────────────────────────────────────────────────────
 *
 * (1) 选项 A——reminder_policy 长在 Task 上。理由：ActiveTasks 投影是
 *     通用透传（10_ProjectionEngine.projectTaskCreated_ 整个 event
 *     payload upsert），Reminder OS 的 QueryEngine 按表头通用转成扁平
 *     对象——新字段不需要改这两处代码就能读到，不需要打开 Reminder OS
 *     的 Connector 写能力，也不违反该项目 Constitution P2 的独立运作
 *     原则。选项 B 影响面大得多，且是一个独立于本次需求、需要单独评估
 *     的更大决策（是否打破 Reminder OS 的自主运作原则），不应该被这次
 *     需求顺带触发。
 *
 * (2) 选项 A——扩展既有边界，不新开一条。"提前30分钟"和"tomorrow 3pm"
 *     是同一类可枚举、可正则匹配的确定性时间表达式，用的判断标准跟
 *     due_time 那次完全一样，不是新引入一条。
 *
 * (3) 选项 B——两个字段列表都不加。reminder_policy 跟 budget/notes/
 *     description/tags 同类，是元信息不是身份特征；UPDATABLE_FIELDS
 *     的排除是范围决定（本次只做 Create），不是能力缺陷。
 *
 * ── Consequences ──────────────────────────────────────────────────────────
 *
 * 正面：
 *   - 本次改动完全不涉及 Personal AI Core、Connector Layer（08_ 前缀
 *     六个文件）——Core 现有的"整句原文转发给
 *     ProductivityConnector.execute('HandleTaskIntent', ...)"这条既有
 *     路径不需要改一行代码，offset 短语识别自然落在已经在做全部原文
 *     解析的 06_TaskIntentParser.gs/09_TemporalParser.gs 里。
 *   - reminder_policy 为 null 时（存量任务、以及本次改动之前创建的任何
 *     任务）行为逐字节不变，不需要数据回填，只需要一次 schema 迁移
 *     （migrateSchemaReminderPolicy()，模式跟 migrateSchemaDueTime()
 *     完全一致）。
 *   - _buildCreateReply_() 新增的确认文案（用户显式覆盖时才显示）是
 *     纯展示层改动，不影响任何持久化或 Reminder OS 行为，且是用户唯一
 *     能在创建当下确认"覆盖有没有被听懂"的地方。
 *
 * 需要接受的代价（不回避）：
 *   - 09_TemporalParser.gs 的 offset 短语识别是本项目独有改动（跟
 *     V4.7 due_time 那次一样），不会同步到 Personal-AI-main 自己的
 *     同名文件——如果那边以后也需要识别同样的短语，需要单独重复这次
 *     改动，不会自动生效。
 *   - 英文形式要求"remind me"字面出现、中文形式要求"提前"字面出现，
 *     都不识别裸的"30 minutes before"/"30分钟前"——这是刻意收窄换取
 *     更低的误伤率，不是遗漏（经 Node 沙盒实测确认，见
 *     09_TemporalParser.gs 函数头注释的"已知限制"）。
 *   - 多个 offset 之间必须有连接词（and / 和 / 、 / ，/ ,）——没有连接词
 *     的短语只会识别出第一个，其余留在清洗后的 title 里。原始需求文档
 *     举的例子都带连接词，这个限制不影响需求本身，但如果 Carson 实际
 *     使用中发现这个说法很常见，需要另外评估要不要放宽。
 *   - reminder_policy 不支持创建后修改（Carson 2026-07-17 决定 #2）——
 *     这不是本 ADR 的范围缺陷，是刻意的范围收窄，未来需要时应该另开
 *     ADR/Phase，不要把 UPDATABLE_FIELDS 加上这个字段当成"补一个遗漏"
 *     去做。
 */
