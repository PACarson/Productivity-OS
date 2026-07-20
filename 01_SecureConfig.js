/**
 * 01_SecureConfig.gs
 * Personal AI Core — 敏感配置管理
 *
 * 【V4.5 修复 MEDIUM RISK 1：PropertiesService 高频调用导致的 API 限额与
 * 延迟风险】外部审计发现 05_SheetUtils.gs 的 getSheet_ 和
 * 02_EventBus.gs 的 _spreadsheet_ 每次都会调 SecureConfig.getKey
 * ('SPREADSHEET_ID')，而单次 Webhook 请求（比如一次 createTask）内部
 * 可能触发好几次 getSheet_ 调用（DeduplicationEngine 读一次 Tasks、
 * ProjectionEngine.dispatch 读写 Tasks/ActiveTasks/TaskStatistics/
 * TaskFilters 好几次……）。PropertiesService.getScriptProperties() 每分钟
 * 读取次数有限额，且这个 I/O 本身不便宜，反复读会拖慢单次请求、增加撞到
 * 限额的概率。
 *
 * 修复：getKey() 增加一个"本次脚本执行期内"的内存缓存——SPREADSHEET_ID
 * 这类配置值在一次执行的生命周期内不会变化（真的要改配置，是在另一次
 * 独立的执行里手动跑 setKey()，不会跟当前正在跑的读取请求同时发生），
 * 缓存在这个前提下是安全的。跟 02_EventBus.gs 的 _cachedEvents 是同一种
 * "执行期内存缓存，不跨执行持久化"模式，不是引入了一个新的、可能过期的
 * 持久层。setKey()/deleteKey() 同步维护缓存，保证同一次执行内如果先
 * set 后 get 依然拿到最新值（虽然实际使用场景里这种"同一执行内又设置又
 * 读取同一个 key"的情况很少见，但保证正确性不留死角）。
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
  var _cache = {}; // V4.5新增：执行期内存缓存，key 存在于此对象即代表"本次执行已读过"

  function setKey(name, value) {
    PropertiesService.getScriptProperties().setProperty(name, value);
    _cache[name] = value; // 同步更新缓存，保证同一次执行内先set后get能拿到最新值
    return { ok: true, name: name };
  }

  function getKey(name) {
    if (_cache.hasOwnProperty(name)) {
      return _cache[name];
    }
    var value = PropertiesService.getScriptProperties().getProperty(name);
    _cache[name] = value;
    return value;
  }

  function deleteKey(name) {
    PropertiesService.getScriptProperties().deleteProperty(name);
    delete _cache[name];
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
