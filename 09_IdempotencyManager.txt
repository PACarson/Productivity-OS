/**
 * 09_IdempotencyManager.gs
 * Productivity OS v4.7 — 幂等性管理器（Task）
 *
 * 【V4.7 新增，Due Time Support，00_Architecture_Review.gs「七、
 * Review #3」，Carson 2026-07-13 批准】createTaskIfNotExists 生成
 * identity 时改用 IdentityEngine.resolveIdentityDueValue(meta) 取值，
 * 不再直接读 meta.due_date——有 due_time 时用合并后的 due_datetime，
 * 保证"改时间也让 identity 变化"这条既有行为不被新 Schema 意外改变。
 *
 * 职责：确保每个创建操作恰好执行一次（Exactly-Once Semantics）。
 * 所有模块创建 Task 必须经过本层，禁止直接 EventBus.publish('TASK_CREATED')。
 *
 * 【V4.5 修复 HIGH RISK 2：Gate 门控在高并发下的无差别阻塞】
 * GATE_WAIT_MS 从 500ms 调大到 2000ms——见下方变量声明处的完整说明。
 *
 * 【V4.5 修复 MEDIUM RISK 2：锁冲突导致的 Telegram 重试"假失败"】
 * 之前不管是"Gate 都排不上"还是"这个 chatId 已经有请求在处理中"，抛出的
 * 都是同一种 "SYSTEM_BUSY:" 前缀错误，06_TaskIntentParser.gs 统一回复
 * "这个任务没建成，请重发"——但"这个 chatId 已经有请求在处理中"这种情况
 * （典型场景：Telegram 因为响应慢发起重试，前一个请求其实还在正常处理、
 * 大概率会成功）跟"这个任务没建成"完全不是一回事，告诉用户"没建成"是
 * 误导。现在拆成两种错误前缀：
 *   - "SYSTEM_BUSY:"（不带后缀）——Gate 都没排上，这次调用大概率真的
 *     什么都没做，"请重发"是准确的建议。
 *   - "SYSTEM_BUSY_RETRY_IN_PROGRESS:"——Gate 拿到了，但这个 chatId 的
 *     Soft Lock 已经被占用，说明"你自己"有一个请求正在处理，回复应该是
 *     "正在处理，稍后再看"而不是"没建成，请重发"。
 * 06_TaskIntentParser.gs 的 TASK_CREATE 分支相应拆成两条 catch 分支。
 * ⚠️ 对外契约变化说明：这是本次唯一一个不是"纯粹新增"的地方——原来的
 * "SYSTEM_BUSY:"前缀这个大类不变（任何只检查这个前缀的旧代码依然能
 * 识别出"这是个繁忙类错误"），但如果有代码依赖"所有繁忙错误消息都是
 * 一模一样的文字"，则需要知道现在有两种文案。本项目内唯一的消费方
 * 06_TaskIntentParser.gs 已经同步更新。
 *
 * 【V4.4 修复 MEDIUM RISK 1：全局脚本锁引发的多用户并发排队】
 * 原来用 LockService.getScriptLock() 包住"读-校验-写"整段逻辑。这把锁的
 * 作用域是整个部署级别（跨所有用户），User B 的创建请求会被 User A 完全
 * 无关的写入请求无差别锁住，被迫排队——哪怕 User A 和 User B 要创建的是
 * 八竿子打不着的任务。锁等待时间在 V4.2 已经从 10s 降到 3s（HIGH RISK 1
 * 修复），但那只解决了"排队排太久导致 Webhook 超时"的问题，没解决"不同
 * 用户之间根本不该互相排队"这个更本质的问题——User B 依然会频繁遇到跟
 * 自己完全无关的 SYSTEM_BUSY。
 *
 * 修复：改成"每用户软锁"（per-chatId soft lock），分两层：
 *
 *   1. Gate（瞬时全局锁，GATE_WAIT_MS=2000ms，V4.5 起从 500ms 调大，见下方
 *      V4.5 修复说明）：只用来保护"读 CacheService+
 *      写 CacheService"这一步本身的原子性（CacheService 本身没有原子的
 *      compare-and-set，需要一把锁包住"检查+占位"这一下才能避免竞态）。
 *      这一步通常几毫秒就结束，不会像原来那样把整个"读 Sheet 判重 + 写
 *      Sheet 建任务"的耗时操作都锁在里面，所以不同用户之间几乎不会再
 *      互相阻塞——即使 User A 的创建流程要跑几百毫秒，User B 排队等的
 *      只是 User A 那次"检查+占位"的几毫秒，不是 User A 的整个流程。
 *   2. Soft Lock（每 chatId 一把，CacheService，LOCK_TTL_SECONDS=15s 安全
 *      过期兜底）：真正防止"同一个用户"并发重试的是这把锁——只锁自己，
 *      不锁别人。
 *
 * ⚠️ 诚实说明这个方案的取舍（不回避）：Gate 本身解决了"检查+占位"这一步
 * 的原子性，但如果 GAS 执行在 Gate 释放之后、finally 释放 Soft Lock 之前
 * 被平台强制中断（比如 6 分钟硬上限，正常创建任务的耗时不可能碰到这个
 * 上限，只是理论上存在），Soft Lock 会一直占着直到 LOCK_TTL_SECONDS 过期
 * 才自动释放——这是"最终会自愈"而不是"绝对不会发生"，比原来的 ScriptLock
 * （进程结束必然释放）弱一点，用这一点点弱化换来"不同用户不再互相排队"，
 * 认为是值得的取舍。DeduplicationEngine.findExistingTask（防线3）作为最终
 * 兜底不变——就算两个真正意义上的竞态请求都侥幸拿到了各自的判断窗口，
 * 最后写入前的 identity 判重仍然是最后一道防线。
 *
 * 【V4.2 修复 HIGH RISK 1：Webhook 超时与 GAS 并发限制级联失效】（历史，
 * 部分内容被 V4.4 取代，完整对照见 00_Project_State.gs）：
 * 原来 lock.waitLock(10000) 最多等 10 秒，V4.2 降到 3 秒 fail-fast。V4.4
 * 的 Soft Lock 沿用同一个"fail-fast、抛 SYSTEM_BUSY: 前缀错误"的对外契约
 * （V4.5 起细分成两种前缀，06_TaskIntentParser.gs 的 catch 逻辑相应更新
 * 了两条分支，见上方 V4.5 MEDIUM RISK 2 的说明）。
 *
 * 【V4 修复 LOW RISK 2】调用 TaskEngine.createTaskDirect_（IIFE 内部方法），
 * 不再是裸全局函数 _createTaskDirect_。
 *
 * 依赖：
 *   07_IdentityEngine, 08_DeduplicationEngine, 20_TaskEngine.gs
 *   (TaskEngine.createTaskDirect_)
 */

var IdempotencyManager = (function () {

  // 【V4.5 修复 HIGH RISK 2：Gate 在高并发下无差别阻塞】GATE_WAIT_MS 原来
  // 是 500ms。Gate 本身只保护"读 CacheService + 写 CacheService"这一步
  // （通常几十毫秒），但如果短时间内大量不同 chatId 的请求同时涌入，
  // 大家都要排队抢同一把 Gate——请求数一多，排在后面的哪怕跟任何人都不
  // 冲突，也可能因为纯粹排队耗时超过 500ms 而被误判 SYSTEM_BUSY，产生
  // "完全不冲突的用户被无差别拒绝"的问题。
  // 修复：延长到 2000ms。这是安全的——Gate 保护的操作本身耗时不变（还是
  // 几十毫秒级别），延长的只是"愿意排多久队"的上限，不会让单个请求的
  // 正常延迟变长；LockService.waitLock(ms) 内部本来就会在这个窗口内持续
  // 尝试获取锁（不是只判一次），2000ms 相对 Telegram Webhook 的重试窗口
  // （审计报告提到约7秒）仍然有充足余量，不会重新引入 V4.2 HIGH RISK 1
  // 那种"锁住整个创建流程导致 Webhook 超时"的问题——那次的锁保护的是
  // 几百毫秒到几秒的完整 Sheet 读写流程，这里的 Gate 保护的只是毫秒级的
  // 内存操作，两者不是同一类锁，等待上限可以放得更宽松而不重蹈覆辙。
  var GATE_WAIT_MS      = 2000;
  var LOCK_TTL_SECONDS  = 15;   // Soft Lock 安全过期兜底（正常释放远快于这个时间）

  // ============ 内部：per-chatId Soft Lock ============

  function _softLockKey_(chatId) {
    return 'idem_lock:' + (chatId || 'unknown_chat');
  }

  /**
   * 尝试获取某个 chatId 的软锁。
   * @returns {boolean} true=拿到了；false=这个 chatId 当前已经有请求在处理
   * @throws {Error} message 以 "SYSTEM_BUSY:" 开头 —— 连"检查+占位"这个
   *                 瞬时 Gate 都排不上，说明全站范围内正处于极端并发，
   *                 直接判定繁忙（这种情况应该极其罕见，Gate 等待窗口
   *                 通常几毫秒就能轮到）。
   */
  function _acquireSoftLock_(chatId) {
    var cache = CacheService.getScriptCache();
    var key = _softLockKey_(chatId);

    var gate = LockService.getScriptLock();
    try {
      gate.waitLock(GATE_WAIT_MS);
    } catch (gateErr) {
      Logger.log('[IdempotencyManager] Gate（瞬时锁）在 ' + GATE_WAIT_MS +
        'ms 内没拿到——全站并发极高，fail-fast: ' + gateErr.message);
      throw new Error('SYSTEM_BUSY: 系统繁忙（当前并发写入极多），请几秒后重试。');
    }

    try {
      if (cache.get(key)) {
        return false; // 这个 chatId 已经有一个请求在处理中
      }
      cache.put(key, '1', LOCK_TTL_SECONDS);
      return true;
    } finally {
      gate.releaseLock(); // Gate 只保护这一小段，立刻释放，不等到业务逻辑跑完
    }
  }

  function _releaseSoftLock_(chatId) {
    try {
      CacheService.getScriptCache().remove(_softLockKey_(chatId));
    } catch (e) {
      // Soft Lock 释放失败不影响主流程——LOCK_TTL_SECONDS 会兜底自动过期
      Logger.log('[IdempotencyManager] Soft Lock 释放失败（不影响本次结果，会在 ' +
        LOCK_TTL_SECONDS + '秒后自动过期）: ' + e.message);
    }
  }

  // ============ Task ============

  /**
   * 创建任务（幂等，并发安全——同一 chatId 严格串行，不同 chatId 互不阻塞）
   *
   * @param {string} title
   * @param {object} meta   { category, priority, due_date, due_time, due_datetime,
   *                          recurring, context, budget, notes, description, tags }
   *                        （due_time/due_datetime 为 V4.7 新增，Due Time
   *                        Support；identity 生成用 IdentityEngine.
   *                        resolveIdentityDueValue(meta) 取值，不直接读
   *                        meta.due_date，见该函数注释）
   * @param {string} chatId
   * @returns {{ task: object, created: boolean }}
   * @throws {Error}  message 以 "SYSTEM_BUSY" 开头，具体分两种（V4.5 修复
   *                   MEDIUM RISK 2 新增区分，供调用方给出不同回复文案）：
   *                   - "SYSTEM_BUSY:"（不带后缀）—— 连 Gate 都没排上，
   *                     这是真正的全站级繁忙，这次调用大概率什么都没做。
   *                   - "SYSTEM_BUSY_RETRY_IN_PROGRESS:" —— Gate 拿到了，
   *                     但这个 chatId 已经有一个请求在处理中（很可能是
   *                     Telegram 对同一条消息的重试）。这种情况下大概率
   *                     那个"在处理中"的请求会成功，不应该告诉用户
   *                     "没建成"，应该告诉用户"正在处理，稍后再看"。
   */
  function createTaskIfNotExists(title, meta, chatId) {
    meta = meta || {};

    var identity = IdentityEngine.generateTaskIdentity(
      chatId,
      title,
      IdentityEngine.resolveIdentityDueValue(meta),
      meta.recurring  || '',
      meta.priority   || 'MEDIUM',
      meta.category   || 'GENERAL'
    );

    var acquired = _acquireSoftLock_(chatId);
    if (!acquired) {
      Logger.log('[IdempotencyManager] chatId=' + chatId + ' 已有请求在处理中，fail-fast 放弃本次创建' +
        '（只影响这一个用户，不影响其他用户，大概率是 Telegram 重试同一条消息）: identity=' +
        identity.slice(0, 12) + '...');
      throw new Error('SYSTEM_BUSY_RETRY_IN_PROGRESS: 你刚才的请求还在处理中，请稍等几秒再看看，不需要马上重发。');
    }

    try {
      var existing = DeduplicationEngine.findExistingTask(identity);
      if (existing) {
        Logger.log('[IdempotencyManager] 任务已存在（并发安全），跳过创建: identity=' + identity.slice(0, 12) + '... task_id=' + existing.task_id);
        return { task: existing, created: false };
      }

      var task = TaskEngine.createTaskDirect_(title, meta, chatId, identity);
      return { task: task, created: true };

    } finally {
      _releaseSoftLock_(chatId);
    }
  }

  // ============ 开发者测试 ============

  function testWebhookRetry() {
    Logger.log('=== IdempotencyManager.testWebhookRetry ===');
    var chatId = 'test_chat_' + new Date().getTime();
    var title  = '幂等测试任务-' + new Date().getTime();

    Logger.log('第一次创建...');
    var r1 = createTaskIfNotExists(title, { priority: 'LOW', category: 'GENERAL' }, chatId);
    Logger.log('结果1: created=' + r1.created + ' task_id=' + r1.task.task_id);

    Logger.log('第二次创建（模拟 Telegram Webhook 重试，同一个 chatId）...');
    var r2 = createTaskIfNotExists(title, { priority: 'LOW', category: 'GENERAL' }, chatId);
    Logger.log('结果2: created=' + r2.created + ' task_id=' + r2.task.task_id);

    var ok1 = (r1.task.task_id === r2.task.task_id);
    var ok2 = !r2.created;
    Logger.log('同一个 task_id? ' + ok1 + '  (expected: true)');
    Logger.log('第二次 created=false? ' + ok2 + '  (expected: true)');
    Logger.log('=== testWebhookRetry ' + (ok1 && ok2 ? 'PASS ✅' : 'FAIL ❌') + ' ===');
  }

  /**
   * 【V4.4 新增】验证不同 chatId 之间不会因为软锁互相拖累。
   * ⚠️ 局限：GAS 编辑器手动运行是单线程顺序执行，没法真正模拟"两个用户
   * 同一毫秒并发请求"——这个测试只能确认"不同 chatId 依次调用时，任何一个
   * 都不会因为另一个 chatId 曾经拿过锁而被拒绝"，真正的并发表现需要用
   * 多个真实 Telegram 用户同时发消息来验证。
   */
  function testDifferentChatsDontBlock() {
    Logger.log('=== IdempotencyManager.testDifferentChatsDontBlock ===');
    var chatA = 'test_chat_A_' + new Date().getTime();
    var chatB = 'test_chat_B_' + new Date().getTime();

    var rA = createTaskIfNotExists('用户A的任务', { priority: 'LOW' }, chatA);
    var rB = createTaskIfNotExists('用户B的任务', { priority: 'LOW' }, chatB);

    var ok = rA.created && rB.created && rA.task.task_id !== rB.task.task_id;
    Logger.log('两个不同 chatId 都成功创建且互不干扰？ ' + ok + '  (expected: true)');
    Logger.log('=== testDifferentChatsDontBlock ' + (ok ? 'PASS ✅' : 'FAIL ❌') + ' ===');
  }

  function testConcurrentExecution() {
    Logger.log('=== IdempotencyManager.testConcurrentExecution ===');
    Logger.log('四层总防线（V4.4 起，原"防线1 ScriptLock"拆成 Gate+Soft Lock 两层）：');
    Logger.log('  防线1a：Gate（' + GATE_WAIT_MS + 'ms 全局瞬时锁）→ 只保护"检查+占位"这一下的原子性');
    Logger.log('  防线1b：Soft Lock（每 chatId 一把，CacheService，' + LOCK_TTL_SECONDS + 's 过期兜底）→ 同用户严格串行，不同用户互不阻塞');
    Logger.log('  防线2：EventBus._inExecIdentityCache_ → 同次执行内双写（补充）');
    Logger.log('  防线3：DeduplicationEngine.findExistingTask → 跨执行跨实例去重（最终兜底）');
    Logger.log('如需压力测试，手动在 GAS 编辑器同时触发两个执行，检查 Tasks Sheet 行数。');
    Logger.log('=== testConcurrentExecution DONE ===');
  }

  return {
    createTaskIfNotExists:       createTaskIfNotExists,
    testWebhookRetry:            testWebhookRetry,
    testDifferentChatsDontBlock: testDifferentChatsDontBlock,
    testConcurrentExecution:     testConcurrentExecution
  };
})();
