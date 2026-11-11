# 知识库子 Agent 与出处回答

**Blocked by**: 004, 006

## 目标
主 Agent 通过 `ask_knowledge` 工具调用独立的知识库子 Agent；子 Agent 使用检索工具完成规范问答，返回带出处的结论，主 Agent 在回答中展示出处。

## 涉及层
- [x] 数据层：子 Agent 调用协议、出处结构（文件、页码/句柄、片段）
- [x] 逻辑层：子 Agent 循环、检索工具、上下文隔离、失败降级
- [x] UI层：出处展示与来源查看
- [x] 测试：假模型下的调度测试、出处必填校验、无命中分支

## 验收标准
- 涉及规范/图集的问题由子 Agent 处理，回答必须带出处
- 无检索命中时明确说明依据不足，而不是编造结论
- 子 Agent 超时或失败时主流程可继续并提示用户
- 出处在界面可展开查看原文片段

## 实现备注
- `KbAgent`（`src/node/agent/kb-agent.ts`）独立 Agent 循环，唯一工具 `search_knowledge`（limit 1–10，默认 5），45s 超时；返回 `{answer, sources, error?}`，sources 去重。
- `ModelRuntime.resolveModel(lane)` 按 lane 隔离 faux provider，主 Agent 与 KB 子 Agent 各自排队，互不抢脚本。
- 主 Agent 通过 `ask_knowledge`（`knowledge-tools.ts`）调用，子 Agent 失败以 `isError` 工具结果返回，主流程继续；收集到的 sources 只在 `run_end` 携带。
- 假模型 KB 脚本：先 `search_knowledge`，再按工具结果生成带出处结论；空命中 → “依据不足”，检索失败 → “无法给出带出处的结论”。
- UI：`ChatPanel` 在引用芯片下方渲染「出处（N）」，`<details>` 可展开查看原文片段，位置由 `formatKbLocation` 统一格式化（页/段/句柄/行）。
- 测试：`tests/unit/kb-agent.test.ts`（带出处、无依据、检索失败）、`tests/unit/qa-agent.test.ts`（路由与失败降级）、`npm run test:smoke:kb-qa` 端到端验证出处展开与无命中分支。
- 审查修正：`success`/`failure` 与 `describeError` 三处重复 → 提取到 `tool-result.ts` 与 `model/errors.ts`，全部单测与 smoke 复跑通过。
- 已验证：vitest 53、pytest 14、drawing/settings/qa/highlight/kb/kb-qa 全部 smoke 通过。

