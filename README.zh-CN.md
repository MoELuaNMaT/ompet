# OMPet —— 参考 Codex 宠物的 OMP 桌面宠物

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | **简体中文**

> 参考 Codex 宠物的资源格式与交互方式，并直接复用 Codex 兼容宠物包来展示 OMP 会话状态。

OMPet 是 [Oh My Pi](https://github.com/oh-my-pi/oh-my-pi)（OMP）agent 框架的桌面宠物插件。它参考 Codex 宠物的设计，可以直接使用现有的 Codex 兼容宠物包，无需转换素材。扩展端负责收集 OMP 会话状态，桌面端负责渲染宠物、显示多会话状态并提供会话跳转。

## 截图示例

下面的截图展示了 OMPet 对多个 OMP 会话进行状态监控，以及展开会话状态胶囊的效果。

![多个 OMP 会话的缩略状态气泡](docs/screenshots/multi-session-monitoring.png)

![展开后的 OMP 会话状态胶囊](docs/screenshots/session-status-capsule.png)

截图中的宠物来自 [remilia-codex-pet 仓库](https://github.com/jarvisluk/remilia-codex-pet)；该宠物的原始宠物包不包含在本项目中，也不会随本项目分发，截图仅用于功能展示。OMPet 仍可按照下方说明直接读取本地 Codex 兼容宠物包。

## 核心功能

- **OMP 会话状态可视化** —— 将运行中、等待审批、空闲等会话活动映射为不同的宠物动画。
- **多会话状态监控** —— 同时运行多个 OMP 会话时，为每个活跃会话显示一个状态气泡，并用视觉差异区分会话状态。
- **会话级终端跳转** —— 点击宠物或会话气泡可以聚焦对应的 OMP 终端；使用会话级终端标题定位目标，无法匹配时不会激活其他窗口。
- **直接使用 Codex 宠物** —— 直接读取 Codex 兼容宠物包，不修改宠物包中的 `pet.json` 文件。
- **面板配置** —— `/ompet` 可以启用或禁用插件、切换宠物，以及配置各个状态对应的动画行；`/onmypet` 仍作为兼容别名保留。
- **桌面交互** —— 支持拖拽移动、右下角缩放、空闲动画、方向动画、托盘常驻和单实例运行。
- **本地轻量运行** —— 使用 Canvas 渲染和本地文件，不依赖网络，也不收集遥测数据。

## 工作方式

1. 运行 `bun scripts/build-extension.ts` 构建扩展，并将扩展和本地已有的宠物包部署到 OMP 目录；如果桌面端 exe 已经构建，也会一并部署。
2. 扩展监听 OMP 生命周期事件，为每个会话写入一份本地快照。
3. 桌面端读取会话快照和全局配置，更新宠物动画、会话气泡以及当前主会话。
4. 使用 `/ompet` 修改宠物或动画行映射，点击宠物或气泡返回对应的终端窗口。

## 快速开始

**运行要求**：bun ≥ 1.3、Windows 10+，以及 WebView2（受支持的 Windows 通常已内置）。

**构建桌面端要求**：Rust 工具链，以及 Tauri 2 在 Windows 上要求的构建环境。

```bash
# 首次使用，或桌面端 exe 不存在时，先构建桌面端
bun install
cd desktop
bun install
bunx tauri build --no-bundle --ci
cd ..

# 部署扩展和本地已有的宠物包
bun scripts/build-extension.ts

# 重启 omp 会话，使扩展在启动时加载
```

`scripts/build-extension.ts` 不会下载或构建桌面端 exe；只有在 `desktop/src-tauri/target/release/ompet-desktop.exe` 已存在时才会复制它。

## 使用

| 入口 | 说明 |
|---|---|
| `/ompet` | 打开宠物面板，切换宠物、配置动画行映射或开关插件。 |
| 桌面宠物 | 拖拽移动、拖拽右下角缩放；点击宠物聚焦当前主会话，点击气泡聚焦对应会话。 |

## 直接使用 Codex 宠物

OMPet 会直接读取 Codex 兼容的宠物包。将包含 `pet.json` 以及 `spritesheetPath` 指向的图集文件（通常是 `spritesheet.webp`）的宠物包放入以下任一目录，再通过 `/ompet` 选择：

- `~/.codex/pets/<id>/` —— Codex 宠物目录，OMPet 只读使用。
- `~/.omp/ompet/pets/<id>/` —— OMPet 的本地宠物目录。

设置面板会将动画行映射保存到 OMPet 的全局配置中，不会把 OMPet 专用元数据写回 Codex 宠物文件。

> 示例宠物素材因授权原因不纳入 Git。构建脚本会在本地存在 `remilia/` 和 `elaina-2/` 时尝试部署；如果没有这些目录，请自行准备宠物包并放入上面的任一目录。截图中外部宠物的原始宠物包不属于本仓库。

## 本地文件

| 路径 | 用途 |
|---|---|
| `~/.omp/ompet/config.json` | 插件开关、当前宠物和动画行映射等全局配置。 |
| `~/.omp/ompet/run/<encodedSessionId>.json` | 每个 OMP 会话对应的一份本地快照。 |
| `~/.omp/agent/extensions/ompet/` | 已部署的扩展文件和桌面端 exe。 |

## 项目结构

| 路径 | 职责 |
|---|---|
| `extension/` | OMP 生命周期集成、会话快照、宠物发现和 `/ompet` 面板。 |
| `desktop/` | Tauri 桌面窗口、宠物渲染、会话气泡和终端聚焦。 |
| `packages/shared/` | 宠物契约、会话状态、配置类型和快照类型等共享定义。 |
| `scripts/build-extension.ts` | 构建并部署扩展和本地已有的宠物包。 |

## 许可证

[MIT](LICENSE) © LuaNMaT
