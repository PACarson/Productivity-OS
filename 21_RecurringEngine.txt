/**
 * 21_RecurringEngine.gs
 * Productivity OS v4.8 — Recurring Engine（V4 新增）
 *
 * 【V4.8 修复，第六轮外部审计 HIGH RISK 1，正式记录见 00_ADR.gs
 * ADR-2026-07-15-009】spawnNextIfNeeded 原来用一个宽泛的 try/catch 吞掉
 * IdempotencyManager 抛出的所有异常（包括 SYSTEM_BUSY 类繁忙冲突），
 * 静默返回 null——如果同一用户几乎同时完成两个不同的 recurring 任务，
 * 其中一个的续期会因为拿不到锁而被永久放弃，且没有任何人能看到这件事
 * 发生过。
 *
 * 本次分两部分修复（跟 09_IdempotencyManager.gs 的 ADR-2026-07-15-009
 * 是同一个发现的两个互补侧面，不是重复修复）：
 *   1. 09_IdempotencyManager.gs 把 Soft Lock 粒度从 chatId 收紧到
 *      identity——同一用户的两个*不同*任务不再共用同一把锁，本身就已经
 *      解决了审计描述的最主要那个场景。
 *   2. 本文件（spawnNextIfNeeded）作为纵深防御：即使收紧粒度之后仍然
 *      理论上可能撞见 SYSTEM_BUSY（比如 Gate 本身在极端并发下排不上，
 *      或者两次调用确实算出了相同 identity），现在会对 SYSTEM_BUSY 类
 *      错误做有限次数的重试（见下方 spawnNextIfNeeded 注释），重试仍然
 *      失败或者遇到非繁忙类错误时，不再返回跟"这本来就不是 recurring
 *      任务"完全无法区分的裸 null，而是返回一个可识别的
 *      { spawn_error: true, message } 信号。
 *
 * 这个信号沿 20_TaskEngine.completeTask → 06_TaskIntentParser.gs 一路
 * 转发，最终让用户在"完成"回复里看到"续期没成功"的提示（而不是像以前
 * 那样悄悄消失），同时仍然保证"完成这一次"本身绝不会因为续期失败而受
 * 影响——只是把"完全静默"改成"用户可见"，没有改变"续期失败不阻断主
 * 流程"这条既有原则。三个文件的具体改动见各自文件头。
 *
 * 【V4.7 新增，Due Time Support，00_Architecture_Review.gs「七、
 * Review #3」，Carson 2026-07-13 批准】spawnNextIfNeeded 改用
 * IdentityEngine.resolveIdentityDueValue(task) 取值喂给
 * computeNextDueDate（而不是裸 task.due_date），拿到结果后按有没有 'T'
 * 拆回 next due_date / next due_time 两个字段。computeNextDueDate /
 * computeNextDueDateFromLabel（09_TemporalParser.gs）本身未改一行——
 * 已有的"侦测输入带不带时间、保留同样格式输出"逻辑对新的调用方式天然
 * 兼容。效果：recurring 任务如果带具体时间（比如"每天早上8点"），下一次
 * 实例会正确延续同一个时间，不会被重置成没有时间。
 *
 * 职责：recurring rules（包装 09_TemporalParser.gs 的重复规则解析）/
 * next occurrence（下一次到期日计算）/ recurrence lifecycle（完成后自动
 * 续期）。本 Engine 不直接读 Sheet、不直接发 Events——生成下一次任务实例时
 * 委托 09_IdempotencyManager，跟用户手动创建任务走完全同一条路径（同样会
 * 幂等去重、同样会触发 ProjectionEngine）。
 *
 * spawnNextIfNeeded 原本是 20_ProductivityModule.gs 的
 * _spawnNextRecurrenceIfNeeded_，V4 搬到这里独立成 Engine：TaskEngine 只管
 * "完成这一次"的事实写入，"要不要生成下一次"是可以独立演进的规则（未来如果
 * 要支持 ND/NW/interval>1 的完整续期，只需要改这个文件，不影响 TaskEngine）。
 *
 * 依赖：09_TemporalParser.gs（computeNextDueDateFromLabel）、
 * 09_IdempotencyManager.gs（createTaskIfNotExists）、
 * 07_IdentityEngine.gs（resolveIdentityDueValue，V4.7 新增）
 */

/**
 * ── Engine Contract（V4.3，按 00_Project_Constitution.gs 零之三标准补全）──
 *   Responsibilities      : 重复规则解析包装 / 下一次到期日计算 / 完成后
 *                           自动续期
 *   Owns                  : legacy 重复字符串 ⇄ 09_TemporalParser 规则对象
 *                           的转换规则、"什么情况下该生成下一次实例"的判断
 *   Reads                 : 单个 task 快照（由调用方 20_TaskEngine.completeTask
 *                           传入）
 *   Writes                : none（生成下一次实例是委托
 *                           09_IdempotencyManager.createTaskIfNotExists 做的，
 *                           本模块自己不直接写任何东西）
 *   Public API            : ruleToLegacyString(rule), computeNextDueDate
 *                           (prevDueDateStr, recurringLabel),
 *                           describeRule(recurringLabel),
 *                           spawnNextIfNeeded(task, chatId)
 *   Dependencies          : 09_TemporalParser.gs（computeNextDueDateFromLabel）、
 *                           09_IdempotencyManager.gs（createTaskIfNotExists）、
 *                           07_IdentityEngine.gs（resolveIdentityDueValue，
 *                           V4.7 新增，Due Time Support）
 *   Forbidden Dependencies: Sheet 直接读写、Events 直接发布、Telegram/Output
 *   Pure Function         : NO（spawnNextIfNeeded 间接触发写入；
 *                           ruleToLegacyString/computeNextDueDate/
 *                           describeRule 三个是纯函数）
 *   Replay Events         : NO
 *   Projection            : NO
 *   Thread Safety         : 依赖 09_IdempotencyManager 内部的 ScriptLock，
 *                           本模块自身不加锁
 *   Side Effects          : spawnNextIfNeeded 有（间接创建新任务，V4.8起
 *                           还可能调用 Utilities.sleep 做重试退避——纯
 *                           GAS 运行时内置能力，不是跨层依赖）；其余
 *                           三个公开函数无
 *   Notes                 : 本模块是 00_Project_Constitution.gs 零之四
 *                           「已知例外」里唯一记录在案的 Domain→Application
 *                           越层依赖（spawnNextIfNeeded → IdempotencyManager），
 *                           刻意选择复用幂等路径而不是自己重新实现一遍去重。
 *                           【V4.8 变更】spawnNextIfNeeded 内部 try/catch
 *                           仍然保证"续期失败不会波及调用方 completeTask
 *                           的主流程"这条原则不变，但不再对所有异常一律
 *                           静默吞掉：SYSTEM_BUSY 类错误会先重试几次，
 *                           重试仍失败或遇到其它错误时返回可识别的
 *                           { spawn_error: true, message } 而不是裸
 *                           null，让调用方能够区分"这本来就不适用"和
 *                           "本该生成但失败了"，见 ADR-2026-07-15-009。
 */

var RecurringEngine = (function () {

  /**
   * 把 09_TemporalParser.extractDateTime() 算出来的 recurrence_rule 对象
   * 转成目前 Tasks Schema 能持久化的 legacy 字符串。
   *
   * ⚠️ 范围（继承自 V3，未扩大）：只支持 interval=1 的四种 calendar-anchored
   * 类型（Daily/Weekly/Monthly/Yearly）。ND/NW 和 interval>1 会被转成''
   * （不当 recurring 存下来）——这是现有 Tasks Schema 的边界，不是本函数
   * 新引入的限制。06_TaskIntentParser.gs 创建任务时调这个函数决定
   * meta.recurring 传什么值。
   *
   * @param {object|null} rule  09_TemporalParser._extractRecurrence_ 的输出
   * @returns {string}  'Daily'|'Weekly'|'Monthly'|'Yearly'|''
   */
  function ruleToLegacyString(rule) {
    if (!rule || rule.interval !== 1) return '';
    switch (rule.type) {
      case 'DAILY':   return 'Daily';
      case 'WEEKLY':  return 'Weekly';
      case 'MONTHLY': return 'Monthly';
      case 'YEARLY':  return 'Yearly';
    }
    return '';
  }

  /**
   * 给定"上一次"的due_date + legacy重复字符串，算出"下一次"的due_date。
   * 直接包装 09_TemporalParser.computeNextDueDateFromLabel，不重复实现逻辑。
   *
   * @param {string} prevDueDateStr
   * @param {string} recurringLabel  'Daily'|'Weekly'|'Monthly'|'Yearly'
   * @returns {string}  下一次的due_date，或''（无法计算）
   */
  function computeNextDueDate(prevDueDateStr, recurringLabel) {
    return computeNextDueDateFromLabel(prevDueDateStr, recurringLabel); // 09_TemporalParser.gs
  }

  /**
   * 人类可读的重复规则描述，供 Dashboard/List 展示用（比如"🔁 每周"）。
   * @param {string} recurringLabel
   * @returns {string}
   */
  function describeRule(recurringLabel) {
    var map = {
      'Daily':   '每天',
      'Weekly':  '每周',
      'Monthly': '每月',
      'Yearly':  '每年'
    };
    return map[recurringLabel] || '';
  }

  /**
   * 如果被完成的任务本身是recurring的，生成下一次实例；否则返回null。
   *
   * 静默失败（比如task没取到、due_date解析不出来、IdempotencyManager抛错）
   * 不影响 TaskEngine.completeTask 主流程——"这次完成"本身必须成功，
   * "下一次要不要生出来"是锦上添花，不能反过来把主流程搞挂。
   *
   * 只对completeTask生效，cancelTask不会自动生成下一次——取消是用户主动
   * 表示"这一次不需要了"，是否要连未来所有次都停掉是有歧义的产品行为
   * （比如"每年生日"被取消一次，明年该不该继续提醒？），V4 继续不擅自决定，
   * 只解决"完成后没续上"这一种情况（跟 V3.2 的产品判断一致）。
   *
   * 幂等性说明：不需要单独加锁/去重保护。走的是
   * IdempotencyManager.createTaskIfNotExists同一条路径，算出来的
   * identity=hash(chat_id+title+resolveIdentityDueValue(task)+recurring+
   * priority+category)——【V4.7】resolveIdentityDueValue 取 due_datetime
   * （若有 due_time）或 due_date，只要task这两个字段没变，两次调用（比如
   * webhook重试导致completeTask被调两次）算出的nextDueValue完全一样，
   * DeduplicationEngine会把第二次识别成"已存在"直接跳过。
   *
   * 【V4.8 变更，第六轮外部审计 HIGH RISK 1，见文件头修复说明】返回值
   * 新增第三种可能：调用 IdempotencyManager 时遇到 SYSTEM_BUSY 类繁忙
   * 冲突，会先做有限次数的重试（MAX_SPAWN_RETRIES 次，线性退避）——
   * 09_IdempotencyManager.gs 的 identity 级别 Soft Lock 修复之后，这类
   * 冲突应该已经很罕见，重试主要是纵深防御。重试仍然失败、或者遇到任何
   * 非 SYSTEM_BUSY 的错误（不重试，重试对确定性失败没有意义），会返回
   * { spawn_error: true, message } 而不是裸 null，让 20_TaskEngine.
   * completeTask 能区分"这本来就不适用"（null）和"本该生成下一次但失败
   * 了"（spawn_error），继续沿调用链转发给 06_TaskIntentParser.gs 决定
   * 怎么回复用户——不再是完全静默的失败。
   *
   * @param {object} task  完成前的task快照（TaskQueryEngine.getTask的返回值）
   * @param {string} chatId
   * @returns {object|{spawn_error: boolean, message: string}|null}
   *          null：这本来就不是 recurring 任务 / 没有 due_date / 算不出
   *                下一次到期日（都是正常情况，不需要用户关心）。
   *          {spawn_error:true, message}：本该生成下一次实例但失败了，
   *                调用方应该让用户知道。
   *          否则：新创建（或已存在，由 IdempotencyManager 的幂等语义
   *                决定）的下一次任务对象。
   */
  function spawnNextIfNeeded(task, chatId) {
    if (!task || !task.recurring || !task.due_date) return null;

    // 计算下一次到期日本身的失败（比如 due_date 格式解析不出来）是确定性
    // 的——同样的输入重试多少次结果都一样，不属于"繁忙冲突"，不重试，
    // 维持原有"当作不适用处理"的静默行为（这一类失败不是本次审计关注的
    // "本该生成却因为锁冲突丢失"场景，是任务数据本身的问题）。
    var nextDueDate, nextDueTime;
    try {
      // 【V4.7，Due Time Support】取 due_datetime（若有 due_time）或
      // due_date——09_TemporalParser.computeNextDueDateFromLabel() 本身
      // 就是格式保留的（侦测输入带不带时间，输出保持同样格式），不需要
      // 改那个函数一行。
      var prevDueValue = IdentityEngine.resolveIdentityDueValue(task);
      var nextDueValue = computeNextDueDate(prevDueValue, task.recurring);
      if (!nextDueValue) return null;

      // nextDueValue 可能是纯日期，也可能是带时间的 ISO 字符串——按有没有
      // 'T' 拆回 next due_date / next due_time 两个字段，喂给下面的
      // meta；due_datetime 由 TaskEngine.createTaskDirect_ 内部从这两者
      // 派生，这里不需要单独算。
      var hasTime = /T\d{2}:\d{2}:\d{2}/.test(nextDueValue);
      nextDueDate = hasTime ? nextDueValue.split('T')[0]            : nextDueValue;
      nextDueTime = hasTime ? nextDueValue.split('T')[1].slice(0, 5) : '';
    } catch (calcErr) {
      Logger.log('[RecurringEngine] spawnNextIfNeeded 计算下一次到期日失败' +
        '（确定性失败，不重试，不影响本次 completeTask 主流程）: ' + calcErr.message);
      return null;
    }

    var meta = {
      due_date:    nextDueDate,
      due_time:    nextDueTime,
      recurring:   task.recurring,
      category:    task.category,
      priority:    task.priority,
      context:     task.context,
      budget:      task.budget,
      notes:       task.notes,
      description: task.description,
      tags:        task.tags
    };
    var targetChatId = chatId || task.chat_id;

    var MAX_SPAWN_RETRIES  = 3;
    var RETRY_BACKOFF_MS   = 400; // 线性退避：400ms/800ms/1200ms，累计上限约2.4秒

    var lastErr = null;
    for (var attempt = 0; attempt <= MAX_SPAWN_RETRIES; attempt++) {
      try {
        var result = IdempotencyManager.createTaskIfNotExists(task.title, meta, targetChatId);
        return result.task;
      } catch (e) {
        lastErr = e;
        var isTransientBusy = String(e.message || '').indexOf('SYSTEM_BUSY') === 0; // 覆盖两种前缀
        if (!isTransientBusy || attempt === MAX_SPAWN_RETRIES) break;

        Logger.log('[RecurringEngine] spawnNextIfNeeded 第 ' + (attempt + 1) + ' 次遇到繁忙冲突，' +
          (RETRY_BACKOFF_MS * (attempt + 1)) + 'ms 后重试: ' + e.message);
        Utilities.sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }

    Logger.log('[RecurringEngine] spawnNextIfNeeded 最终失败（不影响本次 completeTask 主流程，' +
      '但下一次实例确实没有生成，已转发给调用方处理用户提示）: ' + (lastErr && lastErr.message));
    return { spawn_error: true, message: (lastErr && lastErr.message) || '未知错误' };
  }

  return {
    ruleToLegacyString: ruleToLegacyString,
    computeNextDueDate: computeNextDueDate,
    describeRule:       describeRule,
    spawnNextIfNeeded:  spawnNextIfNeeded
  };
})();
