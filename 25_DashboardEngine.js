/**
 * 25_DashboardEngine.gs
 * Productivity OS v4.3 — Dashboard Engine（V4 新增）
 *
 * 职责：组合 24_ViewEngine.gs + 26_AnalyticsEngine.gs 的输出，拼成规格书
 * 里 Today / Weekly / Monthly / Statistics 四种 Dashboard 的展示文案。
 *
 * 不额外落盘（不建物理 Dashboard Sheet）——架构决策见
 * 00_Project_Constitution.gs P7。本 Engine 仍然是纯函数：输入是
 * 12_TaskQueryEngine.gs 已经批量读出来的 task 数组，自己不读 Sheet。
 */

/**
 * ── Engine Contract（V4.3，按 00_Project_Constitution.gs 零之三标准补全）──
 *   Responsibilities      : 组合多个逻辑视图 + 统计数字，拼成 Today/
 *                           Weekly/Monthly/Statistics 四种 Dashboard 文案
 *   Owns                  : Dashboard 展示格式本身（分区顺序、图标、按
 *                           category 动态生成补充板块的规则）
 *   Reads                 : task[]（由调用方传入）
 *   Writes                : none
 *   Public API            : build(type, allTasks), buildTodayDashboard,
 *                           buildWeeklyDashboard, buildMonthlyDashboard,
 *                           buildStatisticsDashboard
 *   Dependencies          : 24_ViewEngine.gs（今日/本周/逾期等视图过滤）、
 *                           22_PriorityEngine.gs（Today Dashboard 内的
 *                           排序）、26_AnalyticsEngine.gs（统计数字）
 *   Forbidden Dependencies: Sheet, Events, Telegram/Output（返回值是纯
 *                           文本字符串，不是 Telegram 消息格式，呼应
 *                           ADR-2026-07-06 关于"不知道 Telegram 是什么"
 *                           的正式条款）
 *   Pure Function         : YES
 *   Replay Events         : NO
 *   Projection            : NO
 *   Thread Safety         : 不需要（无共享可变状态）
 *   Side Effects          : NO
 *   Notes                 : 完整架构论证见 00_ADR.gs ADR-2026-07-06——
 *                           Dashboard 不满足 Projection 的基本性质（同一份
 *                           Events 历史在不同时刻重放结果应该相同），所以
 *                           属于 View/Presentation Layer 而不是 Projection
 *                           Layer，SHALL 永远按需生成、不得落盘。
 */

var DashboardEngine = (function () {

  function _titleLine_(t) {
    var due = t.due_date ? (' (' + String(t.due_date).slice(0, 10) + ')') : '';
    return t.title + due;
  }

  /**
   * Today Dashboard —— 对应规格书示例格式：
   *   🔥 Today / ⚠ Overdue / 📅 Tomorrow / 📦 Shopping / 🚗 Vehicle
   *
   * "📦 Shopping / 🚗 Vehicle" 这类按 category 分组的补充板块，用当前
   * Tasks Schema 里已有的 category 字段（SHOPPING/MAINTENANCE）动态生成，
   * 不是写死的两个板块——如果某个 chatId 当天没有 SHOPPING/MAINTENANCE 类
   * 的任务，对应板块不会出现。
   *
   * @param {object[]} allTasks  某 chatId 的全量任务（含终结态，供
   *                              ViewEngine 各视图函数自行过滤）
   * @returns {string}
   */
  function buildTodayDashboard(allTasks) {
    var todayTasks    = ViewEngine.today(allTasks);
    var overdueTasks  = ViewEngine.overdue(allTasks);
    var tomorrowTasks = ViewEngine.tomorrow(allTasks);

    var lines = [];

    lines.push('🔥 Today');
    if (todayTasks.length === 0) {
      lines.push('（今天没有安排）');
    } else {
      var ranked = PriorityEngine.rankByPriority(todayTasks); // 22_PriorityEngine.gs
      var circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
      ranked.forEach(function (t, idx) {
        lines.push((circled[idx] || (idx + 1) + '.') + ' ' + t.title);
      });
    }

    if (overdueTasks.length > 0) {
      lines.push('------------------');
      lines.push('⚠ Overdue');
      overdueTasks.forEach(function (t) { lines.push(t.title); });
    }

    if (tomorrowTasks.length > 0) {
      lines.push('------------------');
      lines.push('📅 Tomorrow');
      tomorrowTasks.forEach(function (t) { lines.push(t.title); });
    }

    // 按 category 动态生成补充板块（跳过已经出现在上面几个板块里的任务，
    // 避免同一个任务在 Dashboard 里重复出现两次）
    var shownIds = {};
    todayTasks.concat(overdueTasks, tomorrowTasks).forEach(function (t) { shownIds[t.task_id] = true; });

    var categoryIcons = { SHOPPING: '📦 Shopping', MAINTENANCE: '🚗 Vehicle', HEALTH: '💊 Health', ADMIN: '📋 Admin' };
    var byCategory = {};
    allTasks.forEach(function (t) {
      var s = String(t.status || '').toUpperCase();
      if (s === 'DONE' || s === 'CANCELLED') return;
      if (shownIds[t.task_id]) return;
      var label = categoryIcons[String(t.category || '').toUpperCase()];
      if (!label) return;
      byCategory[label] = byCategory[label] || [];
      byCategory[label].push(t);
    });

    Object.keys(byCategory).forEach(function (label) {
      lines.push('------------------');
      lines.push(label);
      byCategory[label].forEach(function (t) { lines.push(t.title); });
    });

    return lines.join('\n');
  }

  /**
   * Weekly Dashboard —— 今日完成数/剩余/即将到来/逾期/完成率
   */
  function buildWeeklyDashboard(allTasks) {
    var stats = AnalyticsEngine.computeStatistics(allTasks); // 26_AnalyticsEngine.gs
    var weekTasks = ViewEngine.thisWeek(allTasks);
    var overdueTasks = ViewEngine.overdue(allTasks);
    var todayDone = ViewEngine.today(allTasks).filter(function (t) {
      return String(t.status || '').toUpperCase() === 'DONE';
    });

    var lines = ['📊 Weekly Dashboard', ''];
    lines.push('今日已完成: ' + todayDone.length);
    lines.push('本周剩余: ' + weekTasks.length);
    lines.push('即将到来 (7天内): ' + ViewEngine.upcoming(allTasks).length);
    lines.push('逾期: ' + overdueTasks.length);
    lines.push('完成率: ' + stats.completion_rate + '%');

    return lines.join('\n');
  }

  /**
   * Monthly Dashboard —— 完成/取消/recurring/提醒次数/完成率
   */
  function buildMonthlyDashboard(allTasks) {
    var stats = AnalyticsEngine.computeStatistics(allTasks);
    var monthTasks = ViewEngine.thisMonth(allTasks);

    var lines = ['🗓️ Monthly Dashboard', ''];
    lines.push('本月待办: ' + monthTasks.length);
    lines.push('已完成: ' + stats.done_count);
    lines.push('已取消: ' + stats.cancelled_count);
    lines.push('Recurring: ' + stats.recurring_count);
    lines.push('提醒次数: ' + Math.round(stats.avg_reminder_count * stats.total_count));
    lines.push('完成率: ' + stats.completion_rate + '%');

    return lines.join('\n');
  }

  /**
   * Statistics Dashboard —— 规格书列的全部9项统计
   */
  function buildStatisticsDashboard(allTasks) {
    var stats = AnalyticsEngine.computeStatistics(allTasks);

    var lines = ['📈 Statistics Dashboard', ''];
    lines.push('任务总数: ' + stats.total_count);
    lines.push('待办: ' + stats.pending_count);
    lines.push('已完成: ' + stats.done_count);
    lines.push('已取消: ' + stats.cancelled_count);
    lines.push('完成率: ' + stats.completion_rate + '%');
    lines.push('平均完成耗时: ' + stats.avg_completion_hours + ' 小时');
    lines.push('平均提醒次数: ' + stats.avg_reminder_count);
    lines.push('高优先级数: ' + stats.high_priority_count);
    lines.push('Recurring数: ' + stats.recurring_count);

    return lines.join('\n');
  }

  /**
   * 统一入口，供 12_TaskQueryEngine.getDashboard(type, tasks) 调用。
   * @param {string} type  'today'|'weekly'|'monthly'|'statistics'
   * @param {object[]} allTasks
   * @returns {string}
   */
  function build(type, allTasks) {
    switch (String(type || '').toLowerCase()) {
      case 'today':      return buildTodayDashboard(allTasks);
      case 'weekly':     return buildWeeklyDashboard(allTasks);
      case 'monthly':    return buildMonthlyDashboard(allTasks);
      case 'statistics': return buildStatisticsDashboard(allTasks);
      default:
        return buildTodayDashboard(allTasks);
    }
  }

  return {
    build:                     build,
    buildTodayDashboard:       buildTodayDashboard,
    buildWeeklyDashboard:      buildWeeklyDashboard,
    buildMonthlyDashboard:     buildMonthlyDashboard,
    buildStatisticsDashboard:  buildStatisticsDashboard
  };
})();
