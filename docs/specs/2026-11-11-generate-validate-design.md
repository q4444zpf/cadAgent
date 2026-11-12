# 生成与校验链路设计：语义化 CAD 工具集 + generate_dxf / validate_dxf

日期：2026-11-11
状态：待评审
关联：ADR-0003、US-12～US-16、ticket 010/011/012

## 1. 问题陈述

当前应用只能读图：主 Agent 可以解析、检索、问答与高亮，`DesignAgent` 只能产出参数清单，`DesignSessionStore.confirm` 只保存确认值，sidecar 没有任何写图能力。协议里虽已有 `ValidationReport` 与 `GenerationRecordView`，但没有产生它们的数据来源。

需要补齐「确认参数 → 生成图纸 → 回读校验 → 保存文件 → 写入生成记录」的完整链路，同时遵守两条既有约束：

- ADR-0003：模型通过语义化 CAD 工具操作图纸，不直接产出 DXF 实体 JSON 或 ezdxf 脚本。
- US-13/US-14：参数确认前不得生成文件；只另存新文件，不修改任何原始图纸。

ticket 010 尚未完成真实样图与首批图型确认，因此本次只设计**与图型无关的通用契约与最小可用路径**，不预置任何具体工程图型模板或领域规则包。

## 2. 方案概述

一条写图链路分四层：

1. **Python sidecar 写图会话**：在内存中持有一个 ezdxf 文档（`docId`），提供语义化几何操作；`generate_dxf` 负责落盘，`validate_dxf` 从磁盘回读并执行规则校验。
2. **Node Agent 工具层**：新增 `GenerationAgent`，把 sidecar 操作包装成模型可见的工具；模型按已确认参数逐步绘图，保存并读取校验问题后自行修正。
3. **主进程编排层**：负责参数确认门禁、输出路径分配、重试上限与超时、把结果写入历史生成记录。
4. **界面**：确认后提供「生成图纸」入口，展示生成状态、校验问题、保存路径与独立预览。

被否决的替代方案：

- 一次性 `generate_dxf(path, operations[])`：由 Node 生成操作数组。协议更简单，但模型无法根据中间结果修正，违背 ADR-0003 的可定位重试。
- `generate_dxf(path, drawingType, parameters)` 模板注册表：最省事，但首批图型未定，且与已选的语义工具方向冲突。

## 3. 接口契约

### 3.1 sidecar 方法

所有方法沿用现有 JSON-lines 协议：`{id, method, params}` → `{id, ok, result|error}`。写图会话在 sidecar 进程内只允许一个活动文档，创建新文档会丢弃未保存的旧文档。

| 方法 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `create_dxf` | `layers?`（`{name,color?,linetype?}[]`）, `units?`（默认 `mm`） | `{docId, layers[]}` | 新建 R2018 文档，`setup=True`；自动包含图层 `0` |
| `add_layer` | `docId`, `name`, `color?`（ACI 1–255）, `linetype?` | `{layer, created}` | 已存在则返回 `created:false`，参数冲突报错 |
| `draw_line` | `docId`, `layer`, `start:[x,y]`, `end:[x,y]`, `color?` | `{handle}` | 坐标单位 mm |
| `draw_polyline` | `docId`, `layer`, `points:[[x,y],...]`, `closed?`, `color?` | `{handle, pointCount}` | 至少 2 点；闭合用 LWPOLYLINE `closed` 标志 |
| `draw_circle` | `docId`, `layer`, `center:[x,y]`, `radius`, `color?` | `{handle}` | `radius > 0` |
| `draw_arc` | `docId`, `layer`, `center:[x,y]`, `radius`, `startAngle`, `endAngle`, `color?` | `{handle}` | 角度为度，0° 为 +X 方向 |
| `add_text` | `docId`, `layer`, `insert:[x,y]`, `text`, `height?`, `rotation?`, `color?` | `{handle}` | `height` 默认 2.5 |
| `add_linear_dimension` | `docId`, `layer`, `p1:[x,y]`, `p2:[x,y]`, `base:[x,y]`, `angle?`（0 水平 / 90 垂直）, `precision?` | `{handle}` | 内部使用默认标注样式并 `.render()` |
| `drawing_info` | `docId` | `{entityCount, layers:[{name,entityCount}], bounds}` | 供模型保存前自检 |
| `generate_dxf` | `docId`, `path`, `overwrite?`（默认 `false`） | `{path, entityCount, layerCount, bytes}` | 空模型空间拒绝保存；目标已存在且未允许覆盖时报错 |
| `validate_dxf` | `path`, `rules?` | `{ok, issues:string[]}` | 从磁盘回读，不复用内存文档 |
| `discard_dxf` | `docId` | `{discarded:true}` | 丢弃内存文档，不产生文件 |

输入约束：

- 所有坐标、半径、角度、字高必须为有限数；半径与字高必须为正。
- 图层名非空、≤255 字符，且不含 `< > / \ " : ; ? * | =`。
- `docId` 不匹配时返回 `未知的图纸会话`，避免模型跨会话误操作。
- `generate_dxf` 只接受 `.dxf` 扩展名，拒绝 `.dwg`。

### 3.2 校验规则

`validate_dxf` 默认执行通用结构规则，调用方可追加领域无关的显式规则：

```json
{
  "requiredLayers": ["OUTLINE"],
  "requiredClosedLayers": ["OUTLINE"],
  "requireDimensions": true,
  "allowedTypes": ["LINE", "LWPOLYLINE", "CIRCLE", "ARC", "TEXT", "MTEXT", "DIMENSION"],
  "minEntities": 1
}
```

| 规则码 | 触发条件 | issue 示例 |
| --- | --- | --- |
| `read_failed` | ezdxf 无法回读 | `read_failed: 无法解析生成文件：...` |
| `empty_drawing` | 模型空间实体数 < `minEntities` | `empty_drawing: 图纸中没有可用的图元` |
| `unsupported_entity` | 实体类型不在 `allowedTypes` | `unsupported_entity: 实体 SPLINE（句柄 1A2，图层 OUTLINE）不受支持` |
| `missing_layer` | 实体引用的图层不在图层表中 | `missing_layer: 图层 OUTLINE 不存在（句柄 2B3）` |
| `missing_required_layer` | `requiredLayers` 中的图层缺失 | `missing_required_layer: 缺少必需图层 OUTLINE` |
| `empty_required_layer` | 必需图层存在但无实体 | `empty_required_layer: 必需图层 OUTLINE 没有实体` |
| `unclosed_polyline` | `requiredClosedLayers` 中图层上的多段线未闭合 | `unclosed_polyline: 图层 OUTLINE 的多段线未闭合（句柄 3C4）` |
| `missing_dimension` | `requireDimensions: true` 且无尺寸标注 | `missing_dimension: 缺少尺寸标注` |
| `invalid_geometry` | 坐标非有限、半径/字高非正 | `invalid_geometry: 圆半径必须为正（句柄 4D5）` |

`ValidationReport` 沿用现有 `{ok, issues: string[]}` 契约，issues 以规则码前缀保证可定位、可反馈给模型；暂不升级为结构化对象，避免改动历史视图。

### 3.3 Node 与 IPC 契约

`SidecarClient` 新增方法：`createDxf`、`addLayer`、`drawLine`、`drawPolyline`、`drawCircle`、`drawArc`、`addText`、`addLinearDimension`、`drawingInfo`、`generateDxf`、`validateDxf`、`discardDxf`。写操作超时 15 秒，保存 60 秒，校验 120 秒。

新增 IPC：

```ts
// 请求
interface GenerationRequest { listId: string }

// 结果
interface GenerationOutcome {
  ok: boolean
  record?: GenerationRecordView
  preview?: Drawing          // 生成文件回读解析结果
  exhausted?: boolean        // 重试上限耗尽
  error?: string
}

// 状态事件（主进程广播）
interface GenerationStatusEvent {
  listId: string
  state: 'preparing' | 'drawing' | 'saving' | 'validating' | 'retrying' | 'done' | 'failed'
  attempt: number
  message?: string
}
```

`design:generate` 只接受处于 `confirmed` 状态的 `listId`；同一时间只允许一个生成任务。

## 4. 数据流

```
用户在参数确认界面点击「生成图纸」
  → IPC design:generate {listId}
  → 主进程校验会话已确认
  → 分配输出路径 userData/generated/<时间戳>-<标题>.dxf（首次必定不存在）
  → GenerationAgent 启动（180 秒超时）
      create_drawing（内部 create_dxf）
      add_layer / draw_* / add_text / add_dimension
      inspect_drawing（可选自检）
      save_drawing（内部 generate_dxf，路径由主进程注入）
      validate_drawing（内部 validate_dxf）
         ├─ 通过 → 结束
         └─ 未通过 → 问题清单作为工具结果返回模型 → 修改后重存（最多 2 次重试）
  → 主进程回读生成文件 parseDrawing 作为 preview
  → historyStore.addGeneration（只要文件已落盘就记录，含失败校验）
  → 返回 GenerationOutcome，界面展示校验结果、路径与预览
```

文件生命周期：

- 首次保存创建新文件；只有同一生成会话的重试允许覆盖该文件。
- 重试耗尽仍失败：保留文件与校验报告，界面明确提示未通过。
- 模型超时或中止且尚未落盘：`discard_dxf` 丢弃内存文档，不产生文件、不写记录。
- 模型超时或中止但文件已落盘、校验未完成：记录一条 `validation:{ok:false, issues:["校验未完成：生成被中止"]}`，保留文件。

## 5. Agent 工具与门禁

新增 `GenerationAgent`（`src/node/design/generation-agent.ts`），系统提示要求：

1. 只使用提供的绘图工具，按已确认参数绘制，不臆造关键尺寸。
2. 先建图层与主体轮廓，再补文字与尺寸标注。
3. 保存后必须调用校验工具；有 issue 时按问题逐条修正。
4. 全部完成或重试耗尽后用简洁中文说明生成结果与假设。

模型可见工具：`create_drawing`、`add_layer`、`draw_line`、`draw_polyline`、`draw_circle`、`draw_arc`、`add_text`、`add_dimension`、`inspect_drawing`、`save_drawing`、`validate_drawing`。

关键门禁：

- `save_drawing` / `validate_drawing` **不接受路径参数**；目标路径与 `docId` 由主进程在工具闭包中注入，模型无法把文件写到任意位置。
- 未创建文档就调用绘图工具 → 工具返回失败「请先创建图纸」。
- 未保存就校验 → 返回失败「请先保存图纸」。
- 第 3 次保存后校验仍失败 → 工具返回 `exhausted`，主进程中止 Agent 并标记重试耗尽。
- 生成过程不复用 `DesignAgent`；两者提示词与状态机不同，避免参数整理阶段获得写图能力。

## 6. 保存、记录与预览

- 输出目录：`app.getPath('userData')/generated`；smoke 通过 `SMOKE_GENERATED_DIR` 覆盖。
- 文件名：`YYYYMMDD-HHmmss-<标题>.dxf`，标题去除 `\ / : * ? " < > |` 并截断到 40 字符；同名时追加序号。
- 生成文件固定为 R2018（AC1032）、单位 mm。
- 路径安全检查：目标必须位于输出目录内；不得等于当前图纸路径；首次分配的文件必须不存在。
- 记录：`historyStore.addGeneration(currentSessionId, {parameters: 确认后的参数数组, validation, filePath})`。
- 预览：主进程用 `sidecar.parseDrawing` 回读生成文件，返回完整 `Drawing`；渲染层在生成结果面板中弹出独立预览（复用 `DrawingCanvas`），提供「设为当前图纸」与「在文件夹中显示」，不自动替换当前读图状态。
- 生成记录沿用已有历史视图；失败记录显示 `校验未通过（N）` 与问题清单。

## 7. 错误处理

| 场景 | 行为 |
| --- | --- |
| 参数会话不存在/未确认/已取消 | 直接返回错误，不启动 Agent |
| 生成任务已在进行 | 返回「已有生成任务进行中」 |
| 路径分配失败 | 返回错误并写日志，不启动 Agent |
| 单个绘图工具参数非法 | 工具返回失败原因，模型可修正后重试 |
| `generate_dxf` 目标已存在（非重试） | 报错，不覆盖 |
| 校验未通过 | 问题清单返回模型；达到上限后保留文件与报告 |
| sidecar 崩溃 | 生成失败；内存文档丢失；若文件已落盘则保留并记录“校验未完成” |
| 模型超时/中止 | 中止 Agent，丢弃未落盘文档；已落盘文件保留并记录 |
| 生成文件无法回读预览 | 记录仍保留；`preview` 省略并在结果中说明预览失败 |

所有失败写本地日志，scope 新增 `generate`，记录耗时、保存次数、校验通过情况与文件路径（不含任何密钥）。

## 8. 测试决策

沿用规格说明既定接缝，不把测试绑在提示词细节上。

- **sidecar 写图（pytest）**：每个操作的有效/无效输入；`generate_dxf` 成功落盘、空图拒绝、已存在拒绝、覆盖允许；`discard_dxf` 不产生文件；生成文件可被 `parse_dxf` 回读且图层/实体一致。
- **校验规则（pytest）**：上表每条规则至少一个通过样例与一个拦截样例，断言规则码与句柄/图层定位信息。
- **Node ↔ sidecar 契约（vitest contract）**：真实 sidecar 完成 `create → draw → generate → validate → parse` 往返；错误分支（未知 docId、非法图层名、目标已存在）。
- **GenerationAgent（vitest 单测）**：假模型脚本驱动完整工具序列；断言路径不可由模型指定、未确认会话被拒绝、绘图前未建文档失败、重试上限中止。
- **主进程编排（vitest 单测）**：路径分配与唯一性、记录写入（成功/失败/中止）、不覆盖已有文件、不修改当前图纸。
- **UI smoke**：确认参数 → 生成 → 校验通过 → 记录与预览出现；以及注入失败图元 → 问题清单 → 重试耗尽 → 保留文件路径。
- **人工验收**：生成 DXF 可被 CAD 软件打开，预览与文件内容一致。

## 9. 明确不做

- 不做图型模板、领域图层规范与领域校验规则包（依赖 ticket 010）。
- 不支持 DWG 输出，不支持修改原始图纸。
- 不支持多文档并行写入、撤销/重做、块/填充/样条等高级实体。
- 不让模型选择或看到文件系统路径。
- 不做另存为对话框与用户自选目录（后续可在路径分配层扩展）。
- 不把 `ValidationReport` 升级为结构化对象，不调整历史视图契约。

## 10. 与现有 ticket 的关系

本设计落地后：

- ticket 011 的「语义化工具集 + 保存 + 预览」获得通用实现，但首批图型相关的图层/线型规范仍需 010 补充规则包后才算完整。
- ticket 012 的校验引擎、问题回传与重试上限获得通用实现；「标注完整性」「关键几何闭合性」等图型相关判定，通过 `rules` 参数由 010 产出的规则集启用。
- 010 完成前，smoke 与测试使用中性的示意构件（矩形沟槽断面等）作为夹具，不作为产品图型承诺。
