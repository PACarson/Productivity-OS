/**
 * 08_DeduplicationEngine.gs
 * JARVIS CORE v3.0 — 去重引擎
 *
 * 职责：检查某个业务对象是否已存在于 Read Model（Tasks/Inventory Sheet）。
 * 只读 Sheet，不读 Events，不写任何东西。
 *
 * 规则：
 *  - 只有 PENDING 状态的任务才算「已存在」（重复）
 *    → DONE / CANCELLED 的任务不阻止新实例创建
 *  - 库存：同名物品存在时视为「已存在」（补货走 restockItem，不走新建）
 *
 * 依赖：07_IdentityEngine（外部调用方生成 identity），05_SheetUtils（Sheet 工具）
 */

/**
 * ── Engine Contract（V4.3，按 00_Project_Constitution.gs 零之三标准补全）──
 *   Responsibilities      : 判断某个 identity 对应的业务对象是否已存在于
 *                           Read Model
 *   Owns                  : "已存在"的判定规则（只有 PENDING 状态算重复；
 *                           库存按同名判重）
 *   Reads                 : Tasks Sheet（本项目实际只用到这部分；Inventory
 *                           Sheet 逻辑是跟 Core 项目共用同一份代码副本时
 *                           保留的，本项目 Task 域用不到）
 *   Writes                : none
 *   Public API            : findExistingTask(identity)
 *   Dependencies          : 05_SheetUtils.gs（getSheet_/getHeaderMap_）
 *   Forbidden Dependencies: Events, Telegram/Output，Application 层以上
 *                           （09_IdempotencyManager/20_TaskEngine/
 *                           06_TaskIntentParser）
 *   Pure Function         : NO（直接读 Sheet，故归类 Application 层而非
 *                           Domain 层，见 00_File_Map.gs Architecture
 *                           Layer Map 的分类理由说明）
 *   Replay Events         : NO
 *   Projection            : NO（只读，不写任何 Read Model）
 *   Thread Safety         : 由调用方 09_IdempotencyManager 的 ScriptLock
 *                           保证串行，本模块自身不加锁
 *   Side Effects          : NO
 *   Notes                 : 归类为 Application 而不是 Domain 层是本次
 *                           V4.3 治理升级的一个明确判断——"直接读 Sheet"
 *                           跟 Domain 层"不摸 Sheet"的铁律冲突，详见
 *                           00_Project_Constitution.gs 零之四。
 */

var DeduplicationEngine = (function () {

  var TASKS_SHEET     = 'Tasks';
  var INVENTORY_SHEET = 'Inventory';

  // ============ 内部：按 identity 列扫 Sheet ============

  /**
   * 在指定 Sheet 里找第一行 identity 值匹配的行，返回对象或 null。
   *
   * ⚠️ 前提：Sheet 必须有 identity 列。
   *    如果还没有，调用 11_ProjectionRebuilder 的 migrateAddIdentityColumns() 先建列。
   *
   * @param {string} sheetName
   * @param {string} identity   SHA-256 hex
   * @returns {object|null}
   */
  function _findRowByIdentity_(sheetName, identity) {
    var sheet;
    try {
      sheet = getSheet_(sheetName); // 05_SheetUtils
    } catch (e) {
      Logger.log('[DeduplicationEngine] Sheet 不存在: ' + sheetName);
      return null;
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    var headerMap = getHeaderMap_(sheet); // 05_SheetUtils
    if (!headerMap.hasOwnProperty('identity')) {
      // identity 列还没建（V3 迁移未完成），返回 null 让上层走正常创建路径
      Logger.log('[DeduplicationEngine] ⚠️ ' + sheetName + ' 没有 identity 列，跳过去重（运行 migrateAddIdentityColumns() 修复）');
      return null;
    }

    var identityColIdx = headerMap['identity'];
    var numCols = sheet.getLastColumn();

    // 先只读 identity 列，找到行号再读整行（避免全表扫描所有列）
    var identityValues = sheet.getRange(2, identityColIdx + 1, lastRow - 1, 1).getValues();

    for (var i = 0; i < identityValues.length; i++) {
      if (String(identityValues[i][0]) === String(identity)) {
        // 找到了，读出整行转成对象
        var rowData = sheet.getRange(i + 2, 1, 1, numCols).getValues()[0];
        var obj = {};
        for (var h in headerMap) {
          obj[h] = rowData[headerMap[h]];
        }
        return obj;
      }
    }
    return null;
  }

  // ============ 对外接口 ============

  /**
   * 查找匹配 identity 且状态为 PENDING 的任务。
   * DONE / CANCELLED 的历史任务不会拦截新建。
   *
   * @param {string} identity
   * @returns {object|null} task 对象，或 null（不存在 / 已完成）
   */
  function findExistingTask(identity) {
    var row = _findRowByIdentity_(TASKS_SHEET, identity);
    if (!row) return null;
    if (String(row.status || '').toUpperCase() !== 'PENDING') return null; // 已完成/取消不算重复
    return row;
  }

  /** findPendingTask 是 findExistingTask 的语义别名 */
  function findPendingTask(identity) {
    return findExistingTask(identity);
  }

  /**
   * 查找匹配 identity 的库存物品（任何状态，CONSUMED 除外）。
   * 找到 → 补货路径；没找到 → 新建路径。
   *
   * @param {string} identity
   * @returns {object|null}
   */
  function findExistingInventory(identity) {
    var row = _findRowByIdentity_(INVENTORY_SHEET, identity);
    if (!row) return null;
    if (String(row.status || '') === 'CONSUMED') return null; // 软删除的不算存在
    return row;
  }

  /**
   * 通用 exists 检查
   * @param {string} identity
   * @param {string} sheetName
   * @returns {boolean}
   */
  function exists(identity, sheetName) {
    if (sheetName === TASKS_SHEET) {
      return findExistingTask(identity) !== null;
    }
    if (sheetName === INVENTORY_SHEET) {
      return findExistingInventory(identity) !== null;
    }
    return _findRowByIdentity_(sheetName, identity) !== null;
  }

  // ============ 开发者测试 ============

  function testDuplicateTask() {
    Logger.log('=== DeduplicationEngine.testDuplicateTask ===');
    var identity = IdentityEngine.generateTaskIdentity('test', '测试去重任务', '', '', 'MEDIUM', 'GENERAL');
    Logger.log('identity: ' + identity.slice(0, 16) + '...');
    var existing = findExistingTask(identity);
    Logger.log('findExistingTask result: ' + (existing ? '找到了: ' + existing.task_id : 'null（不存在或非PENDING）'));
    Logger.log('=== testDuplicateTask DONE ===');
  }

  function testDuplicateInventory() {
    Logger.log('=== DeduplicationEngine.testDuplicateInventory ===');
    var identity = IdentityEngine.generateInventoryIdentity('test', '测试物品', 'pcs');
    Logger.log('identity: ' + identity.slice(0, 16) + '...');
    var existing = findExistingInventory(identity);
    Logger.log('findExistingInventory result: ' + (existing ? '找到了: ' + existing.item_id : 'null（不存在）'));
    Logger.log('=== testDuplicateInventory DONE ===');
  }

  return {
    findExistingTask:      findExistingTask,
    findPendingTask:       findPendingTask,
    findExistingInventory: findExistingInventory,
    exists:                exists,
    testDuplicateTask:     testDuplicateTask,
    testDuplicateInventory: testDuplicateInventory
  };
})();
