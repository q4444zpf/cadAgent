# 项目工作区与文件工具设计：本地文件夹、扫描、解压与对话附件

日期：2026-11-11
状态：待评审
关联：US-18（会话关联上下文）、后续 ticket 规划（待拆分）

## 1. 问题陈述

当前应用围绕「单张图纸」工作：用户通过原生对话框打开一个 DXF/DWG，问答工具只能读取 `currentDrawing`，知识库导入是另一条独立入口。实际工程资料通常是一个文件夹——图纸、PDF/DOCX 规范、CSV 参数表和压缩包混在一起。用户希望：

1. 直接把本地文件夹打开为「项目」，不需要上传或复制任何 CAD 文件；
2. 在项目范围内扫描文件和压缩包、查看压缩包内容并解压；
3. 在对话框里选择文件作为上下文，用自然语言让 Agent 处理指定文件。

现有链路本来就不上传文件，本次把「项目根」和「对话附件」也设计成纯本地路径引用，任何文件都不会被复制到应用目录。

## 2. 已确认决策

1. 项目文件夹是**工作区根目录**：文件工具与附件选择都限制在项目内；当前图纸仍按现有方式独立打开，可位于项目内或外。
2. 压缩包首批支持 **ZIP + TAR/GZ**（`.zip`、`.tar`、`.tar.gz`、`.tgz`），使用 Python 标准库，零新增依赖；`.rar`/`.7z` 明确提示不支持。
3. 对话「选择文件」产生**上下文附件**：只传相对路径与元数据，不复制文件、不自动执行操作，由自然语言决定动作。
4. 解压默认落到**包旁新目录** `<包名>_解压/`，重名自动追加 `-2`、`-3`；任何情况下不覆盖已有文件。
5. 文件与压缩包能力**集中在 Python sidecar**：`zipfile`/`tarfile`、现有 PDF/DOCX/DXF 抽取、单一路径边界、pytest 覆盖。

## 3. 方案概述

```
用户打开项目文件夹
  → 主进程保存 projectRoot，并写入当前历史会话
  → 每次文件工具调用携带 root + 相对路径
  → Python sidecar 统一做路径归一化、越界拒绝、限额与解压

用户在对话框选择文件
  → 原生多选（起始目录 = 项目根）
  → 主进程校验每个文件位于项目根内
  → 消息只携带 {相对路径, 名称, 类型, 大小}
  → Agent 按自然语言调用 scan/list/read/extract/open 工具
```

不采用 Node 主进程实现：需要新增 zip 依赖、自行实现 zip-slip 与炸弹防护，PDF/DOCX 仍要回到 Python，安全边界与测试会分散。

## 4. 项目工作区

### 4.1 状态与入口

- 主进程持有 `projectRoot: string | null`，由「打开项目」设置。
- 入口：`dialog.showOpenDialog({ properties: ['openDirectory'] })`；只保存绝对路径，不复制文件。
- 界面展示项目名、根路径与「关闭项目」；未打开项目时，文件工具与附件按钮禁用并提示先打开项目。
- 打开项目不触发全量扫描；扫描由 Agent 工具按需调用。

### 4.2 会话持久化

- `sessions` 增加 `project_root TEXT`，`user_version` 升到 3。
- 新会话继承当前 `projectRoot`；打开历史会话时恢复其项目根。
- 恢复时会话记录中的路径仍存在且为目录 → 设为当前项目；否则当前项目为空并提示「项目路径不可用」，保留数据库中的原路径，用户可重新选择。
- 「关闭项目」清空当前项目根，并把当前会话的 `project_root` 置空。

### 4.3 协议

```ts
interface ProjectInfo {
  root: string
  name: string
}

interface ProjectOpenOutcome {
  ok: boolean
  project?: ProjectInfo
  canceled?: boolean
  error?: string
}

interface FileAttachment {
  path: string   // 相对项目根的 POSIX 路径
  name: string
  kind: 'drawing' | 'archive' | 'document' | 'text' | 'image' | 'other'
  size: number
}
```

新增 IPC：

- `project:open` → `ProjectOpenOutcome`
- `project:current` → `ProjectInfo | null`
- `project:close` → `{ ok: boolean }`
- `project:pick-files` → `{ ok: boolean; files?: FileAttachment[]; error?: string }`

## 5. sidecar 文件工具契约

所有方法沿用 JSON-lines 协议，参数中的 `root` 为绝对路径，`path`/`target` 为相对项目根的路径。sidecar 对每个路径执行 `resolve()` 后判断是否位于 `root` 内；越界、绝对路径、盘符、UNC 与符号链接逃逸一律拒绝。

### 5.1 `project_scan`

```json
{
  "root": "F:/工程/某项目",
  "path": ".",
  "extension": "dxf",
  "limit": 200
}
```

```json
{
  "path": ".",
  "entries": [
    { "name": "图纸", "path": "图纸", "type": "dir", "size": 0, "mtimeMs": 0 },
    { "name": "设计说明.pdf", "path": "设计说明.pdf", "type": "file", "extension": "pdf", "size": 12345, "mtimeMs": 0 },
    { "name": "归档.zip", "path": "归档.zip", "type": "archive", "size": 99999, "mtimeMs": 0 }
  ],
  "totals": { "files": 12, "dirs": 3, "archives": 1 },
  "byExtension": { "dxf": 8, "pdf": 3, "txt": 1 },
  "truncated": false,
  "ignored": [".git", "node_modules", ".venv", "__pycache__", ".pytest_cache"],
  "warnings": []
}
```

- 不传 `path` 时等价于 `.`：`entries` 为根目录直接子项，`totals`/`byExtension` 为递归汇总。
- 传入 `path` 时，返回该目录直接子项与该子树的汇总。
- 目录符号链接标记为 `symlink`，不跟随、不计入递归汇总。
- 深度上限 12，单次枚举上限 5000 个条目；超过则 `truncated: true` 并给出 warning。
- 忽略列表固定：`.git`、`node_modules`、`.venv`、`__pycache__`、`.pytest_cache`、`.idea`、`.vscode`。
- `extension` 过滤只影响 `entries` 与 `byExtension` 的展示，不影响压缩包统计。

### 5.2 `archive_list`

```json
{ "root": "...", "path": "资料/归档.zip" }
```

```json
{
  "path": "资料/归档.zip",
  "format": "zip",
  "entryCount": 120,
  "totalUncompressedBytes": 7340032,
  "entries": [
    { "name": "图纸/a.dxf", "size": 102400, "compressedSize": 20480, "isDir": false, "modifiedAt": 0 }
  ],
  "truncated": false
}
```

- 支持 `.zip`、`.tar`、`.tar.gz`、`.tgz`；其他扩展名返回「暂不支持该压缩格式」。
- 单次最多返回 500 个成员；成员总数最多统计 10000 个，超过标记 truncated。
- 不解压、不执行成员内容。

### 5.3 `archive_extract`

```json
{ "root": "...", "path": "资料/归档.zip", "target": "资料/解压结果" }
```

`target` 可省略。省略时默认 `<包名>_解压`，例如 `归档.zip` → `归档_解压`，`资料.tar.gz` → `资料_解压`；目标已存在时自动尝试 `-2`、`-3`，最多 50 次。

```json
{
  "path": "资料/归档.zip",
  "target": "资料/解压结果",
  "filesExtracted": 118,
  "directoriesCreated": 4,
  "bytesExtracted": 7340032
}
```

预检（任一失败则整包拒绝，不产生任何文件）：

- 目标必须位于项目根内，且不存在（显式 `target` 已存在则报错，不自动改名）。
- 成员数 ≤ 10000；解压总量 ≤ 2 GiB；单次压缩包文件大小 > 0 且解压比 > 200 且总量 > 100 MiB 时判定为压缩炸弹。
- 成员名归一化后不得为绝对路径、不得含 `..`、不得带盘符或 UNC 前缀、不得逃出目标目录。
- 拒绝符号链接与硬链接成员；拒绝加密成员（ZIP 密码保护）。
- 拒绝不支持的压缩算法。

执行：

- 解压到目标目录旁的临时目录（`.extract-<uuid>`），全部成功后重命名为目标；失败清理临时目录。
- 不写入任何目标目录之外的位置，不修改原压缩包。

### 5.4 `read_file`

```json
{ "root": "...", "path": "设计说明.pdf", "maxChars": 20000 }
```

```json
{
  "path": "设计说明.pdf",
  "kind": "pdf",
  "size": 456789,
  "truncated": true,
  "encoding": null,
  "content": "第 1 页\n...",
  "pages": 12
}
```

- **文本**（`.txt .md .csv .json .yaml .yml .xml .log .ini .cfg .sql`）：UTF-8（含 BOM）优先，失败回退 GB18030；返回 `encoding` 与截断标记；单文件上限 20 MB。
- **PDF**：复用 `pypdf`，逐页抽取并带「第 N 页」标记；最多 50 页、`maxChars` 截断。
- **DOCX**：复用 `python-docx`，按段落抽取，最多 500 段。
- **DXF**：返回 `parse_dxf(..., summary=True)` 的摘要（图层、实体统计、文字样例），完整分析由 `open_project_drawing` + 现有读图工具完成。
- **图片**：只返回名称、大小等元数据，不做 OCR。
- **拒绝**：`.env`、`.env.*`、`*.pem`、`*.key`、`*.pfx`、`*.p12`、`*.keystore`、`*.jks`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.pypirc`、`.git-credentials`、`credentials*`、`secrets*`，以及 `.git` 目录内文件；返回 `denied` 错误。
- 不支持的类型返回 `unsupported` 与支持列表。

## 6. Agent 工具

新增 `src/node/agent/project-tools.ts`，由项目根与 sidecar 注入：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `scan_project` | `path?`, `extension?`, `limit?` | 调用 `project_scan`，工具层再把 entries 截到 50 条展示 |
| `list_archive` | `path` | 调用 `archive_list` |
| `extract_archive` | `path`, `target?` | 调用 `archive_extract`，返回目标相对路径与文件数 |
| `read_file` | `path`, `maxChars?` | 调用 `read_file` |
| `open_project_drawing` | `path` | 调用主进程注入的 `loadDrawing`（含 DWG 转换），把项目内图纸切换为当前图纸，返回摘要 |

- `open_project_drawing` 只在用户表达「打开/查看/分析这个图纸」时调用，不自动执行。
- 工具参数中的路径必须是相对路径；绝对路径直接失败。
- 工具输出统一截断，避免把整棵目录树或大段文本塞进上下文。
- 系统提示新增规则：项目内文件操作先读后答；未调用工具不得声称看过文件；解压永不覆盖，目标冲突时向用户要新名称；`.rar`/`.7z` 说明暂不支持。

## 7. 对话附件

### 7.1 选择与发送

- 输入框左侧「选择文件」按钮；未打开项目时禁用。
- 原生多选，`defaultPath = projectRoot`。
- 主进程逐个校验：存在、是普通文件、`resolve()` 后位于项目根内；任一不满足则整批拒绝并列出违规路径。
- 附件以文件片展示，可移除；发送时 `AgentAsk.attachments` 携带 `FileAttachment[]`（最多 10 个）。
- 主进程在运行前再次校验文件仍在，防止选择后被删除。
- 不读取内容、不复制文件；模型只看到相对路径、名称、类型、大小，需要时自行调用工具。

### 7.2 协议与持久化

```ts
const AgentAskSchema = z.object({
  requestId: z.string().min(1),
  prompt: z.string().trim().min(1).max(4000),
  attachments: z.array(FileAttachmentSchema).max(10).optional()
})

interface HistoryMessage {
  // 既有字段
  attachments?: FileAttachment[]
}
```

- `messages` 增加 `attachments_json TEXT`，`user_version` 升到 3 的同一次迁移完成。
- 历史恢复时渲染文件片；文件不存在时标灰，悬浮提示「文件已不存在」。
- 提示词注入格式：

```
用户附加的文件（相对项目根）：
- 图纸/a.dxf（图纸，2.4 MB）
- 资料/归档.zip（压缩包，12.1 MB）
需要内容时请调用工具读取，不要臆测文件内容。
```

## 8. 安全与错误处理

| 场景 | 行为 |
| --- | --- |
| 未打开项目 | 文件工具失败「请先打开项目文件夹」；附件按钮禁用 |
| 路径越界 / 绝对路径 / 盘符 | 拒绝，返回明确原因，不执行任何操作 |
| 项目内符号链接指向项目外 | `resolve()` 后判定越界并拒绝；扫描不跟随目录符号链接 |
| 压缩包成员越界或为链接 | 整包预检失败，不产生任何文件，列出首个问题成员 |
| 目标目录已存在 | 显式 target 报错；默认 target 自动加序号（≤50 次） |
| 压缩炸弹 / 条目超限 | 拒绝并说明限额 |
| 加密/损坏/算法不支持 | 结构化错误；密码压缩包提示先手动解压 |
| 读取敏感文件 | 拒绝，不返回内容 |
| 文本文件过大 | 拒绝或按上限截断并标记 |
| 附件在发送前被删除 | 整次请求失败，提示重新选择 |
| sidecar 崩溃 | 工具失败；不影响已打开图纸与会话，可重试 |

日志 scope 新增 `project`，只记录根路径、相对路径、计数、耗时与错误，不记录文件内容或附件内容。调用 `read_file` 会把文件片段发送给所配置的云端模型，此项在交付说明中列为隐私限制。

## 9. 数据流

**扫描与解压**

```
用户："项目里有哪些 DXF？把 归档.zip 解压到 资料/"
  → Agent 调用 scan_project({extension:"dxf"})
  → sidecar 递归汇总，返回统计与截断后的条目
  → Agent 调用 extract_archive({path:"归档.zip", target:"资料/解压结果"})
  → sidecar 预检（越界/链接/配额/目标）→ 临时目录 → 重命名
  → 工具返回相对目标与文件数 → Agent 汇总回答
```

**附件问答**

```
用户选择 图纸/a.dxf 与 设计说明.pdf，输入："对比说明里的净宽和图纸实际尺寸"
  → 主进程校验附件位于项目根内
  → 消息携带附件元数据写入历史
  → Agent 调用 open_project_drawing("图纸/a.dxf") 切换当前图纸
  → 调用 read_file("设计说明.pdf") 抽取文本
  → 用 drawing_summary/search_entities 与文本内容对照回答
```

## 10. 测试决策

- **Python（pytest）**
  - `project_scan`：递归汇总、扩展名过滤、条目截断、忽略目录、目录符号链接不跟随、越界路径拒绝。
  - `archive_list`：ZIP/TAR/TGZ 成员、目录标记、截断、`.rar` 明确不支持。
  - `archive_extract`：成功解压并保持相对结构；`../evil`、绝对路径、盘符、符号链接成员、硬链接成员、加密成员、条目超限、解压比超限、显式目标已存在均整包拒绝且无残留；临时目录清理；默认命名与 `-2` 序号。
  - `read_file`：UTF-8/GB18030、截断、PDF 页标记、DOCX 段落、DXF 摘要、敏感文件名拒绝、超大文件拒绝。
  - 夹具：测试内用 `zipfile`/`tarfile` 在 `tmp_path` 生成压缩包，不引入二进制样包。
- **vitest 单测**
  - 数据库迁移：`user_version=3`、`project_root` 与 `attachments_json` 读写、旧库升级。
  - 附件校验：项目外文件、目录、已删除文件、超过 10 个。
  - 工具层：参数映射、绝对路径拒绝、错误转换为 `failure`、输出截断。
- **契约测试**：真实 sidecar 完成 scan → list → extract → read 往返；断言解压结果与 zip 内容一致、项目外文件未变化。
- **UI smoke**：`SMOKE_PROJECT_ROOT` 指定项目目录、`--attach` 注入附件；假模型脚本调用 scan/extract/read；断言界面出现工具调用、解压结果、历史恢复后项目名与文件片仍在。
- **人工验收**：真实工程文件夹中自然语言扫描、查看压缩包、解压；用资源管理器核对落点，确认项目外无任何改动。

## 11. 明确不做

- 不做文件上传、复制或云端同步；附件只是路径引用。
- 不做项目文件树编辑器，不支持删除、移动、重命名、覆盖项目文件。
- 不支持 RAR/7z、加密压缩包、分卷压缩。
- 不做图片 OCR（沿用知识库导入时的视觉识别链路，不在本入口重复）。
- 不做多项目并行；一个会话一个项目根。
- 不把目录扫描结果整棵返回；始终受条目与深度上限约束。

## 12. 与现有设计与票据的关系

- 本设计新增「项目工作区」概念，不改变 US-1～US-11 的读图与知识库链路；`open_project_drawing` 复用现有 `loadDrawing` 与 DWG 转换。
- 与 `docs/specs/2026-11-11-generate-validate-design.md` 无直接依赖；后续生成图默认保存位置仍由生成链路决定，本项目根不对其施加写权限。
- 实现计划按垂直切片拆分：项目工作区与迁移 → sidecar 文件/压缩包工具 → Agent 工具与附件协议 → 对话附件界面 → smoke 与文档。
