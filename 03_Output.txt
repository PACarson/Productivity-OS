/**
 * 03_Output.gs
 * Personal AI Core — 唯一的 Telegram 发送出口
 *
 * 架构铁律（00_Project_Constitution.gs P5）：
 *   任何模块要给用户发消息，必须经过这里，不允许自己调 Telegram API。
 *
 * 【V4.5 核实 LOW RISK 2：UrlFetchApp 同步请求带来的额度与超时风险】
 * 外部审计指出 sendMessage 用 UrlFetchApp.fetch 同步阻塞调用 Telegram
 * API，量大时有额度耗尽/拖慢响应的风险。核实了一下本项目实际的调用面：
 * 00_File_Map.gs 之前写的"本项目目前不直接调用"不准确——
 * 02_EventBus.gs 的 _alertAdminProjectionFailure_() 确实会在 Projection
 * 写入失败时调用 Output.sendMessage() 给管理员发告警（已更新
 * 00_File_Map.gs 的描述）。但这是本项目唯一的调用点，且只在"Projection
 * 失败"这种本身就应该很罕见的异常路径上触发——不是常规请求路径上会被
 * 频繁调用的函数。
 *
 * 因此没有做审计建议的批处理/队列/异步化改造（那对一个"预期几乎不会被
 * 触发"的告警函数而言是不成比例的工程投入）。已经具备的防护（本函数
 * 一直都有，非本次新增）：muteHttpExceptions:true 避免 Telegram 返回
 * 非 2xx 时抛异常、外层 try/catch 兜底、4096 字符截断。GAS 的
 * UrlFetchApp 本身不支持自定义超时参数，如果 Telegram API 响应变慢，
 * 这次调用确实会同步等待，但发生概率被"只在 Projection 失败时触发"这个
 * 前提大大降低了。如果未来这个函数的调用面扩大（比如被复用去做批量/
 * 高频推送），需要重新评估是否要引入异步化或频控——那时候审计建议的
 * 方向是对的，只是现在还不到需要付出这个复杂度的时候。
 */

var Output = (function () {
  function _token_() {
    return SecureConfig.getKey('TELEGRAM_TOKEN');
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {object} keyboard  可选，Telegram inline_keyboard 结构
   *                  例: { inline_keyboard: [[{text:'Done',callback_data:'x'}]] }
   */
  function sendMessage(chatId, text, keyboard) {
    var token = _token_();
    if (!token) {
      Logger.log('[Output] 缺少 TELEGRAM_TOKEN，发不出去: ' + text);
      return { ok: false, error: 'missing_token' };
    }
    if (!chatId) {
      Logger.log('[Output] 缺少 chatId，发不出去: ' + text);
      return { ok: false, error: 'missing_chat_id' };
    }

    // 🐛 bugfix：Telegram单条消息上限4096字符，超过会直接被API拒绝。
    // 任务列表长了之后很容易超，这里做截断保护。
    var TELEGRAM_MAX_LEN = 4096;
    if (text && text.length > TELEGRAM_MAX_LEN) {
      text = text.substring(0, TELEGRAM_MAX_LEN - 20) + '\n...(已截断)';
    }

    var payload = { chat_id: chatId, text: text };
    if (keyboard) payload.reply_markup = JSON.stringify(keyboard);

    var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
    Logger.log('[Output] 准备发送 → chatId=' + chatId + ', text长度=' + (text ? text.length : 0));

    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var body = JSON.parse(res.getContentText());
      if (!body.ok) {
        Logger.log('[Output] ❌ Telegram返回失败: ' + res.getContentText());
      } else {
        Logger.log('[Output] ✅ 发送成功 message_id=' + (body.result && body.result.message_id));
      }
      return body;
    } catch (e) {
      Logger.log('[Output] ❌ sendMessage 出错: ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  return { sendMessage: sendMessage };
})();
