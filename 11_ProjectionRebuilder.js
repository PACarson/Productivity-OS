/**
 * 11_ProjectionRebuilder.gs
 * Productivity OS v4.7 — Projection Rebuilder（从 Events 全量重建 Read Model
 * ／每日常规维护 TaskStatistics）
 *
 * 【2026-07-17 新增，ADR-2026-07-17-009，Carson 批准】新增
 * migrateSchemaReminderPolicy()（既有部署迁移入口，模式跟
 * migrateSchemaDueTime() 一致）——给 Tasks/ActiveTasks/ArchiveTasks 三张表
 * 新增 reminder_policy 一列。不需要新的纯文本格式修复函数，复用既有的
 * _setPlainTextFormatForNewColumns_()。
 *
 * 【V4.7 新增，Due Time Support，00_Architecture_Review.gs「七、
 * Review #3」，Carson 2026-07-13 批准】新增 migrateSchemaDueTime()（既有
 * 部署迁移入口，模式跟 migrateSchemaV4() 一致）与配套的
 * _setPlainTextFormatForNewColumns_()（修复 Finding DT-2：
 * _addColumnsIfMissing_ 本身不会给新增列设纯文本格式，due_time 这种
 * 'HH:mm' 形状的值会被 Google Sheets 自动类型识别成 Time 类型）。
 * rebuildTasksProjection() / rebuildActiveTasksProjection() 两处 identity
 * 重算改用 IdentityEngine.resolveIdentityDueValue(task)，不再直接读
 * task.due_date。
 *
 * 【V4.6 新增 recomputeStatisticsFromTasks_()】第五轮外部审计 HIGH RISK 1
 * + HIGH RISK 4：TaskStatistics 不再由 10_ProjectionEngine.gs 同步增量
 * 维护（那样既有并发下的 lost update 风险，又是为一张没有查询路径依赖的
 * 表支付的纯浪费 I/O）。新增本函数，从 Tasks 表（不是 Events）按 chat_id
 * 重新聚合，由 15_Setup.gs 的每日触发器调用，成本远低于本文件其余函数
 * 那种"全量重放 Events"的方式。完整架构论证见 00_ADR.gs
 * ADR-2026-07-06-005。rebuildStatisticsProjection()（从 Events 重放）
 * 保留作为灾难恢复工具，两者的定位区别见各自的函数头注释。
 *
 * 【V4.4 配套修复 HIGH RISK 3：Events 全表扫描风险】rebuildAllProjections()
 * 开始前新增一行日志，用 EventBus.getEventCount_()（轻量，只读行数）报一下
 * Events 表规模——本文件的 rebuild／verify／compare 系列函数全部是"人工手动
 * 触发的 Operations 层操作"，允许全量扫描 Events（这本来就是它们存在的
 * 意义：从 Write Model 重建 Read Model），风险点在于"Events 表大了以后
 * 这些操作可能跑很久甚至超时"，完整的风险说明和范围界定见
 * 02_EventBus.gs 的 getAllEvents() 文件头注释。
 *
 * 使用场景（仅以下情况才运行，正常用户路径绝不调用）：
 *  - 首次上线迁移
 *  - Read Model 损坏（手动改坏了 Sheet）
 *  - 排查数据一致性问题
 *  - 运行 verifyProjection() 发现 Read Model 与 Events 对不上
 *
 * 使用方法：
 *  1. 先运行 migrateSchemaV4()  — 只需执行一次，添加 V4 新列 + 建新表
 *  2. 再运行 rebuildAllProjections()  — 从 Events 全量重建全部 Read Model
 *  3. 用 verifyProjection() 校验结果
 *
 * 【V4 修复】删除了 rebuildInventoryProjection() / _markRemovedItemsConsumed_()——
 * 这两个函数引用不存在于本项目的 deriveInventory()（Inventory 逻辑本该在
 * 2026-07-03 物理拆分时随 21_InventoryModule.gs 一起留在 Core 项目，但当时
 * 被漏删，见 00_Project_State.gs"已知Bug"）。只要有人在本项目运行
 * rebuildAllProjections()，之前会直接 ReferenceError 崩掉。Inventory Read
 * Model 重建请在 Core 项目自己的 11_ProjectionRebuilder.gs 副本里做。
 *
 * 【V4 新增】rebuildStatisticsProjection() / rebuildTaskFiltersProjection()，
 * 对应 10_ProjectionEngine.gs 新增维护的 TaskStatistics / TaskFilters 两张表。
 *
 * 依赖：02_EventBus, 05_SheetUtils, 07_IdentityEngine, 20_TaskEngine
 */

// ============ Step 1：列迁移 + 建表 ============

/**
 * 一次性迁移：在 Tasks/ActiveTasks/ArchiveTasks 添加 V4 所需的新列
 * （description/tags），并确保 identity/archived 列存在（沿用 V3 迁移）。
 *
 * 安全：幂等，列已存在时跳过，不修改任何现有数据。
 * 运行时机：V4 上线前运行一次即可（新装机走 15_Setup.gs 的 setupSheets()
 * 就已经带这些列，不需要再跑这个；只有从 V3 或更早版本迁移的老部署需要）。
 */
function migrateSchemaV4() {
  Logger.log('=== migrateSchemaV4 ===');
  _addColumnsIfMissing_('Tasks',        ['identity', 'archived', 'description', 'tags']);
  _addColumnsIfMissing_('ActiveTasks',  ['identity', 'description', 'tags']);
  _addColumnsIfMissing_('ArchiveTasks', ['identity', 'archived_at', 'description', 'tags']);
  Logger.log('✅ V4 列迁移完成。TaskStatistics/TaskFilters 两张新表请跑 15_Setup.setupSheets() 建立。');
}

/**
 * 保留 V3 函数名作为向后兼容别名（老交接文档/记忆可能还提这个名字）。
 */
function migrateAddIdentityColumns() {
  migrateSchemaV4();
}

/**
 * 如果 Sheet 缺少指定列名，在最右侧追加。
 */
function _addColumnsIfMissing_(sheetName, columnNames) {
  var sheet;
  try {
    sheet = getSheet_(sheetName);
  } catch (e) {
    Logger.log('⚠️ Sheet 不存在，跳过: ' + sheetName);
    return;
  }

  var headerMap = getHeaderMap_(sheet);
  var lastCol   = sheet.getLastColumn();

  columnNames.forEach(function (col) {
    if (col in headerMap) {
      Logger.log('  [' + sheetName + '] 列 "' + col + '" 已存在，跳过');
      return;
    }
    lastCol++;
    sheet.getRange(1, lastCol).setValue(col);
    Logger.log('  [' + sheetName + '] 添加列 "' + col + '" 在第 ' + lastCol + ' 列');
  });
}

/**
 * Due Time Support（V4.7，00_Architecture_Review.gs「七、Review #3」，
 * Carson 2026-07-13 批准）——existing 部署迁移入口。跟 migrateSchemaV4()
 * 同一种"一次性、幂等、只加列不改数据"模式，额外多做一步
 * _setPlainTextFormatForNewColumns_（Finding DT-2 的修复：
 * _addColumnsIfMissing_ 本身不会给新增列设纯文本格式，due_time 这种
 * 'HH:mm' 形状的值会被 Google Sheets 自动类型识别成 Time 类型，静默
 * 改变存储形式——这里补上 15_Setup._ensureSheet_() 对全新建表已经在做的
 * 同一件事）。
 */
function migrateSchemaDueTime() {
  Logger.log('=== migrateSchemaDueTime ===');
  _addColumnsIfMissing_('Tasks',        ['due_time', 'due_datetime']);
  _addColumnsIfMissing_('ActiveTasks',  ['due_time', 'due_datetime']);
  _addColumnsIfMissing_('ArchiveTasks', ['due_time', 'due_datetime']);
  _setPlainTextFormatForNewColumns_('Tasks',        ['due_time', 'due_datetime']);
  _setPlainTextFormatForNewColumns_('ActiveTasks',  ['due_time', 'due_datetime']);
  _setPlainTextFormatForNewColumns_('ArchiveTasks', ['due_time', 'due_datetime']);
  Logger.log('✅ due_time/due_datetime 列迁移完成（含纯文本格式修复）。存量行 due_time/due_datetime 为空字符串，等价于需求方"只有 due_date 时 due_time 视为 null"。');
}

/**
 * 【2026-07-17 新增，ADR-2026-07-17-009，Carson 批准】给已经存在的部署
 * 新增 reminder_policy 一列，不需要跑完整的 setupSheets()。幂等——多次
 * 运行、列已存在时会跳过。运行方式：Apps Script 编辑器里选中这个函数，
 * 手动执行一次。跟 migrateSchemaDueTime 是同一个模式——只是"加列"，不是
 * "填数据"：存量任务的 reminder_policy 留空即可，_parseJsonSafe_（
 * Reminder OS 那边）和本项目这边的 falsy 检查都会把空字符串当成 null
 * 处理，等价于"没有覆盖，用 Reminder OS 默认策略"，不需要额外回填。
 */
function migrateSchemaReminderPolicy() {
  Logger.log('=== migrateSchemaReminderPolicy ===');
  _addColumnsIfMissing_('Tasks',        ['reminder_policy']);
  _addColumnsIfMissing_('ActiveTasks',  ['reminder_policy']);
  _addColumnsIfMissing_('ArchiveTasks', ['reminder_policy']);
  _setPlainTextFormatForNewColumns_('Tasks',        ['reminder_policy']);
  _setPlainTextFormatForNewColumns_('ActiveTasks',  ['reminder_policy']);
  _setPlainTextFormatForNewColumns_('ArchiveTasks', ['reminder_policy']);
  Logger.log('✅ reminder_policy 列迁移完成（含纯文本格式修复——JSON 字符串通常不会被 Sheets 误判类型，这里只是保持跟 due_time/due_datetime 一致的防御性处理）。存量行 reminder_policy 为空字符串，等价于"没有覆盖，用 Reminder OS 默认策略"。');
}

/**
 * 对指定列的既有数据区（不含表头行）设纯文本格式，防止 Google Sheets
 * 把形如 'HH:mm' / 'yyyy-MM-ddTHH:mm:ss' 的字符串自动识别成 Time/
 * DateTime 类型。只处理"迁移时已经存在的行"——迁移之后新建的行走
 * createTaskDirect_ → upsertRowByKey_ 正常写入路径，不经过这个函数。
 */
function _setPlainTextFormatForNewColumns_(sheetName, columnNames) {
  var sheet;
  try {
    sheet = getSheet_(sheetName);
  } catch (e) {
    Logger.log('⚠️ Sheet 不存在，跳过: ' + sheetName);
    return;
  }

  var headerMap = getHeaderMap_(sheet);
  var lastRow   = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('  [' + sheetName + '] 没有数据行，跳过纯文本格式设置');
    return;
  }

  columnNames.forEach(function (col) {
    if (!(col in headerMap)) {
      Logger.log('  ⚠️ [' + sheetName + '] 列 "' + col + '" 不存在，跳过格式设置');
      return;
    }
    var colIndex = headerMap[col] + 1; // 转 1-based
    sheet.getRange(2, colIndex, lastRow - 1, 1).setNumberFormat('@');
    Logger.log('  [' + sheetName + '] 列 "' + col + '" 已设为纯文本格式');
  });
}

// ============ Step 2：全量重建 ============

/**
 * 重建 Tasks Read Model。
 *
 * 流程：
 *  1. 从 EventBus 拿全部 Events
 *  2. 按 TaskEngine.deriveFromEvent 逻辑还原 stateMap
 *  3. 为每个 Task 计算 identity（旧 Events payload 里没有 identity 字段时在线算）
 *  4. 批量写回 Tasks Sheet（O(1)级Sheet I/O，跟数据量无关）
 *
 * ⚠️ 不清空 Tasks Sheet 里的行：upsert 是幂等的，已有行覆写，不存在的行追加。
 */
function rebuildTasksProjection() {
  Logger.log('=== rebuildTasksProjection ===');
  var events = EventBus.getAllEvents();
  var stateMap = {};

  events.forEach(function (e) {
    TaskEngine.deriveFromEvent(e, stateMap); // 20_TaskEngine.gs
  });

  var tasksToWrite = [];
  for (var id in stateMap) {
    var task = stateMap[id];

    if (!task.identity) {
      task.identity = IdentityEngine.generateTaskIdentity(
        task.chat_id   || '',
        task.title     || '',
        IdentityEngine.resolveIdentityDueValue(task),
        task.recurring || '',
        task.priority  || 'MEDIUM',
        task.category  || 'GENERAL'
      );
    }

    tasksToWrite.push(task);
  }

  var result = batchUpsertRowsByKey_('Tasks', 'task_id', tasksToWrite); // 05_SheetUtils.gs
  var count = tasksToWrite.length;

  Logger.log('✅ 重建 Tasks 完成，共处理 ' + count + ' 个任务（更新 ' + result.updated + ' / 新增 ' + result.appended + '）');
  return count;
}

/**
 * 重建 ActiveTasks Read Model（工作台过滤视图）。
 *
 * ⚠️ 跟 rebuildTasksProjection 的关键差异：ActiveTasks 是过滤视图（只放
 * 非终态任务），upsert-only 没法清掉"曾经活着、后来终结了，但因为
 * ProjectionEngine.dispatch 失败而卡在 ActiveTasks 里没被删掉"的陈旧行。
 * 所以这里改成「清空数据行（保留表头）→ 把 Events 推导出的全部非终态任务
 * 一次性批量写回」。
 */
function rebuildActiveTasksProjection() {
  Logger.log('=== rebuildActiveTasksProjection ===');

  var sheet;
  try {
    sheet = getSheet_('ActiveTasks');
  } catch (e) {
    Logger.log('⚠️ ActiveTasks Sheet 不存在，跳过重建（先跑 setupSheets() 建表）');
    return 0;
  }

  var events = EventBus.getAllEvents();
  var stateMap = {};
  events.forEach(function (e) {
    TaskEngine.deriveFromEvent(e, stateMap); // 20_TaskEngine.gs
  });

  var terminalStatuses = { 'DONE': true, 'CANCELLED': true };
  var activeTasks = [];
  for (var id in stateMap) {
    var task = stateMap[id];
    var status = String(task.status || '').toUpperCase();
    if (terminalStatuses[status]) continue;

    if (!task.identity) {
      task.identity = IdentityEngine.generateTaskIdentity(
        task.chat_id   || '',
        task.title     || '',
        IdentityEngine.resolveIdentityDueValue(task),
        task.recurring || '',
        task.priority  || 'MEDIUM',
        task.category  || 'GENERAL'
      );
    }
    activeTasks.push(task);
  }

  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }

  var count = 0;
  if (activeTasks.length > 0) {
    var result = batchUpsertRowsByKey_('ActiveTasks', 'task_id', activeTasks);
    count = result.updated + result.appended;
  }

  Logger.log('✅ 重建 ActiveTasks 完成，共处理 ' + count + ' 个活跃任务');
  return count;
}

/**
 * 重建 TaskStatistics Read Model（从 Events 全量重放）。
 *
 * 跟 ActiveTasks 一样是"派生汇总视图"，先清空数据行再按 chat_id 分组重算，
 * 避免陈旧计数器残留（比如某个 chat_id 的任务全被删光了，旧的统计行还在）。
 *
 * 【V4.6 定位澄清】TaskStatistics 现在的常规维护方式是每日批量任务
 * recomputeStatisticsFromTasks_()（见下方，从 Tasks 表算，成本低得多），
 * 本函数（从 Events 全量重放算）保留作为"灾难恢复"工具——如果连 Tasks
 * 表本身都怀疑损坏、需要从最原始的事实来源（Events）重建一切时用这个；
 * 日常场景（比如每天的定时任务）应该用 recomputeStatisticsFromTasks_()，
 * 不需要为了刷新一张汇总表就重放全部历史 Events。两者算出来的结果应该
 * 一致（都是"当前 Tasks 状态的聚合"），只是数据来源和成本不同。
 */
function rebuildStatisticsProjection() {
  Logger.log('=== rebuildStatisticsProjection（从 Events 全量重放，灾难恢复用） ===');

  var sheet;
  try {
    sheet = getSheet_('TaskStatistics');
  } catch (e) {
    Logger.log('⚠️ TaskStatistics Sheet 不存在，跳过重建（先跑 setupSheets() 建表）');
    return 0;
  }

  var events = EventBus.getAllEvents();
  var stateMap = {};
  events.forEach(function (e) {
    TaskEngine.deriveFromEvent(e, stateMap);
  });

  var byChat = {};
  for (var id in stateMap) {
    var t = stateMap[id];
    var chatId = t.chat_id || '';
    if (!chatId) continue;

    if (!byChat[chatId]) {
      byChat[chatId] = {
        chat_id: chatId, total_count: 0, pending_count: 0, done_count: 0,
        cancelled_count: 0, recurring_count: 0, reminder_count_total: 0,
        last_updated_at: new Date().toISOString()
      };
    }
    var s = String(t.status || '').toUpperCase();
    byChat[chatId].total_count++;
    if (s === 'DONE') byChat[chatId].done_count++;
    else if (s === 'CANCELLED') byChat[chatId].cancelled_count++;
    else byChat[chatId].pending_count++;
    if (t.recurring) byChat[chatId].recurring_count++;
    byChat[chatId].reminder_count_total += Number(t.reminder_count) || 0;
  }

  var rows = Object.keys(byChat).map(function (k) { return byChat[k]; });

  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }

  var count = 0;
  if (rows.length > 0) {
    var result = batchUpsertRowsByKey_('TaskStatistics', 'chat_id', rows);
    count = result.updated + result.appended;
  }

  Logger.log('✅ 重建 TaskStatistics 完成（Events重放），共处理 ' + count + ' 个 chat_id');
  return count;
}

/**
 * 【V4.6 新增】按 chat_id 分组，从 Tasks 表（不是 Events）重新聚合
 * TaskStatistics 每一行。这是 TaskStatistics 现在的常规维护方式，供
 * 15_Setup.gs 的每日触发器 triggerDailyStatisticsRecompute() 调用。
 *
 * 跟 rebuildStatisticsProjection()（从 Events 全量重放）的区别：本函数
 * 假设 Tasks 表本身是可信的——Tasks 自己有独立的一致性保障
 * （10_ProjectionEngine 同步维护 + rebuildTasksProjection() 兜底），只是
 * 把 Tasks 表现有数据重新聚合一遍写回 TaskStatistics，不需要读那张只增
 * 不减、随时间增长的 Events 表（见 02_EventBus.gs getAllEvents() 文件头
 * 关于 Events 表规模的警告）。
 *
 * 完整架构论证见 00_ADR.gs ADR-2026-07-06-005。
 *
 * @returns {number} 处理的 chat_id 数量
 */
function recomputeStatisticsFromTasks_() {
  Logger.log('=== recomputeStatisticsFromTasks_（从 Tasks 表聚合，每日常规维护用） ===');

  var statsSheet;
  try {
    statsSheet = getSheet_('TaskStatistics');
  } catch (e) {
    Logger.log('⚠️ TaskStatistics Sheet 不存在，跳过（先跑 setupSheets() 建表）');
    return 0;
  }

  var tasksSheet = getSheet_('Tasks');
  var headerMap = getHeaderMap_(tasksSheet);
  var lastRow = tasksSheet.getLastRow();

  var byChat = {};
  if (lastRow >= 2) {
    var rows = tasksSheet.getRange(2, 1, lastRow - 1, tasksSheet.getLastColumn()).getValues();
    rows.forEach(function (row) {
      var chatId = row[headerMap['chat_id']];
      if (!chatId) return;

      if (!byChat[chatId]) {
        byChat[chatId] = {
          chat_id: chatId, total_count: 0, pending_count: 0, done_count: 0,
          cancelled_count: 0, recurring_count: 0, reminder_count_total: 0,
          last_updated_at: new Date().toISOString()
        };
      }

      var status = String(row[headerMap['status']] || '').toUpperCase();
      byChat[chatId].total_count++;
      if (status === 'DONE') byChat[chatId].done_count++;
      else if (status === 'CANCELLED') byChat[chatId].cancelled_count++;
      else byChat[chatId].pending_count++;
      if (row[headerMap['recurring']]) byChat[chatId].recurring_count++;
      byChat[chatId].reminder_count_total += Number(row[headerMap['reminder_count']]) || 0;
    });
  }

  var statsRows = Object.keys(byChat).map(function (k) { return byChat[k]; });

  var statsLastRow = statsSheet.getLastRow();
  if (statsLastRow >= 2) {
    statsSheet.getRange(2, 1, statsLastRow - 1, statsSheet.getLastColumn()).clearContent();
  }

  var count = 0;
  if (statsRows.length > 0) {
    var result = batchUpsertRowsByKey_('TaskStatistics', 'chat_id', statsRows);
    count = result.updated + result.appended;
  }

  Logger.log('✅ recomputeStatisticsFromTasks_ 完成，共处理 ' + count + ' 个 chat_id（数据源：Tasks 表，未触碰 Events）');
  return count;
}

/**
 * 重建 TaskFilters Read Model（V4新增）。
 */
function rebuildTaskFiltersProjection() {
  Logger.log('=== rebuildTaskFiltersProjection ===');

  var sheet;
  try {
    sheet = getSheet_('TaskFilters');
  } catch (e) {
    Logger.log('⚠️ TaskFilters Sheet 不存在，跳过重建（先跑 setupSheets() 建表）');
    return 0;
  }

  var events = EventBus.getAllEvents();
  var stateMap = {};
  events.forEach(function (e) {
    TaskEngine.deriveFromEvent(e, stateMap);
  });

  var rows = [];
  for (var id in stateMap) {
    var t = stateMap[id];
    var searchableText = [t.title, t.description, t.notes, t.tags, t.category]
      .filter(function (v) { return !!v; })
      .join(' ')
      .toLowerCase();
    rows.push({
      task_id:         id,
      chat_id:         t.chat_id || '',
      searchable_text: searchableText,
      tags_csv:        t.tags || ''
    });
  }

  var count = 0;
  if (rows.length > 0) {
    var result = batchUpsertRowsByKey_('TaskFilters', 'task_id', rows);
    count = result.updated + result.appended;
  }

  Logger.log('✅ 重建 TaskFilters 完成，共处理 ' + count + ' 个任务');
  return count;
}

/**
 * 重建全部 Read Models。
 * 【V4修复】不再调用已删除的 rebuildInventoryProjection()（见文件头注释）。
 * 【V4.4 配套 HIGH RISK 3 修复】开始前先用 EventBus.getEventCount_()（轻量，
 * 只读行数不解析内容）报一下 Events 表当前规模——下面四个 rebuild* 函数
 * 各自都会完整读取一遍 Events（EventBus.getAllEvents() 内部超过阈值会
 * 自动打警告日志，见 02_EventBus.gs），这里提前给个总览，方便判断这次
 * 手动重建大概要花多久。
 */
function rebuildAllProjections() {
  Logger.log('=== rebuildAllProjections ===');
  Logger.log('Events 表当前共 ' + EventBus.getEventCount_() + ' 行（下面每个 rebuild* 函数都会各自完整读一遍）');
  rebuildTasksProjection();
  rebuildActiveTasksProjection();
  rebuildStatisticsProjection();  // V4新增
  rebuildTaskFiltersProjection(); // V4新增
  Logger.log('✅ 所有 Productivity OS Projection 重建完成');
}

// ============ Step 3：校验 ============

/**
 * 快速校验：比较 Events 推导的状态 vs Tasks Sheet 当前内容。
 * 只做抽样级别的一致性检查（数量是否相符、PENDING 任务是否都在 Sheet 里）。
 * 不做全字段 diff（那太慢了）。
 */
function verifyProjection() {
  Logger.log('=== verifyProjection ===');

  var fromEvents = TaskEngine.deriveTaskState_(); // 20_TaskEngine.gs，全量 derive
  var pendingFromEvents = Object.keys(fromEvents).filter(function (id) {
    return fromEvents[id].status === 'PENDING';
  });

  Logger.log('Events 推导的 PENDING 任务数: ' + pendingFromEvents.length);

  var sheet;
  try {
    sheet = getSheet_('Tasks');
  } catch (e) {
    Logger.log('❌ Tasks Sheet 不存在');
    return;
  }

  var headerMap = getHeaderMap_(sheet);
  var lastRow   = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('❌ Tasks Sheet 是空的');
    return;
  }

  var statusColIdx = headerMap['status'];
  var taskIdColIdx = headerMap['task_id'];
  if (statusColIdx === undefined || taskIdColIdx === undefined) {
    Logger.log('❌ Tasks Sheet 缺少 status 或 task_id 列');
    return;
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var pendingInSheet = rows.filter(function (row) {
    return String(row[statusColIdx] || '').toUpperCase() === 'PENDING';
  });

  Logger.log('Tasks Sheet 里的 PENDING 任务数: ' + pendingInSheet.length);

  var missing = [];
  pendingFromEvents.forEach(function (id) {
    var found = rows.some(function (row) {
      return String(row[taskIdColIdx]) === String(id);
    });
    if (!found) missing.push(id);
  });

  if (missing.length === 0) {
    Logger.log('✅ 校验通过：所有 PENDING 任务都在 Tasks Sheet 里');
  } else {
    Logger.log('❌ 校验失败：以下 task_id 在 Sheet 里缺失（运行 rebuildTasksProjection() 修复）:');
    missing.forEach(function (id) { Logger.log('   - ' + id); });
  }

  _verifyActiveTasksConsistency_(fromEvents);
}

/**
 * 校验 ActiveTasks 跟 Events 推导出的"非终态任务集合"是否一致。
 */
function _verifyActiveTasksConsistency_(fromEvents) {
  var nonTerminal = {};
  for (var id in fromEvents) {
    var status = String(fromEvents[id].status || '').toUpperCase();
    if (status !== 'DONE' && status !== 'CANCELLED') nonTerminal[id] = true;
  }

  var sheet;
  try {
    sheet = getSheet_('ActiveTasks');
  } catch (e) {
    Logger.log('⚠️ ActiveTasks Sheet 不存在，跳过 ActiveTasks 一致性校验');
    return;
  }

  var headerMap = getHeaderMap_(sheet);
  var taskIdColIdx = headerMap['task_id'];
  if (taskIdColIdx === undefined) {
    Logger.log('❌ ActiveTasks Sheet 缺少 task_id 列');
    return;
  }

  var lastRow = sheet.getLastRow();
  var idsInActiveTasks = {};
  if (lastRow >= 2) {
    var atRows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    atRows.forEach(function (row) {
      idsInActiveTasks[String(row[taskIdColIdx])] = true;
    });
  }

  var missingFromActiveTasks = Object.keys(nonTerminal).filter(function (id) {
    return !idsInActiveTasks[id];
  });
  var staleInActiveTasks = Object.keys(idsInActiveTasks).filter(function (id) {
    return !nonTerminal[id];
  });

  Logger.log('ActiveTasks 校验：Events推导非终态任务 ' + Object.keys(nonTerminal).length +
             ' 个，ActiveTasks Sheet 里 ' + Object.keys(idsInActiveTasks).length + ' 个');

  if (missingFromActiveTasks.length === 0 && staleInActiveTasks.length === 0) {
    Logger.log('✅ ActiveTasks 一致性校验通过');
    return;
  }

  if (missingFromActiveTasks.length > 0) {
    Logger.log('❌ 以下非终态task_id缺失于ActiveTasks（运行 rebuildActiveTasksProjection() 修复）:');
    missingFromActiveTasks.forEach(function (id) { Logger.log('   - ' + id); });
  }
  if (staleInActiveTasks.length > 0) {
    Logger.log('❌ 以下task_id是ActiveTasks里的陈旧行，Events显示已终结（运行 rebuildActiveTasksProjection() 修复）:');
    staleInActiveTasks.forEach(function (id) { Logger.log('   - ' + id); });
  }
}

/**
 * 比较 Projection 与 Events：输出每个任务的 Events 状态 vs Sheet 状态。
 * 仅建议在调试时手动运行，输出量大。
 */
function compareProjectionWithEvents() {
  Logger.log('=== compareProjectionWithEvents ===');

  var fromEvents = TaskEngine.deriveTaskState_();
  var sheet;
  try {
    sheet = getSheet_('Tasks');
  } catch (e) {
    Logger.log('❌ Tasks Sheet 不存在');
    return;
  }

  var headerMap = getHeaderMap_(sheet);
  var lastRow   = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('Tasks Sheet 是空的'); return; }

  var rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var sheetById = {};
  rows.forEach(function (row) {
    var id = String(row[headerMap['task_id']] || '');
    if (id) sheetById[id] = row;
  });

  var mismatch = 0;
  for (var id in fromEvents) {
    var evStatus    = (fromEvents[id].status || '').toUpperCase();
    var sheetRow    = sheetById[id];
    var sheetStatus = sheetRow ? String(sheetRow[headerMap['status']] || '').toUpperCase() : 'MISSING';

    if (evStatus !== sheetStatus) {
      Logger.log('❌ 不一致 [' + id + ']: Events=' + evStatus + ', Sheet=' + sheetStatus);
      mismatch++;
    }
  }

  if (mismatch === 0) {
    Logger.log('✅ 所有任务 status 一致（' + Object.keys(fromEvents).length + ' 个）');
  } else {
    Logger.log('共 ' + mismatch + ' 个不一致，运行 rebuildTasksProjection() 修复');
  }
}

/**
 * 修复 Projection（rebuildAllProjections 的别名，更符合「修复」语义）
 */
function repairProjection() {
  rebuildAllProjections();
}

/**
 * 【V4.6 新增】每日定时触发器入口，调用 recomputeStatisticsFromTasks_()。
 * 挂载见 15_Setup.gs 的 createTriggers()。命名跟 13_ActiveTasksEngine.gs
 * 的 triggerDailyArchive() 保持同一种"trigger 前缀 + 描述性名字"约定，
 * 方便在 Apps Script 触发器管理界面里辨认。
 */
function triggerDailyStatisticsRecompute() {
  recomputeStatisticsFromTasks_();
}
