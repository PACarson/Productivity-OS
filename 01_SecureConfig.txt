/**
 * 01_SecureConfig.gs
 * Personal AI Core — 敏感配置管理
 *
 * 包一层 PropertiesService，统一存取 API Key / Token 等敏感值。
 * 用法：
 *   SecureConfig.setKey('TELEGRAM_TOKEN', '123456:ABC-...');
 *   SecureConfig.setKey('TELEGRAM_CHAT_ID', '987654321');
 *   SecureConfig.setKey('RIDER_OS_SPREADSHEET_ID', '1AbC...');
 *   SecureConfig.setKey('GEMINI_API_KEY', 'AIza...');
 *
 *   var token = SecureConfig.getKey('TELEGRAM_TOKEN');
 *
 * 这些函数也可以直接在 Apps Script 编辑器里手动跑一次 setKey() 来设置，
 * 不需要每次重新部署。
 */

var SecureConfig = (function () {
  function setKey(name, value) {
    PropertiesService.getScriptProperties().setProperty(name, value);
    return { ok: true, name: name };
  }

  function getKey(name) {
    return PropertiesService.getScriptProperties().getProperty(name);
  }

  function deleteKey(name) {
    PropertiesService.getScriptProperties().deleteProperty(name);
  }

  function listKeys() {
    return PropertiesService.getScriptProperties().getKeys();
  }

  return {
    setKey: setKey,
    getKey: getKey,
    deleteKey: deleteKey,
    listKeys: listKeys
  };
})();
