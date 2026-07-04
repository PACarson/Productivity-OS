/**
 * 03_Output.gs
 * Personal AI Core — 唯一的 Telegram 发送出口
 *
 * 架构铁律（00_Project_Constitution.gs P5）：
 *   任何模块要给用户发消息，必须经过这里，不允许自己调 Telegram API。
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
