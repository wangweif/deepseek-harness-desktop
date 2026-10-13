# NONGKE-CUSTOMIZATIONS — 农科小智对 upstream（dsh-tauri）的全部分歧登记

规则（见 `~/work/agents/dsh-desktop/docs/tauri迁移-D1补丁路线定稿.md` 与实施计划）：
- `upstream-main` 分支 = upstream/main 只读镜像，永不改写；
- `main` = 集成分支，**merge 不 rebase**（保留 upstream SHA 便于审计）；
- 跟随 upstream **release tag**，不追 main；
- **每一条与 upstream 的分歧必须登记在本文件**（含动机与回退），Rust 触点硬顶 ≤5 个文件级改动；
- 每次同步 upstream 后跑 `pnpm lint && pnpm typecheck && pnpm test` + `cargo check --locked`。

## 登记表

| # | 类型 | 文件/位置 | 内容 | 动机 | 状态 | 回退 |
|---|---|---|---|---|---|---|
| 1 | 已实施 | `src-tauri/src/config/constants.rs` + `config/runtime.rs` | `DSH_CORE_URL` 常量指向 agent_platform 发版中心（`…/agent/desktop/core/releases/latest/download/`，GitHub Release 兼容形态）；`get_dsh_download_url[_for_tag]` 支持 `DSH_CORE_URL` 环境变量覆盖（dev/测试） | D1 定稿：路线甲形态 3（2026-10-13）；平台侧 `routers/desktop_core.py` 已落地（publish/download/manifest） | **已实施**（nongke/core-source 分支，`cargo check --locked` 绿） | 恢复常量 + 去掉 env 分支即回官方源 |
| 2 | 计划 | `src-tauri/tauri.conf.json` 等 | 品牌与出包（productName/identifier/icons/Updater 配置）；identifier 变更会切换 AppData 目录，须与数据迁移方案同评审 | 农科小智品牌 | **未实施**（P0 落地，nongke/brand 分支） | 还原配置 |

## 说明

- 2026-10-13 建仓。fork 起点 = upstream main @ `a100347`。
- PoC 验证（预补丁内核 + workbenches 渲染）未产生本仓代码改动，全部经 AppData 侧 `dependencies.json` 与 profile `cordis.patch.yml` 完成——这正是路线甲的价值：**壳零改动跑通全链路**。
- 我方 27 个 harness 级补丁不落本仓（属 B 仓 `wangweif/dsh-desktop`，CI 产出预补丁内核）。
