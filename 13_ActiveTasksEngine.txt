/**
 * 13_ActiveTasksEngine.gs
 * JARVIS CORE v3.1 — ActiveTasks 工作台引擎（冷归档 + 历史查询）
 *
 * 职责：管理 ActiveTasks 和 ArchiveTasks 两张派生视图的冷归档生命周期。
 *
 * 架构关系：
 *   Tasks（全量 Read Model，含所有状态）
 *     ↓ ProjectionEngine（实时同步）
 *   ActiveTasks（工作台，只有 PENDING/IN_PROGRESS/WAITING）
 *     ↓ runDailyArchive（每日定时触发器）
 *   ArchiveTasks（归档库，DONE/CANCELLED 且超过 N 天的任务）
 *
 * 注意：
 *  - ActiveTasks 的"实时维护"（新建/完成/取消同步）由 10_ProjectionEngine.gs 负责。
 *  - 本文件只负责 Tasks → ArchiveTasks 的"冷归档"（低频，每天跑一次）。
 *  - ArchiveTasks 只增不删（等同 append-only 视图），不允许手动编辑。
 *  - 归档后 Tasks Sheet 里对应行加 archived=true 标记（不物理删除，保留全量 Read Model
 *    完整性）。如果将来 Tasks Sheet 变得非常大，可以考虑把 archived=true 的行从 Tasks
 *    物理移走，但目前不做——物理删除会让 rebuildAllProjections() 失去重建依据。
 *
 * Sheet 结构要求：
 *   Tasks Sheet：需要有 'archived' 列（boolean，setupSheets()/migrateAddIdentityColumns()
 *   会建，v3.2 之前 migrateAddIdentityColumns() 有 bug 从未真正建过这一列，
 *   见 15_Setup.gs 文件头 v3.2 变更记录）
 *   ArchiveTasks Sheet：需要有 'archived_at' 列（ISO 时间戳）
 *
 * 2026-06-29 新增（V3.1，ActiveTasks/ArchiveTasks 特性落地）。
 *
 * v3.2 变更（2026-07-01，外部审计 HIGH RISK 3，核实属实后采纳）：
 * runDailyArchive() 标记 archived=true 之前是在 forEach 循环里对每一行单独
 * setValue()——归档行数一多就是N次独立的Sheet单格写入请求，容易触发执行
 * 超时/配额问题（跟 HIGH RISK 1 同一类问题）。改成：收集阶段就地把内存里
 * 的 row 引用打上标记，最后对整个 archived 列做一次 setValues() 批量写回。
 *
 * v3.3 变更（V4.4，2026-07-06，外部审计 MEDIUM RISK 2，核实属实后采纳）：
 * runDailyArchive() 是"先追加 ArchiveTasks，再整列覆写 Tasks 的 archived
 * 标记"两步操作，不具备事务原子性。如果第一步成功后、第二步执行前 GAS
 * 中断（超时/异常/触发器被中途停掉），下次运行时这些行的 archived 标记
 * 仍是 false，会被重新判定为"待归档"并再次追加进 ArchiveTasks，产生重复
 * 归档行。修复：追加前先读一次 ArchiveTasks 现有 task_id 集合做排重校验，
 * 已经在 ArchiveTasks 里但 Tasks 侧标记没写成功的行，不再重复追加，只
 * 补写标记（自愈上次中断留下的半完成状态）。选择"排重校验"而不是审计
 * 建议的另一方案"先标记再追加"——后者如果在标记后、追加前中断，任务会
 * 从"未归档"直接消失又没真的进 ArchiveTasks，是更糟的数据丢失。
 *
 * v3.4 变更（V4.5，2026-07-06，外部审计 HIGH RISK 3，核实属实后采纳）：
 * v3.3 新增的排重校验原来是读 ArchiveTasks【全表】的 task_id 列——这张
 * 表只增不减，系统跑得越久这一列越大，每天的定时归档任务都要全量读一遍，
 * 迟早会拖慢执行、逼近 GAS 6 分钟上限。修复：改成只读最近
 * ARCHIVE_DEDUP_LOOKBACK_ROWS=2000 行（有界扫描，不随 ArchiveTasks 总
 * 行数增长）——排重真正需要覆盖的只有"上一次运行中断留下的半完成行"，
 * 触发器每天跑一次，这类行必然产生于最近一次运行，2000 行的窗口留了
 * 几十倍的安全余量，足够覆盖，不需要扫描全部历史。
 *
 * v3.5 变更（V4.6，2026-07-06，外部审计 MEDIUM RISK 1，核实后判断"部分
 * 采纳"）：审计描述的具体触发条件（archiveHeaderMap 的索引超过
 * archiveSheet.getLastColumn()）在单次执行内理论上不该发生——两者都
 * 源自同一条 getLastColumn() 调用链，中间没有会改变列结构的操作。但
 * 原代码确实在循环里对同一个"列数是多少"反复发起实时查询（每构建一行
 * 就调一次 getLastColumn()），如果考虑"有人在脚本执行期间通过 Sheets UI
 * 手动删列"这种极窄的理论竞态窗口，加固它没有坏处。修复：getLastColumn()
 * 只在函数开头调一次并缓存（archiveColumnCount），后续全部复用同一个值，
 * 并在赋值处加了硬性边界检查（越界则跳过该字段+打日志，绝不让数组自动
 * 扩张越界）——即使审计描述的具体场景不完全成立，这样改也是纯粹的加固，
 * 没有下行代价，顺带还去掉了循环里原本的冗余 API 调用。
 */

/**
 * ── Engine Contract（V4.3，按 00_Project_Constitution.gs 零之三标准补全）──
 *   Responsibilities      : 冷归档生命周期管理（Blueprint 术语里对应
 *                           Archive Engine：archive/retention）
 *   Owns                  : "多少天算该归档"这条业务规则
 *                           （DEFAULT_ARCHIVE_DAYS）、Tasks→ArchiveTasks
 *                           的搬迁逻辑
 *   Reads                 : Tasks Sheet（找出 DONE/CANCELLED 且超过
 *                           retention 天数的行）、ArchiveTasks Sheet
 *                           （getArchivedTasks 查询用）
 *   Writes                : Tasks（打 archived=true 标记，不物理删除）、
 *                           ArchiveTasks（追加归档行）
 *   Public API            : runDailyArchive(), getArchivedTasks(chatId, limit)
 *   Dependencies          : 05_SheetUtils.gs（getSheet_/getHeaderMap_）
 *   Forbidden Dependencies: 02_EventBus.gs（归档不是由 Event 驱动的，是
 *                           基于"现在几点"的定时任务，属于 Operations 范畴，
 *                           见 00_Project_Constitution.gs P4 4.5 Operations）、
 *                           Presentation 层
 *   Pure Function         : NO（直接读写 Sheet）
 *   Replay Events         : NO
 *   Projection            : NO（写的是 ArchiveTasks 这张"冷存储"，不是
 *                           实时 Projection——ActiveTasks 的实时投影由
 *                           10_ProjectionEngine.gs 负责，两者是不同职责，
 *                           见文件头"架构关系"）
 *   Thread Safety         : 由每日定时触发器单次调度，不考虑并发
 *   Side Effects          : YES（Sheet 写入 + 打标记）
 *   Notes                 : 归类为 Infrastructure 而非 Domain（见
 *                           00_File_Map.gs Architecture Layer Map）——
 *                           归档本身是机械的"按天数搬行"，不含
 *                           22_PriorityEngine 那种打分/排序类业务判断。
 */

var ActiveTasksEngine = (function () {

  var TASKS_SHEET   = 'Tasks';
  var ARCHIVE_SHEET = 'ArchiveTasks';
  var DEFAULT_ARCHIVE_DAYS = 7; // DONE/CANCELLED 超过7天自动归档

  // ============ 冷归档入口 ============

  /**
   * 每日定时触发器调用此函数。
   * 把 Tasks Sheet 里 DONE/CANCELLED 且 completed_at 距今超过 archiveDays 天的行
   * 复制到 ArchiveTasks，并在 Tasks 里标记 archived=true。
   *
   * @param {number} [archiveDays=7]
   * @returns {number}  归档行数
   */
  function runDailyArchive(archiveDays) {
    var days = (typeof archiveDays === 'number' && archiveDays > 0) ? archiveDays : DEFAULT_ARCHIVE_DAYS;
    Logger.log('=== ActiveTasksEngine.runDailyArchive（阈值：' + days + ' 天）===');

    var tasksSheet;
    var archiveSheet;
    try {
      tasksSheet   = getSheet_(TASKS_SHEET);
      archiveSheet = getSheet_(ARCHIVE_SHEET);
    } catch (e) {
      Logger.log('⚠️ Sheet 不存在，跳过归档: ' + e.message);
      return 0;
    }

    var tasksHeaderMap   = getHeaderMap_(tasksSheet);
    var archiveHeaderMap = getHeaderMap_(archiveSheet);
    var tasksLastRow     = tasksSheet.getLastRow();

    // 【V4.6 修复 MEDIUM RISK 1：物理列数不匹配导致归档失败】原来在下面的
    // 循环里，每构建一行 archiveRow 都会重新调一次 archiveSheet.getLastColumn()，
    // 最后 setValues() 时又再调一次——同一次执行内对同一个"列数应该是多少"
    // 这个问题反复发起实时查询，理论上如果这中间发生了列结构变化（比如
    // 归档进行到一半，有人手动在 Sheets UI 里删了 ArchiveTasks 最右侧的
    // 列），前后几次 getLastColumn() 就可能返回不同的值，导致 archiveRow
    // 的长度和最终 setValues() 指定的 Range 宽度不一致，报
    // "The number of columns in the data does not match..." 异常，
    // 归档任务整体失败。
    // 修复：只在这里调一次 getLastColumn()，缓存进 archiveColumnCount，
    // 后面构建每一行 / 最终写入都复用这同一个数值，不再重复实时查询——
    // 这同时也去掉了循环里原本每行一次的冗余 API 调用（性能顺带改善），
    // 并让"这次归档操作认定的列数"在整个函数执行期间保持单一、确定的
    // 来源，不会中途改变。
    var archiveColumnCount = archiveSheet.getLastColumn();

    if (tasksLastRow < 2) {
      Logger.log('Tasks Sheet 没有数据行，跳过');
      return 0;
    }

    var tasksNumCols = tasksSheet.getLastColumn();
    var allRows      = tasksSheet.getRange(2, 1, tasksLastRow - 1, tasksNumCols).getValues();

    var statusIdx      = tasksHeaderMap['status'];
    var completedAtIdx = tasksHeaderMap['completed_at'];
    var archivedIdx    = tasksHeaderMap['archived'];
    var taskIdIdx      = tasksHeaderMap['task_id'];

    if (statusIdx === undefined || completedAtIdx === undefined || taskIdIdx === undefined) {
      Logger.log('❌ Tasks Sheet 缺少必要列（status/completed_at/task_id）');
      return 0;
    }

    // 【MEDIUM RISK 2 修复，V4.4，外部审计，核实属实后采纳】runDailyArchive
    // 之前是"先追加 ArchiveTasks，再整列覆写 Tasks 的 archived 标记"——如果
    // GAS 恰好在第一步成功、第二步执行前被打断（超时/异常/触发器被中途
    // 停掉），下次触发器运行时，这些行的 archived 标记仍然是 false，会
    // 被再次判定为"待归档"，重复追加进 ArchiveTasks，产生重复归档行。
    //
    // 修复：追加前先读一次 ArchiveTasks 现有的 task_id 集合，遇到"已经在
    // ArchiveTasks 里、但 Tasks 这边 archived 标记因为上次中断没写成功"的
    // 行，不再重复追加，只补写 archived 标记（等于自愈上次中断遗留的
    // 半完成状态）。这不需要改变"先追加再标记"的顺序（审计建议的另一个
    // 方案是"先标记再追加"，但那样如果在标记后、追加前中断，任务会从
    // "未归档"直接消失又没真的进 ArchiveTasks，是更糟的数据丢失，所以
    // 选排重校验而不是换顺序）。
    //
    // 【V4.5 修复 HIGH RISK 3：归档表无限膨胀引发的执行超时/内存风险】
    // 上面这个排重校验原来是读 ArchiveTasks【全表】的 task_id 列——
    // ArchiveTasks 只增不减，系统跑几个月/几年后这一列会变得很大，每天
    // 定时任务都要全量读一遍，迟早会拖慢执行、逼近 GAS 6 分钟上限，这个
    // 趋势本身不会随时间推移而好转，只会越来越接近临界点。
    // 而这个排重校验真正需要覆盖的场景，只有"上一次运行到一半被中断"这
    // 一种——触发器是每天跑一次，能够进入"半完成、等待自愈"状态的行，
    // 必然是最近一次（至多前一天）运行时产生的，不可能是几个月前就已经
    // 完整归档、标记也早就补上的旧行。所以排重只需要覆盖"最近一段时间
    // 追加的行"，不需要覆盖 ArchiveTasks 的全部历史。
    // 做法：只读最近 ARCHIVE_DEDUP_LOOKBACK_ROWS 行（而不是全表）的
    // task_id 做排重——ArchiveTasks 是只追加（append-only）表，新行永远
    // 加在最后，"最近 N 行"在物理上就是"最近归档的 N 条"，用一次有界的
    // getRange 就能定位，读取量固定为常数，不随 ArchiveTasks 总行数增长。
    // ARCHIVE_DEDUP_LOOKBACK_ROWS 取 2000——对个人任务系统而言，这远超
    // "一天内可能归档的任务数"，留了几十倍的安全余量（哪怕连续多天
    // 触发器没跑、积压了好几轮才重新执行，2000 行的余量也足够覆盖），
    // 真正需要自愈的半完成行不可能落在这个窗口之外。
    var ARCHIVE_DEDUP_LOOKBACK_ROWS = 2000;
    var existingArchivedIds = {};
    var archiveLastRow = archiveSheet.getLastRow();
    if (archiveLastRow >= 2 && archiveHeaderMap.hasOwnProperty('task_id')) {
      var archiveTaskIdCol = archiveHeaderMap['task_id'] + 1;
      var lookbackStartRow = Math.max(2, archiveLastRow - ARCHIVE_DEDUP_LOOKBACK_ROWS + 1);
      var lookbackRowCount = archiveLastRow - lookbackStartRow + 1;
      var archiveIds = archiveSheet.getRange(lookbackStartRow, archiveTaskIdCol, lookbackRowCount, 1).getValues();
      archiveIds.forEach(function (r) {
        var id = String(r[0] || '');
        if (id) existingArchivedIds[id] = true;
      });
      if (lookbackStartRow > 2) {
        Logger.log('[ActiveTasksEngine] ArchiveTasks 共 ' + (archiveLastRow - 1) + ' 行，排重校验只读了最近 ' +
          lookbackRowCount + ' 行（有界扫描，见 HIGH RISK 3 修复说明），不做全表扫描');
      }
    }

    var cutoff     = Date.now() - days * 24 * 60 * 60 * 1000;
    var doneStatuses = { 'DONE': true, 'CANCELLED': true };
    var archiveNowTimestamp = new Date().toISOString();

    var rowsToArchive    = []; // { rowArray, rowIndex (2-based) }
    var archiveRowArrays = []; // 要 setValues 到 ArchiveTasks 的行数组
    var recoveredCount   = 0;  // 只补标记、没有重复追加的行数（上次中断的自愈）

    allRows.forEach(function (row, idx) {
      var status     = String(row[statusIdx] || '').toUpperCase();
      var alreadyArchived = archivedIdx !== undefined ? row[archivedIdx] : false;

      if (!doneStatuses[status]) return;
      if (alreadyArchived === true || alreadyArchived === 'TRUE' || alreadyArchived === 'true') return;

      var completedAt = row[completedAtIdx];
      if (!completedAt) return; // 没有 completed_at 跳过

      var completedTime = new Date(completedAt).getTime();
      if (isNaN(completedTime) || completedTime > cutoff) return; // 还不够 N 天

      rowsToArchive.push({ rowArray: row, rowIndex: idx + 2 });

      var thisTaskId = String(row[taskIdIdx] || '');
      var alreadyInArchiveSheet = thisTaskId && existingArchivedIds[thisTaskId];

      if (!alreadyInArchiveSheet) {
        // 构建 ArchiveTasks 行（在标记 archived 之前构建，archived 本身不是
        // ArchiveTasks 的字段，顺序其实不影响正确性，但这样写更清楚：
        // "先原样拷贝这一行的数据去archive，再改这一行在Tasks里的归档标记"）
        var archiveRow = new Array(archiveColumnCount).fill('');
        for (var h in tasksHeaderMap) {
          if (!archiveHeaderMap.hasOwnProperty(h)) continue;
          var colIdx = archiveHeaderMap[h];
          // 硬性边界防护：哪怕上面 archiveColumnCount 缓存的机制出于某种
          // 没预料到的原因还是跟 archiveHeaderMap 的索引对不上，这里也
          // 绝不允许越界赋值把数组悄悄撑大（JS 数组对越界索引赋值默认会
          // 自动扩张，正是 MEDIUM RISK 1 描述的问题的直接成因）——宁可
          // 跳过这个字段、打日志，也不要让 setValues() 最后炸在一个更难
          // 定位的地方。
          if (colIdx < 0 || colIdx >= archiveColumnCount) {
            Logger.log('[ActiveTasksEngine] ⚠️ 字段"' + h + '"在 ArchiveTasks 表头映射的列索引(' +
              colIdx + ')超出当前表实际列数(' + archiveColumnCount + ')，跳过该字段（不影响其余字段归档）');
            continue;
          }
          archiveRow[colIdx] = row[tasksHeaderMap[h]];
        }
        if (archiveHeaderMap.hasOwnProperty('archived_at') &&
            archiveHeaderMap['archived_at'] >= 0 && archiveHeaderMap['archived_at'] < archiveColumnCount) {
          archiveRow[archiveHeaderMap['archived_at']] = archiveNowTimestamp;
        }
        archiveRowArrays.push(archiveRow);
      } else {
        // 上次运行已经把这行写进 ArchiveTasks 了，只是中断在"标记 Tasks"
        // 这一步之前——不重复追加，只补标记（见上方修复说明）。
        recoveredCount++;
        Logger.log('[ActiveTasksEngine] task_id=' + thisTaskId +
          ' 已存在于 ArchiveTasks（上次运行中断的自愈），跳过重复追加，仅补标记');
      }

      // HIGH RISK 3 修复（外部审计，核实属实后采纳）：不在这里单独对 Sheet
      // 发 setValue() 请求。row 是 allRows[idx] 的同一个数组引用（JS数组存的
      // 是引用，getValues()返回的二维数组里每个子数组都是独立对象，这里的
      // row 参数就是那个对象本身）——直接在内存里改这个引用，allRows 也会
      // 跟着变。等下面全部行处理完，一次性把整列 archived 的值 setValues()
      // 写回，无论归档多少行，物理I/O调用数固定为1次。
      if (archivedIdx !== undefined) {
        row[archivedIdx] = true;
      }
    });

    if (rowsToArchive.length === 0) {
      Logger.log('没有需要归档的任务');
      return 0;
    }

    // 批量写入 ArchiveTasks（只写真正需要新追加的行，见上方排重校验）
    if (archiveRowArrays.length > 0) {
      var archiveStartRow = archiveSheet.getLastRow() + 1;
      archiveSheet.getRange(archiveStartRow, 1, archiveRowArrays.length, archiveColumnCount)
                  .setValues(archiveRowArrays);
    }

    // 在 Tasks 里标记 archived=true（如果有 archived 列）
    // HIGH RISK 3 修复：allRows 在上面收集阶段已经就地把被归档行的
    // row[archivedIdx] 改成了 true（allRows 和 row 是同一份引用），这里只需要
    // 把 archived 这一整列一次性 setValues() 写回 Sheet。不管这次归档了
    // 多少行，物理 I/O 调用数固定为 1 次，不再是 N 次独立的单格写入请求。
    // 安全性说明：archived 列全代码库只有这个函数会写（唯一写入方），
    // 不存在与其他并发路径互相覆盖的风险，可以放心整列覆写；
    // 也正因为只有这里写，才没有必要做"只写变化的行"这种更复杂的差量写入。
    if (archivedIdx !== undefined) {
      var archivedColumnValues = allRows.map(function (row) {
        var v = row[archivedIdx];
        return [v === true || v === 'TRUE' || v === 'true'];
      });
      tasksSheet.getRange(2, archivedIdx + 1, archivedColumnValues.length, 1).setValues(archivedColumnValues);
    }

    Logger.log('✅ 归档完成：新追加 ' + archiveRowArrays.length + ' 条到 ArchiveTasks' +
      (recoveredCount > 0 ? '，另有 ' + recoveredCount + ' 条是补标记（上次中断自愈，未重复追加）' : '') +
      '，Tasks 侧共标记 ' + rowsToArchive.length + ' 条');
    return rowsToArchive.length;
  }

  // ============ 历史查询 ============

  /**
   * 读 ArchiveTasks 里最新的 N 条记录（按 archived_at 降序）。
   * 供 /archive 命令使用（区别于 /history 只看 Tasks 里近期完成的）。
   *
   * @param {string} chatId
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  function getArchivedTasks(chatId, limit) {
    var maxRows = (typeof limit === 'number' && limit > 0) ? limit : 20;
    try {
      var sheet   = getSheet_(ARCHIVE_SHEET);
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      var headerMap    = getHeaderMap_(sheet);
      var chatIdIdx    = headerMap['chat_id'];
      var archivedAtIdx = headerMap['archived_at'];
      var numCols      = sheet.getLastColumn();
      var rows         = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

      var tasks = [];
      rows.forEach(function (row) {
        if (chatIdIdx !== undefined && String(row[chatIdIdx]) !== String(chatId)) return;
        var task = {};
        for (var h in headerMap) task[h] = row[headerMap[h]];
        tasks.push(task);
      });

      // 按 archived_at 降序
      tasks.sort(function (a, b) {
        var ta = a.archived_at ? new Date(a.archived_at).getTime() : 0;
        var tb = b.archived_at ? new Date(b.archived_at).getTime() : 0;
        return tb - ta;
      });

      return tasks.slice(0, maxRows);

    } catch (e) {
      Logger.log('[ActiveTasksEngine] getArchivedTasks 失败: ' + e.message);
      return [];
    }
  }

  // ============ 触发器 ============
  //
  // v3.1 设计决定：触发器的实际创建（ScriptApp.newTrigger().create()）统一放在
  // 15_Setup.gs 的 createTriggers() 里管理，跟 checkReminders/
  // runRiderConnectorSync/dailyInventoryCheck 用同一套"先清旧的、再建新的"
  // 幂等模式，避免在两个文件里各维护一份触发器创建逻辑（犯C5）。
  // 本文件只暴露 triggerDailyArchive 这个全局入口函数供触发器调用。

  return {
    runDailyArchive:   runDailyArchive,
    getArchivedTasks:  getArchivedTasks
  };
})();

/**
 * GAS 触发器调用的全局函数入口（触发器不能指向 IIFE 成员方法，必须是全局函数）。
 */
function triggerDailyArchive() {
  ActiveTasksEngine.runDailyArchive();
}
