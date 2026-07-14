/**
 * 07_IdentityEngine.gs
 * JARVIS CORE v3.0 / Productivity OS V4.7 分支 — 业务身份引擎
 *
 * 【V4.7 新增，Due Time Support】新增 resolveIdentityDueValue()，供
 * Due Time 相关的 4 个调用点统一取"identity 该用的到期值"，不改
 * generateTaskIdentity() 本身的签名或算法。完整设计见
 * 00_Architecture_Review.gs「七、Review #3」2.3 节。
 *
 * 职责：为每个业务对象生成确定性的 SHA-256 身份标识符（Identity）。
 * Identity 是「这个业务对象是否已经存在」的判断依据，与存储 ID（task_id / item_id）无关。
 *
 * 架构铁律：
 *  - 本模块不读写任何 Sheet，不调用 EventBus
 *  - 纯函数：输入相同 → 输出必然相同
 *  - 不依赖时间戳、随机数、UUID
 *
 * 依赖：无（最底层工具模块，零外部依赖）
 */

/**
 * ── Engine Contract（V4.3，按 00_Project_Constitution.gs 零之三标准补全）──
 *   Responsibilities      : 为业务对象生成确定性 SHA-256 身份标识（Identity）
 *   Owns                  : Identity 哈希算法本身（字段拼接顺序 + SHA-256）
 *   Reads                 : 若干原始字段（chatId/title/dueDate/recurring/
 *                           priority/category 等，按调用方传入的参数）
 *   Writes                : none
 *   Public API            : generateTaskIdentity(chatId, title, dueDate,
 *                           recurring, priority, category),
 *                           resolveIdentityDueValue(task)（V4.7 新增，
 *                           Due Time Support 的 identity 取值辅助函数）
 *   Dependencies          : 无（GAS 内建 Utilities.computeDigest 除外）
 *   Forbidden Dependencies: Sheet, Events, Telegram/Output，任何其他 Engine
 *   Pure Function         : YES
 *   Replay Events         : NO
 *   Projection            : NO
 *   Thread Safety         : 天然安全（纯函数，无共享可变状态）
 *   Side Effects          : NO
 *   Notes                 : 本模块被 08_DeduplicationEngine（Application 层）
 *                           和 20_TaskEngine（Application 层）调用，自身
 *                           属于 Domain 层最底层的纯计算工具，不依赖任何
 *                           其他 Engine（00_File_Map.gs Architecture Layer Map）。
 */

var IdentityEngine = (function () {

  // ============ SHA-256 ============

  /**
   * 把任意字符串算成 SHA-256 hex string。
   * GAS 内置 Utilities.computeDigest 返回有符号字节数组（-128~127），
   * 用 & 0xFF 把负数转成无符号字节再转十六进制。
   */
  function sha256_(input) {
    var bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(input),
      Utilities.Charset.UTF_8
    );
    return bytes.map(function (b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
  }

  // ============ 文本标准化 ============

  /**
   * 折叠空白（多个连续空白 → 单个空格）并 trim
   */
  function normalizeWhitespace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 转小写
   */
  function normalizeCase(text) {
    return String(text || '').toLowerCase();
  }

  /**
   * 全角 ASCII → 半角（输入法常见误输入：ＡＢＣ → ABC）
   * GAS 不支持 String.prototype.normalize()，用简化替代。
   */
  function normalizeUnicode(text) {
    return String(text || '').replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
  }

  /**
   * 标准化标题：
   *  1. 全角转半角
   *  2. 转小写
   *  3. 移除标点符号（只保留中英文字母、数字、空格）
   *  4. 折叠空白
   *
   * 效果：
   *   「提醒我去买菜」「去买菜！」「去 买 菜」→ 三者 identity 相同
   */
  function normalizeTitle(title) {
    var s = normalizeUnicode(title);
    s = normalizeCase(s);
    s = s.replace(/[^\w\u4e00-\u9fa5\u0020]/g, ' '); // 非字母数字中文 → 空格
    s = normalizeWhitespace(s);
    return s;
  }

  // ============ 业务 Identity 生成 ============

  /**
   * 任务 Identity
   *
   * 组合字段：chat_id | normalized_title | due_date | repeat_rule | priority | category
   *
   * ⚠️ 注意：相同标题 + 不同 due_date → 不同 identity → 可以共存
   *   「明天买菜」和「后天买菜」是两个不同任务，不会互相拦截。
   *   DONE / CANCELLED 不影响 identity 判断（那是 DeduplicationEngine 的事）。
   *
   *   【V4.7 补充，Due Time Support】dueDate 这个参数位本身的语义不变、
   *   函数签名不变——调用方如果任务同时有 due_time，应该传入合并后的
   *   due_datetime（而不是裸 due_date），见下方 resolveIdentityDueValue()。
   *   这样"相同日期、不同具体时间的两个任务视为不同任务"这条已经生效的
   *   行为（此前是因为自然语言解析器偶尔把时间折叠进 due_date 字符串
   *   本身才间接成立）继续保持不变，而不是被新 Schema 意外改变。
   */
  function generateTaskIdentity(chatId, title, dueDate, repeatRule, priority, category) {
    var parts = [
      String(chatId || ''),
      normalizeTitle(title),
      String(dueDate || ''),
      String(repeatRule || ''),
      String(priority || 'MEDIUM'),
      String(category || 'GENERAL')
    ];
    return sha256_(parts.join('|'));
  }

  /**
   * 【V4.7 新增，Due Time Support，00_Architecture_Review.gs「七、
   * Review #3」2.3 节】为 generateTaskIdentity() 的 dueDate 参数位解析
   * 出正确的传入值——有 due_datetime 用 due_datetime，否则回退 due_date。
   *
   * 存在的意义：09_IdempotencyManager.gs / 20_TaskEngine.gs /
   * 11_ProjectionRebuilder.gs（两处）共 4 个调用点都需要这个同样的
   * 合并逻辑——写成一个共用纯函数，避免 4 处各自重复同一句
   * `task.due_datetime || task.due_date || ''`（08_Review_Knowledge_Base.md
   * KB-2 Duplicated fallback constants 的形状）。
   *
   * 对于本次迁移前就存在、due_time/due_datetime 恒为空的历史任务，这个
   * 函数的返回值跟直接读 due_date 完全相同——所以全部存量任务的 identity
   * 哈希在迁移前后逐字节不变。
   *
   * 纯函数，零依赖，符合本文件 Engine Contract 里
   * "Forbidden Dependencies: Sheet, Events, Telegram/Output，任何其他
   * Engine"——不需要因为新增这个函数而修改上方的 Contract 声明。
   *
   * @param {Object} task 任意带 due_date/due_datetime 字段的对象（Task
   *   实体或等价的 meta/changes 对象）。
   * @returns {string} 用于 generateTaskIdentity() dueDate 参数位的值。
   */
  function resolveIdentityDueValue(task) {
    return ((task && task.due_datetime) || (task && task.due_date) || '');
  }

  /**
   * 库存物品 Identity
   *
   * 组合字段：chat_id | normalized_name | unit
   *
   * 注意：expiry / batch / location 不参与 identity——
   * 同名物品补货时 expiry 会变，但它们是同一个物品。
   * DeduplicationEngine 找到后走补货路径，不走新建。
   */
  function generateInventoryIdentity(chatId, itemName, unit) {
    var parts = [
      String(chatId || ''),
      normalizeTitle(itemName),
      String(unit || '')
    ];
    return sha256_(parts.join('|'));
  }

  /**
   * 提醒 Identity（为未来 ReminderEngine 幂等性预留）
   */
  function generateReminderIdentity(chatId, taskId, scheduledAt) {
    var parts = [
      String(chatId || ''),
      String(taskId || ''),
      String(scheduledAt || '')
    ];
    return sha256_(parts.join('|'));
  }

  // ============ 开发者测试 ============

  function testIdentity() {
    Logger.log('=== IdentityEngine Test ===');

    // 1. 不同说法 → 相同 identity
    var t1 = generateTaskIdentity('123', '提醒我去买菜', '2026-07-01', '', 'MEDIUM', 'SHOPPING');
    var t2 = generateTaskIdentity('123', '去买菜！', '2026-07-01', '', 'MEDIUM', 'SHOPPING');
    var t3 = generateTaskIdentity('123', '去 买 菜', '2026-07-01', '', 'MEDIUM', 'SHOPPING');
    Logger.log('normalizeTitle "提醒我去买菜" → "' + normalizeTitle('提醒我去买菜') + '"');
    Logger.log('normalizeTitle "去买菜！"    → "' + normalizeTitle('去买菜！') + '"');
    Logger.log('t1 === t2? ' + (t1 === t2) + '  (expected: true)');
    Logger.log('t2 === t3? ' + (t2 === t3) + '  (expected: true)');

    // 2. 不同 due_date → 不同 identity
    var t4 = generateTaskIdentity('123', '去买菜', '2026-07-02', '', 'MEDIUM', 'SHOPPING');
    Logger.log('t1 === t4 (diff due_date)? ' + (t1 === t4) + '  (expected: false)');

    // 3. 全角转换
    var t5 = generateTaskIdentity('123', '去ＡＢＣ买菜', '2026-07-01', '', 'MEDIUM', 'SHOPPING');
    var t6 = generateTaskIdentity('123', '去abc买菜', '2026-07-01', '', 'MEDIUM', 'SHOPPING');
    Logger.log('全角ABC === 半角abc? ' + (t5 === t6) + '  (expected: true)');

    // 4. 库存 identity
    var i1 = generateInventoryIdentity('123', '鸡蛋', 'pcs');
    var i2 = generateInventoryIdentity('123', '鸡 蛋', 'pcs');
    Logger.log('inventory i1 === i2 (whitespace)? ' + (i1 === i2) + '  (expected: true)');

    // 5.【V4.7 新增，Due Time Support】向后兼容不变量：存量任务（没有
    //    due_time）迁移前后 identity 必须逐字节不变——直接传 due_date
    //    字符串，和通过 resolveIdentityDueValue() 对一个 due_time 为空
    //    的 task 对象取值，两者必须给出完全相同的 identity。
    var legacyTask = { due_date: '2026-07-30', due_time: '', due_datetime: '' };
    var t7 = generateTaskIdentity('123', '买机票', '2026-07-30', '', 'MEDIUM', 'TRAVEL');
    var t8 = generateTaskIdentity('123', '买机票', resolveIdentityDueValue(legacyTask), '', 'MEDIUM', 'TRAVEL');
    Logger.log('t7 === t8 (legacy task, no due_time, backward-compat)? ' + (t7 === t8) + '  (expected: true)');

    // 6. 同一天、不同 due_time → 不同 identity（延续"改时间等同于改
    //    due_date"这条此前就已经生效的行为，见 generateTaskIdentity()
    //    注释）。
    var morningTask = { due_date: '2026-07-30', due_time: '10:00', due_datetime: '2026-07-30T10:00:00' };
    var afternoonTask = { due_date: '2026-07-30', due_time: '14:00', due_datetime: '2026-07-30T14:00:00' };
    var t9  = generateTaskIdentity('123', '开会', resolveIdentityDueValue(morningTask), '', 'MEDIUM', 'WORK');
    var t10 = generateTaskIdentity('123', '开会', resolveIdentityDueValue(afternoonTask), '', 'MEDIUM', 'WORK');
    Logger.log('t9 === t10 (same date, diff due_time)? ' + (t9 === t10) + '  (expected: false)');

    Logger.log('=== IdentityEngine Test DONE ===');
  }

  return {
    sha256: sha256_,
    normalizeTitle: normalizeTitle,
    normalizeWhitespace: normalizeWhitespace,
    normalizeCase: normalizeCase,
    normalizeUnicode: normalizeUnicode,
    generateTaskIdentity: generateTaskIdentity,
    resolveIdentityDueValue: resolveIdentityDueValue,
    generateInventoryIdentity: generateInventoryIdentity,
    generateReminderIdentity: generateReminderIdentity,
    testIdentity: testIdentity
  };
})();
