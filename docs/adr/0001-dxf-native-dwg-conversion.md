# 以 DXF 为原生格式，DWG 通过 ODA File Converter 转换

工程图纸实际以 DWG 为主，但 DWG 是闭源二进制格式，原生读写需要 ODA/RealDWG 商业授权。本项目决定：内部一律处理 DXF，DWG 在导入前用 ODA File Converter（免费、需注册）转换为 DXF，生成结果也保存为 DXF。这样避免商业 SDK 的授权与部署锁定，同时不放弃 DWG 用户。代价是用户需先完成一次转换，且转换后的 DXF 可能丢失少数 DWG 专有特性。

## 备选方案

- 原生 DWG SDK：授权费用与部署复杂度高。
- 仅支持 DXF：用户实际图纸多为 DWG，可用性差。
