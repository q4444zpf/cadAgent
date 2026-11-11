# Electron + 嵌入式 Pi Agent SDK + Python CAD 子进程

桌面应用采用 Electron；Agent 层在 Node 进程中嵌入 `@earendil-works/pi-agent-core` 与 `pi-ai`；CAD 读写由 Python 子进程（ezdxf）通过本地 JSON 协议提供；界面用 Web 技术渲染。选择这种拆分是因为 Pi 属于 TypeScript 生态，而 ezdxf 是能力最完整的 DXF 库，自研 JS 写入器的风险和后续成本过高。代价是应用需同时打包 Node 与 Python 运行时，并维护一套进程间协议。

## 备选方案

- 纯 JS/TS DXF 库：单运行时、打包简单，但块、标注、填充等支持不完整。
- Tauri：包体更小，但需引入 Rust 构建链，sidecar 管理更复杂。
