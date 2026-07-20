/**
 * 12_TaskQueryEngine.gs
 * Productivity OS v4.8 — Task Query Engine（V4 改名+中心化）
 *
 * 【V4.8 修复，第六轮外部审计 HIGH RISK（原文档 2：高频查询全表扫描
 * 风险）】只关注"非终态任务"的高频视图查询（今天/明天/本周/本月/即将
 * 到来/逾期/重复/优先级/待办），原来一律经 _readAllTasks_ 扫描全量历史
 * Tasks 表——Tasks 只增不标记删除（冷归档只打 archived 标记，不物理搬走，
 * 见 13_ActiveTasksEngine.gs 文件头"架构关系"），随着历史任务积累，这些
 * 本该很轻量的日常查询会越来越慢，最终逼近 GAS 执行时间/内存上限。
 *
 * 本 OS 早就存在一张专门维护、体积远小于 Tasks 的 ActiveTasks 表
 * （10_ProjectionEngine.gs 实时同步：任务一旦 DONE/CANCELLED 就从
 * ActiveTasks 物理删除），本模块的架构铁律（见下方）也一直明确允许直接读
 * 它——只是过去所有查询函数都没有实际用到这个权限。修复：新增
 * _readActiveTasks_（内部复用 _readAllRows_，只是换一个 sheetName），
 * 把 24_ViewEngine.gs 里"过滤条件本身就要求非终态"的那些视图函数
 * （today/tomorrow/thisWeek/thisMonth/upcoming/overdue/recurring，均在
 * 内部做 _isNonTerminal_ 检查，见该文件）改成读 ActiveTasks；
 * getPriorityTasks/getPendingTasks 同理。
 *
 * 哪些查询*没有*改、为什么：
 *   - searchTasks：00_Project_State.gs 已有明确设计澄清"/search 故意
 *     搜索所有任务状态"，不能改成只读 ActiveTasks（会漏掉对已完成/已
 *     取消任务的搜索，破坏既有产品行为）。
 *   - getCompletedTasks/getCancelledTasks/getArchivedTasksInline：本身
 *     要找的就是终态任务，ActiveTasks 里根本不会有这些任务，必须读 Tasks。
 *   - getStatistics/getDashboard('weekly'/'monthly'/'statistics',...)：
 *     依赖 AnalyticsEngine.computeStatistics 算完成率等需要看到 DONE
 *     任务的指标，必须读全量 Tasks；只有 getDashboard('today',...)
 *     内部用到的都是非终态视图（含 25_DashboardEngine.buildTodayDashboard
 *     自己的 category 分组逻辑，同样显式排除 DONE/CANCELLED），改成读
 *     ActiveTasks。
 *   - getTask/getTasks（通用过滤）：前者要能查到任意状态的单个任务；
 *     后者的 filters 参数完全通用，调用方可能传任何状态，不能假设"只要
 *     非终态"，维持读全量 Tasks。
 *
 * 一致性说明（诚实面对取舍，不回避）：ActiveTasks 由 10_ProjectionEngine.gs
 * 同步维护，理论上跟 Tasks 一样存在"Projection dispatch 失败导致短暂
 * 不一致"的风险——这不是本次改动新引入的风险，Tasks 表本身也依赖同一套
 * Projection 机制，一致性保障（失败告警 + rebuildAllProjections() 手动
 * 修复）跟现有架构完全一致，不需要为 ActiveTasks 单独发明一套新的保障。
 *
 * 【V4.6 修复 LOW RISK 1】getTask() 原来调 _readAllRows_ 做全表扫描，
 * 改成"先读 task_id 单列定位行号、再读那一行"的两步查找，减少写事务
 * 路径（completeTask/cancelTask/updateTask 的存在性校验）上的数据传输量，
 * 完整说明见 getTask() 函数头注释。
 *
 * 【V4】原 12_QueryEngine.gs。规格书要求的"centralized query API"：
 * getTask / getTasks / getTodayTasks / getWeekTasks / getMonthTasks /
 * getOverdueTasks / getUpcomingTasks / getRecurringTasks / getPriorityTasks /
 * searchTasks / getDashboard / getStatistics。
 *
 * 架构铁律（00_Project_Constitution.gs P6 铁律5）：
 *  - 本模块是本项目唯一允许直接读 Tasks/ActiveTasks/TaskStatistics/
 *    TaskFilters 这几张 Sheet 的模块。
 *  - 绝对禁止读 Events 表 / 调 EventBus / 调 deriveTaskState_。
 *  - 每次查询只批量读一次 Sheet（_readAllTasks_），读出来的数组转交给
 *    22_PriorityEngine / 23_SearchEngine / 24_ViewEngine / 25_DashboardEngine /
 *    26_AnalyticsEngine 这五个纯函数 Engine 做内存运算，自己不重复实现
 *    过滤逻辑。
 *  - 所有 Telegram 指令（06_TaskIntentParser.gs）必须经过本层，不允许直接
 *    读 Sheet。
 *
 * 依赖：05_SheetUtils（getSheet_, getHeaderMap_）
 */

/**
 * ── Engine Contract（V4.3，按 00_Project_Constitution.gs 零之三标准补全）──
 *   Responsibilities      : 本 OS 唯一的查询入口——批量读 Read Model，
 *                           分发给下游纯函数 Engine 做过滤/排序/组合
 *   Owns                  : "怎么把 Sheet 行读成 task 对象数组"这件事
 *                           （_readAllRows_/_readAllTasks_），以及"哪个
 *                           查询该调用哪个下游 Engine"的路由表
 *   Reads                 : Tasks Sheet（唯一直接读取方）；V4.8 起也直接
 *                           读 ActiveTasks（只用于"只关注非终态任务"的
 *                           高频视图查询，见文件头 V4.8 修复说明——这个
 *                           权限本来就在架构铁律里，V4.8 只是第一次真正
 *                           用到它）；其余三张只读表由对应 Engine 各自的
 *                           职责覆盖，本身不重复读
 *   Writes                : none
 *   Public API            : getTask, getTasks, getPendingTasks,
 *                           getCompletedTasks, getTodayTasks,
 *                           getTomorrowTasks, getWeekTasks, getMonthTasks,
 *                           getUpcomingTasks, getOverdueTasks,
 *                           getRecurringTasks, getCancelledTasks,
 *                           getArchivedTasksInline, getArchivedTasks,
 *                           getPriorityTasks, searchTasks, getDashboard,
 *                           getStatistics
 *   Dependencies          : 05_SheetUtils.gs（getSheet_/getHeaderMap_）、
 *                           22_PriorityEngine / 23_SearchEngine /
 *                           24_ViewEngine / 25_DashboardEngine /
 *                           26_AnalyticsEngine（全部 Domain 层）、
 *                           13_ActiveTasksEngine（冷归档查询转发）
 *   Forbidden Dependencies: 02_EventBus.gs（getAllEvents/deriveTaskState_
 *                           一律禁止调用，见 00_Project_Constitution.gs
 *                           P6 铁律3）
 *   Pure Function         : NO（直接读 Sheet）
 *   Replay Events         : NO（本 OS 除 26_AnalyticsEngine 的
 *                           replayCompletionTrend_ 外唯一可能被误用来"顺手
 *                           重放"的地方，必须保持 NO）
 *   Projection            : NO
 *   Thread Safety         : 只读操作，不需要加锁
 *   Side Effects          : NO
 *   Notes                 : 本模块是 00_ADR.gs ADR-2026-07-06 定义的
 *                           "Query Layer"，属于四层模型
 *                           （Write Model→Projection→Query Layer→
 *                           View Layer）的第三层。
 */

var TaskQueryEngine = (function () {

  var TASKS_SHEET        = 'Tasks';
  var ACTIVE_TASKS_SHEET = 'ActiveTasks'; // V4.8新增，见文件头修复说明
  var TASK_STATS_SHEET   = 'TaskStatistics';

  // ============ 内部：批量读整张 Sheet（本模块唯一的 Sheet I/O 入口） ============

  function _readAllRows_(sheetName) {
    try {
      var sheet = getSheet_(sheetName); // 05_SheetUtils.gs
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      var headerMap = getHeaderMap_(sheet);
      var numCols   = sheet.getLastColumn();
      var rows      = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

      return rows.map(function (row) {
        var obj = {};
        for (var h in headerMap) {
          obj[h] = row[headerMap[h]];
        }
        return obj;
      }).filter(function (obj) {
        return Object.keys(obj).some(function (k) { return obj[k] !== ''; });
      });
    } catch (e) {
      Logger.log('[TaskQueryEngine] _readAllRows_ error (' + sheetName + '): ' + e.message);
      return [];
    }
  }

  /**
   * 本模块内部所有查询共用的"一次性批量读"入口。
   * @param {string} [chatId]  不传则返回所有用户的任务
   * @returns {object[]}
   */
  function _readAllTasks_(chatId) {
    var rows = _readAllRows_(TASKS_SHEET);
    if (!chatId) return rows;
    return rows.filter(function (t) { return String(t.chat_id) === String(chatId); });
  }

  /**
   * 【V4.8 新增，见文件头修复说明】只关注非终态任务的高频视图专用——
   * 读 ActiveTasks（体积远小于 Tasks，10_ProjectionEngine.gs 实时维护，
   * 只包含 PENDING/IN_PROGRESS/WAITING）而不是全量 Tasks。复用
   * _readAllRows_，只是换一个 sheetName，两张表的列结构兼容（ActiveTasks
   * 比 Tasks 少一个 archived 列，本模块下游消费的字段都不需要它）。
   *
   * ⚠️ 只应该用于"过滤条件本身就要求非终态"的查询——如果调用方可能需要
   * 看到 DONE/CANCELLED/archived 任务，必须用 _readAllTasks_，见文件头
   * "哪些查询没有改"的说明。
   *
   * @param {string} [chatId]
   * @returns {object[]}
   */
  function _readActiveTasks_(chatId) {
    var rows = _readAllRows_(ACTIVE_TASKS_SHEET);
    if (!chatId) return rows;
    return rows.filter(function (t) { return String(t.chat_id) === String(chatId); });
  }

  // ============ 单任务 / 通用列表 ============

  /**
   * 按 task_id 查单个任务。
   *
   * 【V4.6 修复 LOW RISK 1：单任务点查询时的全表扫描性能瓶颈】原来直接调
   * _readAllRows_ 把 Tasks 全表所有行、所有列都读进内存再线性找一遍——
   * completeTask/cancelTask/updateTask 这些写事务路径每次都要先调
   * getTask 校验任务存在，等于每次完成/取消/更新一个任务，都要搭配一次
   * 全表扫描，随着 Tasks 数据量增长，这个点查询的成本会越来越不成比例。
   * 修复：分两步，只读 task_id 那一列定位行号（一维扫描，只传输1列
   * 数据，不是整张表），找到后再单独读那一行的全部字段——数据传输量从
   * "行数×列数"降到"行数×1 + 1×列数"，随着列数变多这个差距会更明显。
   *
   * @param {string} taskId
   * @param {string} [chatId]  传入时额外校验 chat_id 匹配（跨用户隔离）
   * @returns {object|null}
   */
  function getTask(taskId, chatId) {
    try {
      var sheet = getSheet_(TASKS_SHEET); // 05_SheetUtils.gs
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return null;

      var headerMap = getHeaderMap_(sheet); // 05_SheetUtils.gs
      var taskIdCol = headerMap['task_id'];
      if (taskIdCol === undefined) {
        Logger.log('[TaskQueryEngine] getTask: Tasks 表头缺少 task_id 列');
        return null;
      }

      // 第一步：只读 task_id 这一列，定位匹配行的位置
      var idColumnValues = sheet.getRange(2, taskIdCol + 1, lastRow - 1, 1).getValues();
      var matchedRowIndex = -1; // 相对于数据区（不含表头）的 0-based 索引
      for (var i = 0; i < idColumnValues.length; i++) {
        if (String(idColumnValues[i][0]) === String(taskId)) {
          matchedRowIndex = i;
          break;
        }
      }
      if (matchedRowIndex === -1) return null;

      // 第二步：只读这一行的全部字段
      var numCols = sheet.getLastColumn();
      var rowValues = sheet.getRange(matchedRowIndex + 2, 1, 1, numCols).getValues()[0];
      var task = {};
      for (var h in headerMap) task[h] = rowValues[headerMap[h]];

      if (chatId && String(task.chat_id) !== String(chatId)) return null;
      return task;
    } catch (e) {
      Logger.log('[TaskQueryEngine] getTask error (' + taskId + '): ' + e.message);
      return null;
    }
  }

  /**
   * 通用查询：按任意字段做简单等值过滤（不支持 SearchEngine 那种全文/范围
   * 搜索——复杂搜索请用 searchTasks）。
   * @param {string} [chatId]
   * @param {object} [filters]  { status: 'PENDING', category: 'SHOPPING', ... }
   * @returns {object[]}
   */
  function getTasks(chatId, filters) {
    var tasks = _readAllTasks_(chatId);
    if (!filters) return tasks;

    return tasks.filter(function (t) {
      for (var k in filters) {
        if (String(t[k] || '').toUpperCase() !== String(filters[k]).toUpperCase()) return false;
      }
      return true;
    });
  }

  /**
   * 【V4.8 变更，见文件头修复说明】PENDING 是非终态状态，改读 ActiveTasks——
   * 不再经过通用的 getTasks()（那个函数假设调用方可能要任意状态，只能读
   * 全量 Tasks）。
   */
  function getPendingTasks(chatId) {
    return _readActiveTasks_(chatId).filter(function (t) {
      return String(t.status || '').toUpperCase() === 'PENDING';
    });
  }

  /** DONE 是终态，ActiveTasks 里不会有，维持读全量 Tasks（未变） */
  function getCompletedTasks(chatId) {
    return getTasks(chatId, { status: 'DONE' });
  }

  // ============ View Engine 转发 ============
  // 【V4.8 变更，见文件头修复说明】以下七个视图的过滤条件本身就要求
  // 非终态（24_ViewEngine.gs 对应函数内部都有 _isNonTerminal_ 检查），
  // 改读 _readActiveTasks_ 而不是 _readAllTasks_。

  function getTodayTasks(chatId)    { return ViewEngine.today(_readActiveTasks_(chatId)); }
  function getTomorrowTasks(chatId) { return ViewEngine.tomorrow(_readActiveTasks_(chatId)); }
  function getWeekTasks(chatId)     { return ViewEngine.thisWeek(_readActiveTasks_(chatId)); }
  function getMonthTasks(chatId)    { return ViewEngine.thisMonth(_readActiveTasks_(chatId)); }
  function getUpcomingTasks(chatId) { return ViewEngine.upcoming(_readActiveTasks_(chatId)); }
  function getOverdueTasks(chatId)  { return ViewEngine.overdue(_readActiveTasks_(chatId)); }
  function getRecurringTasks(chatId) { return ViewEngine.recurring(_readActiveTasks_(chatId)); }

  // 以下两个是终态/归档视图，ActiveTasks 里不会有对应任务，维持读全量
  // Tasks（未变）。
  function getCancelledTasks(chatId) { return ViewEngine.cancelled(_readAllTasks_(chatId)); }
  function getArchivedTasksInline(chatId) { return ViewEngine.archived(_readAllTasks_(chatId)); }

  /** 冷归档库（ArchiveTasks 表，不是 Tasks 里 archived=true 标记）—— 转发给 13_ActiveTasksEngine */
  function getArchivedTasks(chatId, limit) {
    return ActiveTasksEngine.getArchivedTasks(chatId, limit); // 13_ActiveTasksEngine.gs
  }

  // ============ Priority Engine 转发 ============

  /**
   * High Priority 任务，按 Priority Score 降序排列。
   *
   * 【V4.8 变更，见文件头修复说明】改读 ActiveTasks——本来就只关心非
   * 终态任务。ActiveTasks 本身已经不含 DONE/CANCELLED，下面的 filter
   * 严格来说已经多余，但保留作为防御性兜底（万一 ActiveTasks 因为某次
   * Projection 失败而短暂出现陈旧的终态行，见文件头"一致性说明"，这里
   * 不会把它们算进优先级排序），成本可以忽略不计。
   *
   * @param {string} chatId
   * @returns {object[]}  每个元素附带 _priority_score
   */
  function getPriorityTasks(chatId) {
    var nonTerminal = _readActiveTasks_(chatId).filter(function (t) {
      var s = String(t.status || '').toUpperCase();
      return s !== 'DONE' && s !== 'CANCELLED';
    });
    return PriorityEngine.rankByPriority(nonTerminal); // 22_PriorityEngine.gs
  }

  // ============ Search Engine 转发 ============

  /**
   * @param {string} chatId
   * @param {object|string} query  传字符串等价于 {text: query}（对应
   *                                 Telegram "/search keyword"）
   * @returns {object[]}
   */
  function searchTasks(chatId, query) {
    var q = (typeof query === 'string') ? { text: query } : (query || {});
    return SearchEngine.search(_readAllTasks_(chatId), q); // 23_SearchEngine.gs
  }

  // ============ Dashboard / Statistics 转发 ============

  /**
   * 【V4.8 变更，见文件头修复说明】只有 'today'（含未识别 type 落到的
   * default 分支——25_DashboardEngine.build 两者都指向
   * buildTodayDashboard）完全只由非终态视图 + 按 category 分组组成
   * （25_DashboardEngine.buildTodayDashboard 内部对 category 分组也显式
   * 排除了 DONE/CANCELLED），改读 ActiveTasks。'weekly'/'monthly'/
   * 'statistics' 三种都会调用 AnalyticsEngine.computeStatistics 算完成率
   * 等需要看到 DONE 任务历史的指标，必须维持读全量 Tasks，不能改。
   *
   * @param {string} type  'today'|'weekly'|'monthly'|'statistics'
   * @param {string} chatId
   * @returns {string}
   */
  function getDashboard(type, chatId) {
    var normalizedType = String(type || '').toLowerCase();
    var onlyNeedsActiveTasks = (normalizedType === 'today' || normalizedType === '');
    var tasks = onlyNeedsActiveTasks ? _readActiveTasks_(chatId) : _readAllTasks_(chatId);
    return DashboardEngine.build(type, tasks); // 25_DashboardEngine.gs
  }

  /**
   * 优先读 TaskStatistics 投影表（O(1)，由 10_ProjectionEngine 增量维护）；
   * 表不存在或该 chatId 还没有投影行时，退化为现算（
   * AnalyticsEngine.computeStatistics 扫一次 _readAllTasks_(chatId)）。
   *
   * ⚠️ TaskStatistics 里没有的字段（overdue_count 等"日历相对"统计）永远
   * 现算——见 00_Project_Constitution.gs P7 同一类"时间相关不适合纯事件
   * 驱动增量维护"的讨论。TaskStatistics 只缓存"事件驱动"的计数（total/
   * pending/done/cancelled/recurring/reminder 累计），overdue_rate等仍由
   * AnalyticsEngine 现算后合并进返回值。
   *
   * @param {string} chatId
   * @returns {object}
   */
  function getStatistics(chatId) {
    var tasks = _readAllTasks_(chatId);
    // AnalyticsEngine.computeStatistics 本身已经是 O(n) 一次扫描，数据量在
    // GAS 场景下（个人任务系统，通常几百到几千行）现算完全够快，这里直接
    // 现算即可保证数字绝对准确（不用担心 TaskStatistics 投影漂移的问题）。
    // TaskStatistics 表仍然维护（10_ProjectionEngine 增量更新），供未来
    // 需要跨 chatId 聚合总览时做低成本快照读取用，getStatistics 目前不依赖它。
    return AnalyticsEngine.computeStatistics(tasks); // 26_AnalyticsEngine.gs
  }

  return {
    getTask:             getTask,
    getTasks:            getTasks,
    getPendingTasks:     getPendingTasks,
    getCompletedTasks:   getCompletedTasks,
    getTodayTasks:       getTodayTasks,
    getTomorrowTasks:    getTomorrowTasks,
    getWeekTasks:        getWeekTasks,
    getMonthTasks:       getMonthTasks,
    getUpcomingTasks:    getUpcomingTasks,
    getOverdueTasks:     getOverdueTasks,
    getRecurringTasks:   getRecurringTasks,
    getCancelledTasks:   getCancelledTasks,
    getArchivedTasksInline: getArchivedTasksInline,
    getArchivedTasks:    getArchivedTasks,
    getPriorityTasks:    getPriorityTasks,
    searchTasks:         searchTasks,
    getDashboard:        getDashboard,
    getStatistics:       getStatistics
  };
})();

// ============ 向后兼容全局别名（原 QueryEngine 调用方不用改） ============
// 部分历史代码（如 11_ProjectionRebuilder.gs 之外的调用方）可能还引用
// 旧的全局 QueryEngine 名字，这里保留一个指向同一实现的别名。
var QueryEngine = TaskQueryEngine;
