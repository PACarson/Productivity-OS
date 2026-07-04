# Productivity OS

2026-07-03 从 Personal AI Core 拆出来的独立项目，专管 Task 全生命周期。
按 D3 Domain OS Blueprint（Foundation / Runtime / Intelligence）+ P6.2
Level 2 Domain OS Standard 组织，规则定义都在 Personal AI Core 项目的
`00_Project_Constitution.gs`，这里只放这个 OS 自己的东西。

## 这个项目不直接接 Telegram

它是被 Personal AI Core 当 **Apps Script Library** 调用的，本身不需要
Deploy as Web App，也不需要 registerWebhook()。

## 部署步骤（在 Personal AI Core 之前部署这个）

### 1. 新建 Apps Script 项目，把本 zip 里全部 `.gs` 文件粘贴进去

### 2. 设置 Script Properties
- `SPREADSHEET_ID` —— 跟 Personal AI Core 项目【同一张】Google Sheet 的
  ID（去那张表的 URL 里复制，`https://docs.google.com/spreadsheets/d/`
  和 `/edit` 之间那一段）。**这是最关键的一步，填错/漏填会导致所有 Sheet
  操作报错。**

### 3. 跑一次 `setupSheets()`
建 Tasks / ActiveTasks / ArchiveTasks 三张表。如果是从旧的单体版本迁移
（这张 Spreadsheet 已经有这三张表了），这个函数是幂等的，会跳过已存在的
表，不会破坏数据——放心跑。

### 4. （仅旧数据迁移需要）跑 `migrateAddIdentityColumns()`

### 5. Deploy → New deployment → **Library**（不是 Web app）
拿到 Script ID（左侧齿轮 → 项目设置）。

### 6. 回 Personal AI Core 项目，把这个 Script ID 加成 Library，
Identifier 填 `ProductivityOS`（大小写完全一致，见 Core 项目 README）。

### 7. 跑一次 `createTriggers()`
挂上 `triggerDailyArchive`（每天凌晨2点冷归档）。

### 8. （仅首次上线/迁移用）`rebuildAllProjections()`
从共享 Events 表里的历史事件重建 Tasks/ActiveTasks。

### 9. 验证
去 Personal AI Core 项目的编辑器，手动跑：
```js
ProductivityOS.handleTaskIntent('测试一下', 'test_chat_id')
```
应该返回 `{ matched: true, ... }`，没报错就说明 Library 接对了。

## 文件清单

| 文件 | 说明 |
|---|---|
| `06_TaskIntentParser.gs` | 意图识别 + 处理，逐字未改 |
| `20_ProductivityModule.gs` | createTask/completeTask/cancelTask 等，逐字未改 |
| `13_ActiveTasksEngine.gs` | 每日冷归档，逐字未改 |
| `09_IdempotencyManager.gs` | 只保留 Task 部分（原文件还有 Inventory/Reminder，留在 Core） |
| `10_ProjectionEngine.gs` | 只保留 Task/Reminder 的 projector |
| `12_QueryEngine.gs` | 只保留 Task 查询（getPendingTasks/getCompletedTasks/getTaskById） |
| `11_ProjectionRebuilder.gs` | 完整保留（含 Inventory 部分，未使用但无害） |
| `01/07/08/09_TemporalParser` | Shared Services / IMIOR 支柱的本地副本，逐字未改 |
| `02_EventBus.gs` / `05_SheetUtils.gs` | 本地副本，`_sheet_`/`getSheet_` 改用 `openById`（standalone 脚本没有 active spreadsheet） |
| `15_Setup.gs` | 新文件：本项目自己的建表 + 触发器 |

## 为什么本地重新维护一份 EventBus/IdentityEngine 等文件，而不是共用 Core 的

Apps Script 项目之间没有"直接共享内存里的模块"这种机制——GAS Library
是单向的（这个项目可以被 Core 调用，但这个项目不能反过来调用 Core，
否则会变成循环依赖，Apps Script 不允许）。所以 Task 创建时真正需要的
Identity 生成/去重/EventBus 写入，都在本项目内部本地跑完，不需要打一次
网络请求回 Core。跟 Core 之间**唯一**的耦合就是"Core 把 Productivity OS
当 Library 调用"这一个方向。

细节和取舍见 Personal AI Core 项目 `00_Project_Constitution.gs` 的 D2-D6，
以及那个项目 README 里"这次拆分改了哪些原有文件"一节。
