/**
 * 02_EventBus.gs
 * Productivity OS v4.6 — 事件总线（Events 表唯一写入口，本项目内）
 *
 * 【V4.6 修复 MEDIUM RISK 2：Events 表硬编码列索引的脆弱性】原来
 * publish()/getAllEvents() 都用 r[0]..r[5] 固定位置读写——跟 Tasks/
 * ActiveTasks 一直用的 getHeaderMap_ 动态表头映射方案不一致。如果 Events
 * 表的列被手动调整过顺序，固定位置读写会直接错位、payload 解析失败退化
 * 成 {}，且没有任何报错提示。修复：改用 _headerMap_()（内部按名字动态
 * 定位列，执行期内缓存一份，避免每次 publish 都重新读表头），跟
 * Tasks/ActiveTasks 用同一套方案。⚠️ 这跟本项目"逐字未改"的 Core 共享
 * 副本状态有关的说明见下方，本次改动只影响 Productivity OS 自己这份
 * 副本，不影响 Core 项目的独立副本（Core 那边如果也有同样的硬编码写法，
 * 需要在 Core 项目里单独处理，本项目没有那个文件）。
 *
 * ⚠️ 2026-07-03 拆分说明：这是 Personal AI Core 的 02_EventBus.gs 的本地副本，
 * 唯一改动是 _sheet_()——Core 是 container-bound 脚本，用
 * SpreadsheetApp.getActiveSpreadsheet() 就能拿到正确的表；Productivity OS
 * 是独立（standalone）脚本，没有"容器"，必须用 SpreadsheetApp.openById()
 * 显式指定 Spreadsheet ID（跟 Core 用同一个共享 Spreadsheet，Script
 * Properties 里的 SPREADSHEET_ID 要设成跟 Core 一样的值）。
 * 【V4.5/V4.6 起这句"唯一改动"已经不准确】除了 _sheet_() 的
 * openById/getActiveSpreadsheet 差异外，本文件还独立新增了
 * projection_ok 字段（V4.2）、Spreadsheet 对象缓存（V4.5）、Events 表
 * 行数警告 + getEventCount_()（V4.5）、动态表头映射（V4.6）——这些都是
 * 本项目基于自己的审计发现单独演进出来的改动，Core 项目的副本是否也有
 * 同样的问题/修复，需要在那边单独核实，本文件不能替 Core 项目下结论。
 *
 * 为什么 Task 事件不通过 Core 的 EventBus，而是自己另开一份：
 * P1（EventBus 是 Events 表唯一写入者）指的是"同一类事件只有一条定义清晰
 * 的写入路径"，不是"物理上只能有一份代码"。Task/Reminder 相关事件
 * （TASK_CREATED/COMPLETED/CANCELLED/REMINDER_SENT）现在唯一的写入路径
 * 就是这份文件；Inventory 相关事件唯一的写入路径是 Core 自己的
 * 02_EventBus.gs。两边都 append 到同一张共享 Events 表（Google Sheets
 * 允许来自不同 Apps Script 项目的并发 appendRow，不会互相冲突），
 * 历史仍然是一份完整、按时间顺序的记录，只是"谁有权限写哪类事件"按
 * Domain 分开了。见 Personal AI Core 项目 00_Project_Constitution.gs 的
 * P6.2（Execution → Event 关系）。
 *
 * 以下为原始文件头（Core 版本），逻辑未变：
 *
 * v3.0 变更（相比 v2）：
 * 1. publish() 在 appendRow 之后同步调用 ProjectionEngine.dispatch(event)，
 *    保证 Read Model 与 Event Store 实时同步（同一次执行内不会 stale）。
 *    Projection 失败被 catch 并记录日志，不影响 Event 已写入的事实。
 * 2. 新增第 5 个可选参数 identity：
 *    - 由 09_IdempotencyManager / _createTaskDirect_ 传入
 *    - EventBus 维护一个「本次执行内 identity 缓存」（_inExecIdentityCache_）
 *    - 同一次脚本执行内，相同 identity 的 CREATE 事件只会写入一次
 *    - 不跨执行持久化，不是「第二套状态」
 *
 * 【V4.2 修复 HIGH RISK 3：频繁同步 Sheet 读写导致的 I/O 性能瓶颈】
 * 返回的 event 对象新增 projection_ok 字段（true/false）。之前
 * 20_TaskEngine.gs 的 completeTask/cancelTask/updateTask 不管
 * ProjectionEngine.dispatch 有没有成功，都无条件再调一次
 * materializeTaskRow_ 做"安全兜底"写入——等于每次操作稳定写两遍 Sheet。
 * 现在 dispatch 成功与否会同步反映在 event.projection_ok 上，调用方只有在
 * 看到 false（Projection 真的失败了）时才需要触发那次额外写入，正常路径
 * 下只有 dispatch 那一次 I/O。这是纯粹的新增字段（additive），不影响任何
 * 已有调用方读取 event.event_id/type/chat_id/payload/source 等原有字段。
 *
 * 架构铁律（保持不变）：
 *  - 这是（本项目负责的那部分）Events 表唯一的写入者
 *  - 只追加，不修改不删除
 */

var EventBus = (function () {
  var SHEET_NAME = 'Events';
  var COLS = ['event_id', 'timestamp', 'type', 'chat_id', 'payload', 'source'];
  var LARGE_EVENTS_WARNING_THRESHOLD = 5000; // V4.4 HIGH RISK 3 修复：见 getAllEvents() 文件头注释

  var _cachedEvents = null;        // 运行期内存缓存
  var _inExecIdentityCache_ = {};  // 本次执行内的 identity 去重缓存
  var _cachedSpreadsheet_ = null;  // V4.5新增：执行期内缓存 Spreadsheet 对象，见 _spreadsheet_() 修复说明

  /**
   * 2026-07-03 拆分新增：跨项目共享同一个 Spreadsheet，用 openById 而不是
   * getActiveSpreadsheet（standalone 脚本没有 active spreadsheet 的概念）。
   * SPREADSHEET_ID 要在本项目的 Script Properties 里设置成跟 Core 项目
   * 一样的值（跟 Core 那份 Spreadsheet 的 ID，去 Core 的
   * SecureConfig.getKey('SPREADSHEET_ID') 或者直接看那张表的 URL 抄）。
   *
   * 【V4.5 修复 MEDIUM RISK 1】原来每次调用都重新 openById——本文件是
   * IIFE，直接加一个私有闭包变量缓存住打开过的 Spreadsheet 对象即可，
   * 不需要像 05_SheetUtils.gs 那样纠结"没有 IIFE 怎么办"（那边额外加了
   * 一个刻意命名的顶层变量，见那边的修复说明）。同一次执行内 publish()
   * 可能被调用多次（比如 completeTask 触发的 recurring 续期又会走一次
   * createTask），缓存后这些调用共享同一个已经打开的 Spreadsheet 对象。
   */
  function _spreadsheet_() {
    if (!_cachedSpreadsheet_) {
      var id = SecureConfig.getKey('SPREADSHEET_ID');
      if (!id) {
        throw new Error('缺少 SPREADSHEET_ID（Script Properties）。这是跟 Personal AI Core ' +
          '共享的同一张 Spreadsheet 的 ID，去 Core 项目那边的表格 URL 复制，' +
          '然后 SecureConfig.setKey("SPREADSHEET_ID", "你复制的ID")。');
      }
      _cachedSpreadsheet_ = SpreadsheetApp.openById(id);
    }
    return _cachedSpreadsheet_;
  }

  function _sheet_() {
    var ss = _spreadsheet_();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      throw new Error('Events sheet 不存在，先跑本项目 15_Setup.gs 里的 setupSheets()（或者确认 SPREADSHEET_ID 指对了表）');
    }
    return sheet;
  }

  /**
   * 【V4.6 新增，修复 MEDIUM RISK 2：Events 表硬编码列索引的脆弱性】
   * 原来 publish()/getAllEvents() 都是按 r[0]..r[5] 固定位置读写 Events
   * 表——跟 Tasks/ActiveTasks 一直采用的"按表头名字动态找列"
   * （05_SheetUtils.getHeaderMap_）方案不一致。如果有人在运维时手动在
   * Events 表里插入/调整了列的位置，固定位置的读写会直接错位，JSON
   * payload 解析失败退化成 {}，且不会有任何报错提示，容易大面积损坏
   * 历史数据的可读性（虽然 Events 本身不可变，但"读出来的解释"会是错的）。
   * 修复：跟 Tasks/ActiveTasks 用同一套 getHeaderMap_ 动态映射方案，
   * 按列名找位置，不依赖固定顺序。表头本身在一次执行期间不会变化（跟
   * _cachedSpreadsheet_ 同样的道理），缓存一份，避免每次 publish/读取都
   * 重新查一遍表头行。
   */
  var _cachedHeaderMap_ = null;

  function _headerMap_() {
    if (!_cachedHeaderMap_) {
      _cachedHeaderMap_ = getHeaderMap_(_sheet_()); // 05_SheetUtils.gs
      var missing = COLS.filter(function (c) { return !_cachedHeaderMap_.hasOwnProperty(c); });
      if (missing.length > 0) {
        Logger.log('[EventBus] ⚠️ Events 表头缺少预期列: ' + JSON.stringify(missing) +
          '——这些字段的读写会被跳过，建议跑 15_Setup.repairSheetHeaders() 检查表头。');
      }
    }
    return _cachedHeaderMap_;
  }

  function _generateEventId_() {
    return 'EVT-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
  }

  /**
   * 唯一的写入函数
   *
   * @param {string} type      事件类型，比如 'TASK_CREATED'
   * @param {object} payload   事件的数据
   * @param {string} chatId
   * @param {string} source    哪个模块发的，比如 'ProductivityModule'
   * @param {string} [identity]  可选：业务身份 SHA-256。传入时启用执行内去重。
   * @returns {object|null}  写入的 event 对象（含 V4.2 新增的
   *                          projection_ok: boolean 字段），或 null
   *                          （被执行内去重拦截时）
   */
  function publish(type, payload, chatId, source, identity) {

    if (identity) {
      if (_inExecIdentityCache_[identity]) {
        Logger.log('[EventBus] 执行内去重命中，跳过: type=' + type + ' identity=' + identity.slice(0, 12) + '...');
        return null;
      }
      _inExecIdentityCache_[identity] = true;
    }

    var event = {
      event_id: _generateEventId_(),
      timestamp: new Date().toISOString(),
      type: type,
      chat_id: chatId || '',
      payload: payload || {},
      source: source || ''
    };

    // 【V4.6 修复 MEDIUM RISK 2】按表头名字动态定位列，不再假设固定顺序。
    var sheet = _sheet_();
    var headerMap = _headerMap_();
    var numCols = Math.max(sheet.getLastColumn(), COLS.length);
    var row = new Array(numCols).fill('');
    var fieldValues = {
      event_id:  event.event_id,
      timestamp: event.timestamp,
      type:      event.type,
      chat_id:   event.chat_id,
      payload:   JSON.stringify(event.payload),
      source:    event.source
    };
    COLS.forEach(function (col) {
      if (headerMap.hasOwnProperty(col)) {
        row[headerMap[col]] = fieldValues[col];
      }
      // 缺列的情况已经在 _headerMap_() 里打过一次性警告，这里不重复打印
    });
    sheet.appendRow(row);

    _cachedEvents = null; // 写入新事件，缓存失效

    // ── 同步触发 Projection，更新 Read Model ────────────────────────────────
    // V4.2：projection_ok 默认 true，dispatch 抛错时置 false，供调用方
    // （20_TaskEngine.gs）决定要不要做一次性的安全兜底写入（HIGH RISK 3 修复）。
    event.projection_ok = true;
    if (typeof ProjectionEngine !== 'undefined' && typeof ProjectionEngine.dispatch === 'function') {
      try {
        ProjectionEngine.dispatch(event);
      } catch (projErr) {
        event.projection_ok = false;
        Logger.log('[EventBus] Projection 失败（非致命）: ' + projErr.message + '。运行 rebuildAllProjections() 修复 Read Model。');
        _alertAdminProjectionFailure_(event, projErr);
      }
    }

    return event;
  }

  /**
   * Projection 失败时主动告警管理员。
   * 2026-07-03 拆分说明：这里改成给 TELEGRAM_CHAT_ID 直接发消息（本项目
   * 自己的 Output.gs 副本），不再经过 Core——避免"通知失败"这件小事也要
   * 依赖一次跨项目调用。
   */
  function _alertAdminProjectionFailure_(event, err) {
    try {
      var adminChatId = (typeof SecureConfig !== 'undefined') ? SecureConfig.getKey('TELEGRAM_CHAT_ID') : null;
      if (!adminChatId) {
        Logger.log('[EventBus] ⚠️ 没有配置 TELEGRAM_CHAT_ID，无法发送 Projection 失败告警');
        return;
      }
      var text = [
        '🚨 [Productivity OS] Read Model 同步失败（Projection Error）',
        '',
        '事件: ' + event.type + ' (event_id=' + event.event_id + ')',
        '错误: ' + err.message,
        '',
        '影响: Tasks/ActiveTasks Sheet 可能与 Events 表不一致。',
        '处理: 在本项目 GAS 编辑器运行 rebuildAllProjections() 修复。'
      ].join('\n');

      if (typeof Output !== 'undefined' && typeof Output.sendMessage === 'function') {
        Output.sendMessage(adminChatId, text);
      } else {
        Logger.log('[EventBus] ⚠️ Output 模块未加载，无法发送告警，告警内容: ' + text);
      }
    } catch (alertErr) {
      Logger.log('[EventBus] ❌ 连Projection失败告警都发不出去: ' + alertErr.message);
    }
  }

  /**
   * 读取全部事件（按行顺序，也就是发生顺序）
   * 本次执行内已读过则直接复用缓存。
   *
   * ⚠️ 这会读到 Core 那边写的 Inventory 事件也混在一起（同一张共享
   * Events 表）。deriveFromEvent/deriveTaskState_（20_ProductivityModule.gs）
   * 的 switch 只认 TASK_ 开头的几个 type 和 REMINDER_SENT，其余类型会落到 default
   * 分支被忽略，所以混在一起不影响 Task 状态推导，不需要在这里过滤。
   *
   * 【V4.4 修复 HIGH RISK 3：Events 全表扫描导致执行超时/内存风险】
   * 本函数天然是 O(全部历史事件数) 的一次性全量读取——Events 表只会
   * 持续追加、不会变小，理论上迟早会大到让一次 getAllEvents() 逼近 GAS
   * 30 秒/6 分钟执行上限。审计本身要求"不改变架构、不重构优化代码"
   * （见外部审计报告原文），真正的架构级修复（按时间分片/增量加载/把
   * 分析结果持久化成 Read Model）属于会改变 Events 表结构或读取方式的
   * 改动，不在本次修复范围内（已记录进 00_Roadmap.gs 供未来评估）。
   * 本次只做"让风险可见"这一层：行数超过 LARGE_EVENTS_WARNING_THRESHOLD
   * 时打一条警告日志，让手动运行 11_ProjectionRebuilder.gs 全量重建/校验
   * 的人至少能提前知道"这次可能会跑很久"，而不是莫名其妙地超时失败。
   *
   * 本项目实际会调用 getAllEvents() 的地方目前只有：
   *   - 20_TaskEngine.deriveTaskState_()（正常运行路径下不会被触发——
   *     materializeTaskRow_ 的所有调用点都显式传了 knownTask，deriveTaskState_
   *     只在 knownTask 缺失时才会被调用，目前只有 11_ProjectionRebuilder.gs
   *     手动运行时才会真正触发）
   *   - 11_ProjectionRebuilder.gs 的全部 rebuild／verify／compare 系列函数
   *     （Operations 层，人工手动触发，不在任何 Telegram 指令路径上）
   *   - 26_AnalyticsEngine.replayCompletionTrend_()（明确标注仅供 GAS
   *     编辑器手动调用，12_TaskQueryEngine.getStatistics 不调用它——本项目
   *     没有任何 /insights 或类似指令会触发它，这点已核实）
   * 也就是说，本项目当前所有会全表扫描 Events 的路径都不在用户可以从
   * Telegram 直接触发的位置上，只是 Operations 层操作——风险确实存在
   * （表大了以后这些操作会变慢/可能超时），但不是"普通用户日常操作就会
   * 触发"这个严重程度，见 00_Project_State.gs 对本条修复范围的说明。
   */
  function getAllEvents() {
    if (_cachedEvents !== null) return _cachedEvents;

    var sheet = _sheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      _cachedEvents = [];
      return _cachedEvents;
    }

    var rowCount = lastRow - 1;
    if (rowCount > LARGE_EVENTS_WARNING_THRESHOLD) {
      Logger.log('⚠️ [EventBus] Events 表已有 ' + rowCount + ' 行（超过警戒值 ' +
        LARGE_EVENTS_WARNING_THRESHOLD + '），getAllEvents() 全量读取可能较慢，' +
        '大量调用或跟其他重操作叠加时有触及 GAS 执行时间上限的风险。' +
        '如果是在跑 11_ProjectionRebuilder.gs 的重建/校验函数，属于预期内的' +
        '一次性操作；如果这条警告频繁出现在非 Operations 场景，说明有代码' +
        '在正常路径上意外触发了全表扫描，需要排查。');
    }

    // 【V4.6 修复 MEDIUM RISK 2】按表头名字动态定位列，不再假设 r[0]..r[5]
    // 固定顺序，见 _headerMap_() 的完整说明。找不到的字段用空字符串兜底，
    // 不会因为某一列缺失就让整行解析失败。
    var headerMap = _headerMap_();
    var idIdx      = headerMap['event_id'];
    var tsIdx       = headerMap['timestamp'];
    var typeIdx      = headerMap['type'];
    var chatIdx       = headerMap['chat_id'];
    var payloadIdx     = headerMap['payload'];
    var sourceIdx        = headerMap['source'];

    var rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    _cachedEvents = rows.map(function (r) {
      var payload = {};
      try {
        var rawPayload = (payloadIdx !== undefined) ? r[payloadIdx] : '';
        payload = rawPayload ? JSON.parse(rawPayload) : {};
      } catch (e) {
        payload = {};
      }
      return {
        event_id:  (idIdx     !== undefined) ? r[idIdx]     : '',
        timestamp: (tsIdx     !== undefined) ? r[tsIdx]     : '',
        type:      (typeIdx   !== undefined) ? r[typeIdx]   : '',
        chat_id:   (chatIdx   !== undefined) ? r[chatIdx]   : '',
        payload:   payload,
        source:    (sourceIdx !== undefined) ? r[sourceIdx] : ''
      };
    });
    return _cachedEvents;
  }

  /**
   * 【V4.4 新增】只读行数，不读取/解析任何实际内容——供调用方（比如
   * 11_ProjectionRebuilder.gs）在决定要不要跑一次全量操作之前，用一次
   * 极轻量的调用先看看"这次大概要扫多少行"，不需要为了看一眼行数就
   * 付出一次完整 getAllEvents() 的 I/O + JSON.parse 开销。
   * @returns {number}
   */
  function getEventCount_() {
    var sheet = _sheet_();
    var lastRow = sheet.getLastRow();
    return lastRow < 2 ? 0 : lastRow - 1;
  }

  function getEventsByType(type) {
    return getAllEvents().filter(function (e) {
      return e.type === type;
    });
  }

  return {
    publish:         publish,
    getAllEvents:    getAllEvents,
    getEventsByType: getEventsByType,
    getEventCount_:  getEventCount_
  };
})();
