# 桌面常驻 AI 交互应用（陪伴桌宠）

一个运行在 Windows 桌面上的 AI 对话应用：角色以 Live2D 形象常驻桌面，支持透明窗口与鼠标穿透，能进行自然的流式对话，具备人设与长期记忆。

## 功能

- **桌面常驻**：透明无边框窗口，鼠标穿透，支持多显示器与高 DPI 缩放
- **自然对话**：接入大模型 API，SSE 流式输出，逐字显示
- **人设与记忆**：独立后端服务维护对话人设、历史记忆与主动发言策略
- **Live2D 形象**：表情、眨眼、口型与视线跟随，动作与回复内容联动
- **插件化扩展**：内置番茄钟、待办、健康提醒、屏幕感知等插件
- **本地优先**：对话与记忆保存在本地，配置由使用者自行填写

## 技术栈

| 层 | 技术 |
|---|---|
| 客户端壳 | Tauri（Rust） |
| 前端 | TypeScript + Vite |
| 角色渲染 | Live2D Cubism Core |
| 后端服务 | TypeScript（Node） |
| 模型接入 | DeepSeek / 兼容 OpenAI 接口的大模型 API |
| 通信 | HTTP + SSE |

## 目录结构

```
src/               前端源码（UI、聊天、渲染、插件）
src-tauri/         Tauri 壳与 Rust 原生能力（透明窗口、鼠标穿透、指针广播）
mind/server/       后端服务：对话生成、记忆检索、动作控制
mind/types/        共享类型
mind/contract/     接口契约
scripts/           构建与自检脚本
```

## 本地运行

1. 复制 `mind/config.example.json` 为 `mind/config.json`，填入自己的模型地址与 API Key。
2. 安装依赖：`npm install`
3. 启动后端：`npm run mind`（或按 `mind/README` 说明启动）
4. 启动客户端：`npm run dev`

## 说明

- 本仓库不包含 Live2D 模型文件、构建产物与本地对话数据，仅保留可阅读的源码。
- 模型文件与配置属于使用者本地资源，不随仓库分发。
