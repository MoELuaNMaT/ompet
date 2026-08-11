//! ompet 桌面悬浮宠物窗：读取 session 快照目录 + 宠物帧缓存，供前端渲染。
//!
//! 数据源（Architecture V2）：
//! - `~/.omp/ompet/run/<sessionId>.json`：每 session 一份快照 V2（原子写）；
//!   迁移期同时扫描旧目录 `~/.omp/run/pets/`（V1 快照）
//! - `~/.codex/pets` / `~/.omp/ompet/pets`：宠物包（pet.json + spritesheet.webp），read_pet_bundle 读取
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use base64::Engine;
use tauri::Manager;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
}

/// 快照目录（V2）：~/.omp/ompet/run
fn run_root() -> PathBuf {
    home().join(".omp").join("ompet").join("run")
}

/// 旧快照目录（V1 迁移期读取）：~/.omp/run/pets
fn legacy_run_root() -> PathBuf {
    home().join(".omp").join("run").join("pets")
}

/// 主窗口位置持久化文件
fn state_file() -> PathBuf {
    run_root().join("window-state.json")
}

/// 主窗口位置/尺寸持久化结构（宠物尺寸可调）。
/// 旧格式为 (x, y) 二元数组（仅位置），from_file 兼容读取；width/height=0 表示未记录尺寸。
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl WindowState {
    /// 读取并兼容旧格式：新格式对象 {x,y,width,height}；旧格式 (x,y) 数组 → 尺寸 0（用默认）
    fn from_file(text: &str) -> Option<WindowState> {
        if let Ok(s) = serde_json::from_str::<WindowState>(text) {
            return Some(s);
        }
        let pos = serde_json::from_str::<(i32, i32)>(text).ok()?;
        Some(WindowState {
            x: pos.0,
            y: pos.1,
            width: 0,
            height: 0,
        })
    }
}

/// 窗口状态写盘节流（拖拽移动/缩放时 Moved/Resized 高频触发，不能每帧写）。
/// 前端在拖拽/缩放结束时调用 save_window_state 强制写盘兜底精确值。
const STATE_WRITE_THROTTLE_MS: u128 = 250;
thread_local! {
    static LAST_STATE_WRITE: std::cell::Cell<std::time::Instant> =
        std::cell::Cell::new(std::time::Instant::now());
}

/// 窗口状态读取抽象：tauri::Window 与 tauri::WebviewWindow 共用（on_window_event 传 Window，
/// command 注入 WebviewWindow，两者 outer_position/outer_size 签名一致）
trait WindowStateReader {
    fn outer_pos(&self) -> tauri::Result<tauri::PhysicalPosition<i32>>;
    fn outer_size(&self) -> tauri::Result<tauri::PhysicalSize<u32>>;
}

impl WindowStateReader for tauri::Window {
    fn outer_pos(&self) -> tauri::Result<tauri::PhysicalPosition<i32>> {
        self.outer_position()
    }
    fn outer_size(&self) -> tauri::Result<tauri::PhysicalSize<u32>> {
        self.outer_size()
    }
}

impl WindowStateReader for tauri::WebviewWindow {
    fn outer_pos(&self) -> tauri::Result<tauri::PhysicalPosition<i32>> {
        self.outer_position()
    }
    fn outer_size(&self) -> tauri::Result<tauri::PhysicalSize<u32>> {
        self.outer_size()
    }
}

/// 保存主窗口当前外部位/尺寸到 window-state.json；force=true 绕过节流（拖拽结束精确落盘）
fn persist_window_state<W: WindowStateReader>(win: &W, force: bool) {
    if !force {
        let now = std::time::Instant::now();
        let throttled = LAST_STATE_WRITE.with(|last| {
            if now.duration_since(last.get()).as_millis() < STATE_WRITE_THROTTLE_MS {
                true
            } else {
                last.set(now);
                false
            }
        });
        if throttled {
            return;
        }
    }
    let (Ok(pos), Ok(size)) = (win.outer_pos(), win.outer_size()) else {
        return;
    };
    let state = WindowState {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    };
    let Ok(json) = serde_json::to_string(&state) else {
        return;
    };
    let _ = fs::create_dir_all(run_root());
    let _ = fs::write(state_file(), json);
}

/// 前端在窗口拖拽/缩放结束时调用：强制保存最终位置与尺寸（不受节流限制）
#[tauri::command]
fn save_window_state(win: tauri::WebviewWindow) {
    persist_window_state(&win, true);
}

/// 原子设置窗口位置+尺寸（Rust 侧同步连续调用，无中间态）。
/// 前端分步 setPosition+setSize 是两个异步 IPC，中间窗口高度先变而位置未补偿时，
/// Windows 默认保持顶边不动 → 底边随高度移动，底部对齐的宠物/气泡布局被"压"移位；
/// 本命令在同一线程内同步执行两次 SetWindowPos（先位置后尺寸），WebView 只观察到最终态，
/// 底边保持固定、宠物位置不变。
#[tauri::command]
fn set_window_bounds(win: tauri::WebviewWindow, x: i32, y: i32, width: u32, height: u32) {
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(width, height)));
}

/// 快照文件返回值：文件名 + 内容。
/// content 为 None 表示读取失败（损坏/被占用/权限），前端跳过该文件保留当前画面。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    file: String,
    content: Option<String>,
}

/// 启动清理（方案 §33）：heartbeat 超过 24h 的陈旧快照真正删除文件。
/// 15s stale 只是不参与 session selection；24h 才落盘删除。
fn cleanup_stale_snapshots() {
    const STALE_CLEANUP_MS: u64 = 24 * 60 * 60 * 1000;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    for root in [run_root(), legacy_run_root()] {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
                continue;
            };
            if !name.ends_with(".json") || name.ends_with(".tmp") {
                continue;
            }
            if name == "window-state.json" || name == "registry.json" {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
                continue;
            };
            let Some(heartbeat) = value.get("heartbeatAt").and_then(serde_json::Value::as_u64) else {
                continue;
            };
            if now.saturating_sub(heartbeat) > STALE_CLEANUP_MS {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// 扫描快照目录下所有正式快照（V2 目录优先 + V1 旧目录迁移期兼容）：
/// 排除 `.json.tmp`（写入中）、window-state.json（窗口状态）、
/// 以及已废弃的旧格式 registry.json（JSONL 状态桥）。
fn read_snapshot_files() -> Vec<SnapshotFile> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for root in [run_root(), legacy_run_root()] {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
                continue;
            };
            if !name.ends_with(".json") || name.ends_with(".tmp") {
                continue;
            }
            if name == "window-state.json" || name == "registry.json" {
                continue;
            }
            // 同名文件取新目录（先扫的新目录优先）
            if !seen.insert(name.clone()) {
                continue;
            }
            let content = fs::read_to_string(&path).ok();
            out.push(SnapshotFile { file: name, content });
        }
    }
    out
}

/// 桌面运行时读取入口（方案 §37）：一次性返回 Global Config + 全部快照。
/// Config 损坏/缺失 → None（前端用最后一个有效或默认配置）；
/// 单个快照损坏 → content=None（前端跳过该文件保留当前画面）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeState {
    config: Option<String>,
    snapshots: Vec<SnapshotFile>,
}

#[tauri::command]
fn read_runtime_state() -> RuntimeState {
    RuntimeState {
        config: fs::read_to_string(home().join(".omp").join("ompet").join("config.json")).ok(),
        snapshots: read_snapshot_files(),
    }
}

/// 退出桌面进程（跟随 omp 生命周期：所有 session 无效持续超时后由前端调用）。
/// 不能走窗口 close()——主窗口 CloseRequested 被托盘常驻逻辑拦截为隐藏。
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 图集文件大小上限（方案 §42：推荐最大 16 MiB）
const MAX_SPRITE_BYTES: u64 = 16 * 1024 * 1024;

/// 按 PetKey 的来源解析固定根目录（方案 §8：codex → ~/.codex/pets，ompet → ~/.omp/ompet/pets）
fn pet_root(source: &str) -> Option<PathBuf> {
    match source {
        "codex" => Some(home().join(".codex").join("pets")),
        "ompet" => Some(home().join(".omp").join("ompet").join("pets")),
        _ => None,
    }
}

/// 路径逃逸检查（与 shared 契约一致：绝对路径或含 `..` 段）
fn is_escaping_path(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with('\\') {
        return true;
    }
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return true; // Windows 盘符绝对路径
    }
    value.split(['/', '\\']).any(|seg| seg == "..")
}

/// 宠物包读取结果（方案 §42）：manifest 原文 + spritesheet 的 data URL。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PetBundle {
    manifest: serde_json::Value,
    sprite_data_url: String,
}

/// 按 PetKey 读取宠物包（方案 §42）：解析固定 root → pet.json → spritesheetPath
/// 白名单校验 → 尺寸限制 → base64 data URL。Codex 宠物文件完全只读。
#[tauri::command]
fn read_pet_bundle(pet_key: String) -> Result<PetBundle, String> {
    let (source, id) = pet_key.split_once(':').ok_or("非法 PetKey（应为 source:id）")?;
    let root = pet_root(source).ok_or_else(|| format!("未知宠物来源：{source}"))?;
    let pet_dir = root.join(id);
    if !pet_dir.is_dir() {
        return Err(format!("宠物目录不存在：{}", pet_dir.display()));
    }

    let manifest_raw = fs::read_to_string(pet_dir.join("pet.json"))
        .map_err(|e| format!("读取 pet.json 失败：{e}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_raw).map_err(|e| format!("pet.json 非法：{e}"))?;

    let sprite_rel = manifest
        .get("spritesheetPath")
        .and_then(|v| v.as_str())
        .ok_or("pet.json 缺少 spritesheetPath")?;
    if is_escaping_path(sprite_rel) {
        return Err("spritesheetPath 不允许绝对路径或 ..".into());
    }
    let sprite_path = pet_dir.join(sprite_rel);
    if !sprite_path.starts_with(&pet_dir) {
        return Err("spritesheetPath 逃逸宠物目录".into());
    }

    let meta = fs::metadata(&sprite_path).map_err(|e| format!("读取图集失败：{e}"))?;
    if meta.len() > MAX_SPRITE_BYTES {
        return Err(format!("图集超过 16 MiB 限制（{} bytes）", meta.len()));
    }
    let bytes = fs::read(&sprite_path).map_err(|e| format!("读取图集失败：{e}"))?;
    let sprite_data_url = format!(
        "data:image/webp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    Ok(PetBundle { manifest, sprite_data_url })
}


/// Windows Terminal 标签切换结果：区分普通控制台、标签存在但未命中和执行失败。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TabSwitchResult {
    Switched,
    NoTabs,
    NoMatch,
    Error,
}

/// 解析标签切换脚本的标准输出，避免把“有标签但未命中”误判成普通控制台。
fn parse_tab_switch_output(stdout: &[u8]) -> TabSwitchResult {
    match String::from_utf8_lossy(stdout).trim() {
        "switched" => TabSwitchResult::Switched,
        "notabs" => TabSwitchResult::NoTabs,
        "nomatch" => TabSwitchResult::NoMatch,
        _ => TabSwitchResult::Error,
    }
}

/// 按会话级终端标题切换 Windows Terminal 标签（UIA）。
/// 脚本 include_str! 嵌入，运行时写临时文件执行。
fn switch_wt_tab(wt_hwnd: isize, title: &str) -> TabSwitchResult {
    use std::os::windows::process::CommandExt;
    let script = include_str!("focus_tab.ps1");
    let tmp = std::env::temp_dir().join("ompet-focus-tab.ps1");
    if fs::write(&tmp, script).is_err() {
        return TabSwitchResult::Error;
    }
    // CREATE_NO_WINDOW(0x08000000)：powershell 是控制台程序，直接 spawn 会为每次调用
    // 弹出控制台窗口（用户感知为"突然弹出多个 CMD 再关闭"），且抢走焦点干扰置前台
    let out = std::process::Command::new("powershell")
        .creation_flags(0x0800_0000)
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&tmp)
        .arg(wt_hwnd.to_string())
        .arg(title)
        .output();
    let _ = fs::remove_file(&tmp);
    match out {
        Ok(o) => parse_tab_switch_output(&o.stdout),
        Err(_) => TabSwitchResult::Error,
    }
}

/// 只有唯一的普通控制台候选才允许旧快照的项目名兜底。
/// 有标签但未命中或脚本执行失败时，即使窗口只有一个也必须报告失败。
fn legacy_focus_fallback_allowed(window_count: usize, has_tabs: bool, has_error: bool) -> bool {
    window_count == 1 && !has_tabs && !has_error
}

/// 单击宠物：聚焦对应 omp 实例的终端窗口并切到对应标签。
/// omp 是控制台进程（自身无窗口），其终端窗口（Windows Terminal / conhost 等）
/// 是 omp 进程的祖先进程——枚举可见顶层窗口，窗口进程属于 {pid} ∪ 祖先链(pid)
/// 即命中；先按会话级标题切换标签（UIA），旧快照无标题时才使用 project 作为兼容值，
/// 再恢复最小化并置前台（模拟 Alt 键绕过 Windows 前台锁）。
#[tauri::command]
fn focus_ompi_terminal(pid: u32, project: String, title: String) -> bool {
    use std::collections::{HashMap, HashSet};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, TRUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::GetCurrentProcessId,
        },
        UI::{
            Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU},
            WindowsAndMessaging::{
                BringWindowToTop, EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
                SetForegroundWindow, ShowWindow, SW_RESTORE,
            },
        },
    };

    // 1. 祖先进程链（含自身）：快照一次父映射，从 pid 上溯
    let mut chain: HashSet<u32> = HashSet::new();
    chain.insert(pid);
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            let mut parents: HashMap<u32, u32> = HashMap::new();
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..std::mem::zeroed()
            };
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
            let mut cur = pid;
            while let Some(&parent) = parents.get(&cur) {
                if !chain.insert(parent) {
                    break; // 防环
                }
                if parent == GetCurrentProcessId() {
                    break; // 别上溯到桌面/系统根以上
                }
                cur = parent;
            }
        }
    }

    // 2. 枚举可见顶层窗口，收集所有窗口进程 ∈ 祖先链 的句柄（按 Z 序）。
    //    Windows Terminal 是单进程多窗口（所有窗口同属 WindowsTerminal.exe），
    //    只取第一个会命中最近激活的窗口（"最后一个打开的终端"），必须收集全部
    //    再按标签名匹配选择目标窗口。
    struct Ctx {
        chain: HashSet<u32>,
        windows: Vec<HWND>,
    }
    unsafe extern "system" fn enum_windows_cb(hwnd: HWND, lparam: LPARAM) -> i32 {
        let ctx = &mut *(lparam as *mut Ctx);
        if IsWindowVisible(hwnd) == TRUE {
            let mut win_pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut win_pid);
            if ctx.chain.contains(&win_pid) {
                ctx.windows.push(hwnd);
            }
        }
        TRUE
    }

    let mut ctx = Ctx {
        chain,
        windows: Vec::new(),
    };
    unsafe {
        EnumWindows(Some(enum_windows_cb), &mut ctx as *mut Ctx as LPARAM);
    }
    if ctx.windows.is_empty() {
        return false;
    }

    // 恢复最小化 + 置前（模拟 Alt 键绕过 Windows 前台锁）
    unsafe fn activate_window(hwnd: HWND) {
        if IsIconic(hwnd) == TRUE {
            ShowWindow(hwnd, SW_RESTORE);
        }
        keybd_event(VK_MENU as u8, 0, 0, 0);
        keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
    }

    // 3. 逐个窗口按会话级标题切换标签（UIA）：目标标签所在窗口切成功 → 激活它。
    //    旧快照没有 terminalTitle 时使用 project 兼容；多窗口全部不匹配时必须失败，
    //    不能再激活 Z 序最前窗口造成静默错窗。
    let target_title = if title.trim().is_empty() {
        project.as_str()
    } else {
        title.as_str()
    };
    let mut has_tabs = false;
    let mut has_error = false;
    for &hwnd in &ctx.windows {
        match switch_wt_tab(hwnd as isize, target_title) {
            TabSwitchResult::Switched => {
                unsafe {
                    activate_window(hwnd);
                }
                return true;
            }
            TabSwitchResult::NoTabs => {}
            TabSwitchResult::NoMatch => has_tabs = true,
            TabSwitchResult::Error => has_error = true,
        }
    }
    if legacy_focus_fallback_allowed(ctx.windows.len(), has_tabs, has_error) {
        unsafe {
            activate_window(ctx.windows[0]);
        }
        return true;
    }
    false
}

/// 系统托盘：左键切换主窗口显示；菜单提供显示/退出
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    let toggle = MenuItemBuilder::with_id("toggle", "显示/隐藏宠物")
        .accelerator("F8")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle, &quit])
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| tauri::image::Image::new(&[], 0, 0));

    tauri::tray::TrayIconBuilder::with_id("ompet")
        .icon(icon)
        .tooltip("ompet 宠物")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("pet") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动清理陈旧快照（方案 §33：heartbeat 超 24h 删除）
    cleanup_stale_snapshots();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_single_instance::init(|app, _args, _cwd| {
                // 二次启动：聚焦已存在的主窗口（悬浮宠物常驻，无需多实例）
                if let Some(win) = app.get_webview_window("pet") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }),
        )
        .setup(|app| {
            build_tray(app)?;
            // 恢复主窗口上次位置/尺寸（拖拽/缩放后重启保持）
            if let Some(win) = app.get_webview_window("pet") {
                if let Ok(text) = fs::read_to_string(state_file()) {
                    if let Some(state) = WindowState::from_file(&text) {
                        // 先设尺寸再设位置：避免 set_size 触发位置相关布局后覆盖恢复的位置
                        if state.width > 0 && state.height > 0 {
                            let _ = win.set_size(tauri::PhysicalSize::new(state.width, state.height));
                        }
                        let _ = win.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition::new(state.x, state.y),
                        ));
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "pet" {
                match event {
                    // 主窗口关闭 → 隐藏保持托盘常驻；子窗口关闭正常销毁
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // 移动/缩放后节流保存窗口状态（拖拽结束时前端另走 save_window_state 强制写）
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        persist_window_state(window, false);
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_runtime_state,
            read_pet_bundle,
            focus_ompi_terminal,
            exit_app,
            save_window_state,
            set_window_bounds
        ])
        .run(tauri::generate_context!())
        .expect("error while running ompet");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_focus_fallback_only_allows_single_plain_console() {
        assert!(!legacy_focus_fallback_allowed(0, false, false));
        assert!(legacy_focus_fallback_allowed(1, false, false));
        assert!(!legacy_focus_fallback_allowed(1, true, false));
        assert!(!legacy_focus_fallback_allowed(1, false, true));
        assert!(!legacy_focus_fallback_allowed(2, false, false));
    }

    #[test]
    fn parse_tab_switch_output_distinguishes_no_tabs_and_no_match() {
        assert_eq!(
            parse_tab_switch_output(b"switched\r\n"),
            TabSwitchResult::Switched
        );
        assert_eq!(
            parse_tab_switch_output(b"notabs\n"),
            TabSwitchResult::NoTabs
        );
        assert_eq!(
            parse_tab_switch_output(b"nomatch\n"),
            TabSwitchResult::NoMatch
        );
        assert_eq!(
            parse_tab_switch_output(b"unexpected"),
            TabSwitchResult::Error
        );
    }

    #[test]
    fn read_snapshots_returns_valid_json() {
        // 快照目录可能不存在（未运行过扩展）——存在时每份正式快照必须是合法 JSON
        let snaps = read_snapshot_files();
        for snap in snaps {
            if let Some(content) = snap.content {
                let v: serde_json::Value = serde_json::from_str(&content)
                    .expect("快照必须是合法 JSON");
                assert!(
                    v.get("sessionId").is_some() && v.get("activity").is_some(),
                    "快照应含 sessionId/activity 字段"
                );
            }
            // 损坏文件 content=None 时不 panic（前端跳过本轮）
        }
    }

    #[test]
    fn read_snapshots_filters_non_snapshot_files() {
        // 未部署时目录不存在 → 空列表（不崩溃）
        let snaps = read_snapshot_files();
        for snap in snaps {
            assert!(
                snap.file != "window-state.json" && snap.file != "registry.json" && !snap.file.ends_with(".tmp"),
                "不应返回非快照文件：{}",
                snap.file
            );
        }
    }

    #[test]
    fn window_state_new_format_roundtrip() {
        let s = WindowState {
            x: 10,
            y: 20,
            width: 300,
            height: 325,
        };
        let json = serde_json::to_string(&s).unwrap();
        let back = WindowState::from_file(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn window_state_legacy_array_format_only_position() {
        // 旧格式 (x, y) 二元数组：仅位置，尺寸 0 表示未记录
        let s = WindowState::from_file("[100, 200]").unwrap();
        assert_eq!(s.x, 100);
        assert_eq!(s.y, 200);
        assert_eq!(s.width, 0);
        assert_eq!(s.height, 0);
    }

    #[test]
    fn window_state_invalid_returns_none() {
        assert!(WindowState::from_file("not json").is_none());
        assert!(WindowState::from_file("{}").is_none());
        assert!(WindowState::from_file("[1]").is_none());
    }
}
