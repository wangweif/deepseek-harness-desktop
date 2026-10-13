//! 农科小智企业门禁命令（NONGKE 定制）：SSO 登录回路 / 登出 / 状态。

use tauri::AppHandle;

use crate::service::enterprise;

/// 发起 SSO 登录：打开系统浏览器完成授权，阻塞至拿到会话并写好交接文件。
#[tauri::command]
pub async fn enterprise_login(
    app: AppHandle,
    server_url: Option<String>,
) -> Result<enterprise::LoginResult, String> {
    enterprise::login(app, server_url).await
}

/// 登出：删除会话交接文件（幂等，不调平台）。
#[tauri::command]
pub fn enterprise_logout(app: AppHandle) -> Result<(), String> {
    enterprise::logout(&app);
    Ok(())
}

/// 登录态快照：交接文件在否 + 平台地址。
#[tauri::command]
pub fn enterprise_status(app: AppHandle) -> Result<enterprise::StatusSnapshot, String> {
    Ok(enterprise::status(&app))
}
