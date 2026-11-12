# 生成 smoke、全量验证与文档

**Blocked by**: 022

## 目标
把生成成功与重试耗尽两条链路固化为 Electron smoke，完成 typecheck / vitest / pytest / 全部 smoke 回归，并更新交付说明与已知限制，使该功能可交付验收。

## 涉及层
- [ ] 数据层：无新增契约；smoke 通过 `SMOKE_GENERATED_DIR` 指定生成目录
- [ ] 逻辑层：`scripts/smoke.mjs` 增加 `--generate` 场景；`scripts/smoke-generate.mjs` 准备生成目录并分成功、失败两阶段运行；`src/main/index.ts` 增加 `runGenerateSmoke`（假模型确认为 800 mm 净宽 → 生成 → 校验通过 → 预览；`SMOKE_GENERATE_FAIL=1` 时校验失败并重试耗尽）
- [ ] UI层：smoke 截图保存到 `out/smoke-generate-*.png`
- [ ] 测试：`npm run test:smoke:generate`；全量 `typecheck`、`vitest`、`test:python` 与既有全部 smoke

## 验收标准
- 成功场景断言：确认参数 →「生成图纸」→ 状态完成 → 生成文件存在且可回读 → 校验通过 → 预览画布有墨迹 → 历史出现生成记录
- 失败场景断言：状态出现 `retrying` → 最终「校验未通过」与问题清单 → 文件保留 → 历史记录显示未通过条数
- 两条场景截图输出到 `out/`，可作为人工验收证据
- `npm run typecheck`、`npx vitest run`、`npm run test:python` 与全部既有 smoke 全部通过，并记录实际数量
- `docs/交付说明.md` 更新：生成入口、测试命令、已知限制（图型模板待 010、不支持 DWG 输出、模型不可选路径、同一时间一个生成任务）
- 临时产物清理，截图保留
