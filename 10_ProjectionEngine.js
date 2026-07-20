/**
 * 10_ProjectionEngine.gs
 * Productivity OS v4.6 — Projection Engine（Read Model 实时更新器）
 *
 * 职责：EventBus.publish() 写完 Event 后立即调用本模块，将变更增量写入
 * Read Model（Tasks / ActiveTasks / TaskFilters）。TaskStatistics 不再由
 * 本模块同步维护，见下方 V4.6 说明。
 *
 * 架构位置：
 *   EventBus.publish() → [append Event] → ProjectionEngine.dispatch() → Read Model
 *
 * 设计原则：
 *  - O(1) 更新：每个 Event 只读/写少量行，从不全表重放
 *  - 非阻断：Projection 失败时记录日志但不抛错（Event 已经写入是真相，
 *    Read Model 偶尔 stale 可以通过 11_ProjectionRebuilder 修复）
 *  - 只写 Read Model，从不读 Events 表
 *
 * 【V4.6 重大变更：移除 TaskStatistics 的同步增量维护】（第五轮外部审计
 * HIGH RISK 1 + HIGH RISK 4，两条一起解决）
 *
 * 第五轮审计同时指出两个问题，指向同一个结论：
 *   HIGH RISK 1：_bumpStatistics_ 是非原子的"读一行、内存里加减、写回"，
 *   同一 chatId 的两个并发请求（哪怕是两个不同的任务）会同时读到同一份
 *   旧值，其中一个的更新会被覆盖丢失（lost update），TaskStatistics 的
 *   计数器会永久性漂移。
 *   HIGH RISK 4：12_TaskQueryEngine.getStatistics() 早就完全绕过
 *   TaskStatistics 这张表了（直接用 AnalyticsEngine.computeStatistics
 *   现扫 Tasks，见该函数注释里"目前不依赖它"的说明）——本 OS 每一次
 *   create/update/complete/cancel/reminder 事件，都在为一张"没有任何
 *   查询路径依赖"的表支付一次额外的同步 Sheet 读写成本。
 *
 * 这两个问题不该分别打补丁：给一条已经被证实没人读、纯属浪费的写入路径
 * 加锁，只会让 HIGH RISK 1"修好"的同时让 HIGH RISK 4 更严重。正确的
 * 做法是审计 HIGH RISK 4 自己给出的建议——停止同步维护，降级为低频、
 * 异步的每日批量重算。批量重算天然没有"读-改-写"竞争问题（每次都是
 * 从 Tasks 现状完整重新聚合一遍，不是在旧值上累加），一并解决了
 * HIGH RISK 1，不需要额外加锁。
 *
 * 落地：
 *   - dispatch() 分发到的 5 个 project*_ 函数全部删除了 _bumpStatistics_
 *     调用；_bumpStatistics_ 和 _adjustStatisticsForUpdate_（V4.2 为
 *     TASK_UPDATED 新增的统计调整逻辑）两个函数本体也一并删除——批量
 *     重算不存在"更新时怎么调整增量"这个问题，原来专门处理这个边界情况
 *     的代码不再需要。
 *   - 新增 11_ProjectionRebuilder.recomputeStatisticsFromTasks_()，从
 *     Tasks 表（不是 Events）按 chat_id 分组重新聚合，由 15_Setup.gs
 *     新增的每日触发器 triggerDailyStatisticsRecompute() 调用。
 *   - TaskStatistics 的表和 Schema 都没有删除，只是维护方式从"事件驱动
 *     实时投影"降级为"每日批量重算的缓存"——如果未来真的有查询路径要
 *     用它，需要注意它现在最多有 24 小时延迟，不再是实时的。
 *
 * 完整架构论证（包括为什么不是"给 _bumpStatistics_ 加锁"）见 00_ADR.gs
 * ADR-2026-07-06-005。
 *
 * 【历史：V4.5 审计修复】HIGH RISK 1（第四轮外部审计，并发状态下的统计
 * 数据漂移）：曾经在 projectTaskCompleted_/projectTaskCancelled_ 里加了
 * "事件发生前是否已处于同一终态"的判断来跳过重复的增量扣减
 * （ADR-2026-07-06-004）。V4.6 起 TaskStatistics 不再同步增量维护，这个
 * 判断原本保护的调用已经不存在，但判断本身（wasAlreadyDone/
 * wasAlreadyCancelled，现在只用于日志）保留，Tasks/ActiveTasks 的幂等
 * 写入不受影响。ADR-2026-07-06-004 的"Projection 消费端应该幂等"这条
 * 原则依然成立，只是这次先应用它，同时发现了更彻底的解法（V4.6）。
 *
 * 【历史：V4.2 审计修复】：
 *   1. HIGH RISK 3（频繁同步 Sheet 读写）：projectTaskUpdated_ 之前对同一
 *      个 task_id 读了两次 Tasks 行（一次判断 ActiveTasks 该不该同步、
 *      一次为了拼 TaskFilters 的 searchable_text）。现在合并成一次读取
 *      （before），后面 ActiveTasks 同步 / TaskFilters 刷新两处共用同一
 *      份数据（V4.6 起不再有第三处"TaskStatistics 漂移修正"共用它）。
 *   2. MEDIUM RISK 2（TaskStatistics 更新漂移）：曾新增
 *      _adjustStatisticsForUpdate_ 处理这个问题，V4.6 起随着 TaskStatistics
 *      改为批量重算，这个函数已删除（批量重算不存在"漂移"这个概念）。
 *
 * 【历史：V4 扩展】相比 v3.1：
 *   1. 新增 TASK_UPDATED case（对应 20_TaskEngine.updateTask 新功能）。
 *   2. 新增对 TaskFilters 表的维护（预算好的 searchable_text/tags_csv，
 *      给 23_SearchEngine 未来做更大数据量搜索时用；当前实现下
 *      23_SearchEngine 直接在 Tasks 行上过滤已经够快，TaskFilters 先维护
 *      起来但暂未被读取路径依赖，属于面向未来的投影）。
 *
 * ActiveTasks Sheet 是"每天工作台"，永远只存 PENDING/IN_PROGRESS/WAITING 任务。
 * 维护策略：同步写，不做定时重建，保证 Tasks 与 ActiveTasks 之间没有不一致窗口。
 *
 *   TASK_CREATED   → upsert Tasks + upsert ActiveTasks + upsert TaskFilters
 *   TASK_UPDATED   → upsert Tasks（+ ActiveTasks，如果任务当前非终态）
 *                     + upsert TaskFilters（重新拼 searchable_text）
 *   TASK_COMPLETED → upsert Tasks（标 DONE）+ deleteRowByKey_ ActiveTasks
 *   TASK_CANCELLED → upsert Tasks（标 CANCELLED）+ deleteRowByKey_ ActiveTasks
 *   REMINDER_SENT  → upsert Tasks（reminder_count+1）
 *
 * （TaskStatistics 不再出现在上面这张表里——V4.6 起它由每日批量任务
 * 单独维护，不属于任何单个 Event 的同步 dispatch 路径，见上方 V4.6 说明）
 *
 * 注：锁（ScriptLock）由上游 IdempotencyManager 持有，ProjectionEngine 本身不再
 * 获取锁（防止与 IdempotencyManager 的锁形成重入死锁）。
 *
 * 依赖：05_SheetUtils（upsertRowByKey_, deleteRowByKey_, getSheet_, getHeaderMap_）
 */

/**
 * ── Engine Contract（V4.3，按 00_Project_Constitution.gs 零之三标准补全，
 *    V4.6 更新 Writes 字段）──
 *   Responsibilities      : 把 Event 增量投影成 Read Model（Tasks/
 *                           ActiveTasks/TaskFilters）
 *   Owns                  : 本 OS 唯一的 Projection 写入逻辑（"一个 Event
 *                           该怎么变成 Read Model 的变化"这条规则只有这里
 *                           实现一次）
 *   Reads                 : 单个 event 对象（由 02_EventBus.publish 传入）；
 *                           必要时读取单行 Tasks 记录做增量计算的基准
 *                           （_getRowByKey_）
 *   Writes                : Tasks / ActiveTasks / TaskFilters 三张 Sheet
 *                           （V4.6 起不再写 TaskStatistics——那张表改由
 *                           11_ProjectionRebuilder.recomputeStatisticsFromTasks_()
 *                           每日批量维护，见文件头 V4.6 说明）
 *   Public API            : dispatch(event)
 *   Dependencies          : 05_SheetUtils.gs（upsertRowByKey_/
 *                           deleteRowByKey_/getSheet_/getHeaderMap_/
 *                           shallowCopy_）
 *   Forbidden Dependencies: 02_EventBus.gs（不得反向调用，dispatch 是被
 *                           EventBus.publish 调用的，不能反过来）、
 *                           Application/Presentation 任何模块
 *   Pure Function         : NO（直接写 Sheet）
 *   Replay Events         : NO（只处理单个 event，不重放历史；全量重放是
 *                           11_ProjectionRebuilder.gs 的职责）
 *   Projection            : YES（本 OS 唯一权威的 Projection 写入方，见
 *                           00_Project_Constitution.gs P6 铁律2）
 *   Thread Safety         : 依赖上游 09_IdempotencyManager 持有的
 *                           ScriptLock，本模块自身不加锁（重复加锁会跟
 *                           上游锁形成重入死锁，见文件头注释）
 *   Side Effects          : YES（Sheet 写入是本模块存在的意义）
 *   Notes                 : dispatch() 内部的每个 project*_ 函数失败时只
 *                           记录日志、不抛错（02_EventBus.gs 会捕获并将
 *                           event.projection_ok 置 false），保证一个
 *                           Projection 步骤失败不会波及 Event 已经成功
 *                           写入这个事实。
 */

var ProjectionEngine = (function () {

  var TASKS_SHEET        = 'Tasks';
  var ACTIVE_TASKS_SHEET = 'ActiveTasks';
  // TASK_STATS_SHEET 常量已移除（V4.6）——本文件不再直接写 TaskStatistics，
  // 见下方"TaskStatistics 维护"小节的说明，该表现在由
  // 11_ProjectionRebuilder.recomputeStatisticsFromTasks_() 每日批量维护。
  var TASK_FILTERS_SHEET = 'TaskFilters';

  // ============ 入口 ============

  function dispatch(event) {
    try {
      var type = event.type;
      switch (type) {
        case 'TASK_CREATED':   projectTaskCreated_(event);   break;
        case 'TASK_UPDATED':   projectTaskUpdated_(event);   break;
        case 'TASK_COMPLETED': projectTaskCompleted_(event); break;
        case 'TASK_CANCELLED': projectTaskCancelled_(event); break;
        case 'REMINDER_SENT':  projectReminderSent_(event);  break;

        default:
          break;
      }
    } catch (e) {
      Logger.log('[ProjectionEngine] ERROR dispatching ' + (event && event.type) + ': ' + e.message);
    }
  }

  // ============ Task Projectors ============

  function projectTaskCreated_(event) {
    var p = event.payload || {};
    if (!p.task_id) return;

    upsertRowByKey_(TASKS_SHEET, 'task_id', p.task_id, p);

    try {
      upsertRowByKey_(ACTIVE_TASKS_SHEET, 'task_id', p.task_id, p);
    } catch (e) {
      Logger.log('[ProjectionEngine] ActiveTasks upsert 失败（Sheet 可能尚未建立）: ' + e.message);
    }

    _upsertTaskFilters_(p.task_id, p);
    // 【V4.6 移除 TaskStatistics 同步维护】见文件头 V4.6 修复说明和
    // 00_ADR.gs ADR-2026-07-06-005。
  }

  /** V4 新增 */
  function projectTaskUpdated_(event) {
    var p = event.payload || {};
    if (!p.task_id) return;

    var fields = shallowCopy_(p);
    delete fields.task_id;
    if (Object.keys(fields).length === 0) return;

    // 【V4.2 修复 HIGH RISK 3 之一】之前这里对同一个 task_id 读了两次
    // Tasks 行（一次判断 ActiveTasks 该不该同步、一次为了拼 TaskFilters 的
    // searchable_text）。改成只读一次，'before' 在下面被 ActiveTasks 同步、
    // TaskFilters 刷新、TaskStatistics 漂移修正三处共用。
    var before = _getRowByKey_(TASKS_SHEET, 'task_id', p.task_id);

    upsertRowByKey_(TASKS_SHEET, 'task_id', p.task_id, fields);

    // 只有当任务当前还是非终态才需要同步 ActiveTasks（终态任务本来就不在
    // ActiveTasks 里，upsert 一个不存在的 key 会误新增一行——upsertRowByKey_
    // 找不到就 append，所以这里用 before 的状态判断，避免把已完成/取消的
    // 任务意外重新塞回工作台）
    try {
      var status = before ? String(before.status || '').toUpperCase() : '';
      if (status !== 'DONE' && status !== 'CANCELLED') {
        upsertRowByKey_(ACTIVE_TASKS_SHEET, 'task_id', p.task_id, fields);
      }
    } catch (e) {
      Logger.log('[ProjectionEngine] ActiveTasks update 同步失败: ' + e.message);
    }

    if (before) {
      // 重新拼 searchable_text 需要完整字段（title/description/tags/category
      // 都可能没在这次 update 的 payload 里），用 before + 本次改动合并即可，
      // 不需要再查一次 Sheet。
      var merged = shallowCopy_(before);
      for (var k in fields) merged[k] = fields[k];
      _upsertTaskFilters_(p.task_id, merged);
      // 【V4.6 移除 TaskStatistics 同步维护】原来这里会调
      // _adjustStatisticsForUpdate_ 修正 recurring/chat_id 变更导致的统计
      // 漂移（V4.2 MEDIUM RISK 2 的修复）。现在 TaskStatistics 整体改为
      // 每日批量重算（见文件头 V4.6 说明），这个问题连带一起解决了——
      // 批量重算每次都是从 Tasks 表现状重新聚合，不存在"漂移"这个概念
      // （每天都是全新算一遍，不是在旧值上累加），原来专门为这类边界
      // 情况写的调整逻辑不再需要，已删除。
    }
  }

  /**
   * 【V4.5 修复历史记录，HIGH RISK 1：并发状态下的统计数据漂移】曾经在这里
   * 用"事件发生前是否已处于同一终态"来判断要不要跳过 TaskStatistics 的
   * 增量扣减。V4.6 起 TaskStatistics 改为每日批量重算（见文件头 V4.6
   * 说明），不再有任何同步增量写入，这个判断本身也就不需要了——但
   * wasAlreadyDone 这个"事件是不是重复的"信号本身仍然有意义（哪怕现在
   * 只用来打日志），保留判断、去掉它原本保护的那次 _bumpStatistics_ 调用。
   */
  function projectTaskCompleted_(event) {
    var p = event.payload || {};
    if (!p.task_id) return;

    var completedAt = event.timestamp || new Date().toISOString();
    var current = _getRowByKey_(TASKS_SHEET, 'task_id', p.task_id);
    var wasAlreadyDone = !!(current && String(current.status || '').toUpperCase() === 'DONE');

    upsertRowByKey_(TASKS_SHEET, 'task_id', p.task_id, {
      status:       'DONE',
      completed_at: completedAt
    });

    try {
      deleteRowByKey_(ACTIVE_TASKS_SHEET, 'task_id', p.task_id);
    } catch (e) {
      Logger.log('[ProjectionEngine] ActiveTasks 删除失败（Sheet 可能尚未建立）: ' + e.message);
    }

    if (wasAlreadyDone) {
      Logger.log('[ProjectionEngine] task_id=' + p.task_id + ' 在这次 TASK_COMPLETED 之前就已经是 DONE' +
        '（重复事件，很可能是并发竞态产生的）——Tasks/ActiveTasks 的覆写本身是幂等操作，无需特殊处理');
    }
  }

  function projectTaskCancelled_(event) {
    var p = event.payload || {};
    if (!p.task_id) return;

    var current = _getRowByKey_(TASKS_SHEET, 'task_id', p.task_id);
    var wasAlreadyCancelled = !!(current && String(current.status || '').toUpperCase() === 'CANCELLED');

    upsertRowByKey_(TASKS_SHEET, 'task_id', p.task_id, {
      status: 'CANCELLED'
    });

    try {
      deleteRowByKey_(ACTIVE_TASKS_SHEET, 'task_id', p.task_id);
    } catch (e) {
      Logger.log('[ProjectionEngine] ActiveTasks 删除失败（Sheet 可能尚未建立）: ' + e.message);
    }

    if (wasAlreadyCancelled) {
      Logger.log('[ProjectionEngine] task_id=' + p.task_id + ' 在这次 TASK_CANCELLED 之前就已经是 CANCELLED' +
        '（重复事件，很可能是并发竞态产生的）——Tasks/ActiveTasks 的覆写本身是幂等操作，无需特殊处理');
    }
  }

  function projectReminderSent_(event) {
    var p = event.payload || {};
    if (!p.task_id) return;

    var current = _getRowByKey_(TASKS_SHEET, 'task_id', p.task_id);
    if (!current) return;

    upsertRowByKey_(TASKS_SHEET, 'task_id', p.task_id, {
      reminder_count: (Number(current.reminder_count) || 0) + 1
    });
    // ActiveTasks 不需要 reminder_count（工作台不展示这列），跳过
  }

  // ============ TaskStatistics 维护 ============
  //
  // 【V4.6 移除】这里原来有一个 _bumpStatistics_(chatId, deltas) 函数，
  // 被 projectTaskCreated_/projectTaskUpdated_（经 _adjustStatisticsForUpdate_）/
  // projectTaskCompleted_/projectTaskCancelled_/projectReminderSent_ 五个
  // 地方同步调用，对 TaskStatistics 做"读一行、内存里加减、写回"的增量更新。
  //
  // 第五轮外部审计同时指出两个问题：
  //   HIGH RISK 1：这个"读-改-写"本身不是原子操作，同一 chatId 的两个并发
  //   请求（不同任务，比如同一用户几乎同时完成两个不同的任务）会同时读到
  //   同一份旧值，其中一个的更新会被覆盖丢失（lost update）。
  //   HIGH RISK 4：12_TaskQueryEngine.getStatistics() 早就完全不读
  //   TaskStatistics 这张表了（直接用 AnalyticsEngine.computeStatistics
  //   扫描 Tasks 现算，见该函数注释）——也就是说，本 OS 每一次创建/更新/
  //   完成/取消/提醒事件，都在为一张"没有任何查询路径依赖"的表支付一次
  //   额外的 Sheet 读写成本。
  //
  // 这两个问题指向同一个结论：与其给一个已经被证实没人读的同步写入路径
  // 加锁（修好 HIGH1 但让 HIGH4 更严重——加锁只会让这条本来就该被质疑的
  // 写入路径更慢），不如直接停止同步维护，改成低频、异步的每日批量重算
  // （HIGH RISK 4 审计原文自己给出的建议）。批量重算天然没有"读-改-写"
  // 竞争问题（每次都是从 Tasks 现状完整重新聚合一遍，不是在旧值上累加），
  // 一并解决了 HIGH RISK 1。
  //
  // 新的维护方式：15_Setup.gs 的每日触发器新增
  // triggerDailyStatisticsRecompute()，调用
  // 11_ProjectionRebuilder.recomputeStatisticsFromTasks_()，从 Tasks 表
  // （不是 Events——Tasks 本身已经是可信的 Read Model，不需要每天重放
  // 全部历史 Events 才能算出当前状态，见该函数文件头对比说明）按 chat_id
  // 分组重新聚合，整体覆写 TaskStatistics。
  //
  // 完整架构论证见 00_ADR.gs ADR-2026-07-06-005。TaskStatistics 表本身
  // 和它的 Schema 都没有删除——只是从"事件驱动的实时投影"降级为"每日
  // 批量重算的缓存"，如果未来真的有查询路径需要用到它，性质变了这一点
  // 需要留意（缓存现在最多有 24 小时延迟，不再是实时的）。

  // ============ TaskFilters 维护（V4新增） ============

  /**
   * 拼好 searchable_text（title+description+notes+tags+category 小写拼接），
   * upsert 到 TaskFilters。见文件头注释——当前 23_SearchEngine 暂未依赖这张表
   * （直接在 Tasks 行上过滤已经够快），这里先维护起来，面向未来更大数据量。
   */
  function _upsertTaskFilters_(taskId, task) {
    try {
      var searchableText = [task.title, task.description, task.notes, task.tags, task.category]
        .filter(function (v) { return !!v; })
        .join(' ')
        .toLowerCase();

      upsertRowByKey_(TASK_FILTERS_SHEET, 'task_id', taskId, {
        task_id:         taskId,
        chat_id:         task.chat_id || '',
        searchable_text: searchableText,
        tags_csv:        task.tags || ''
      });
    } catch (e) {
      Logger.log('[ProjectionEngine] TaskFilters upsert 失败（Sheet 可能尚未建立）: ' + e.message);
    }
  }

  // ============ 内部工具 ============

  function _getRowByKey_(sheetName, keyHeader, keyValue) {
    try {
      var sheet = getSheet_(sheetName);
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return null;

      var headerMap = getHeaderMap_(sheet);
      if (!(keyHeader in headerMap)) return null;

      var keyCol = headerMap[keyHeader] + 1;
      var ids = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues();

      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === String(keyValue)) {
          var numCols = sheet.getLastColumn();
          var row = sheet.getRange(i + 2, 1, 1, numCols).getValues()[0];
          var obj = {};
          for (var h in headerMap) obj[h] = row[headerMap[h]];
          return obj;
        }
      }
    } catch (e) {
      Logger.log('[ProjectionEngine] _getRowByKey_ error (' + sheetName + ', ' + keyValue + '): ' + e.message);
    }
    return null;
  }

  return {
    dispatch:     dispatch,
    _getRowByKey: _getRowByKey_
  };
})();
