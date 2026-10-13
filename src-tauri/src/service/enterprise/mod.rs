//! 农科小智企业门禁：SSO 登录回路与会话交接（NONGKE 定制，登记于
//! NONGKE-CUSTOMIZATIONS.md #3）。
//!
//! WebView 读不到系统浏览器域下的 HttpOnly cookie，登录回路借道
//! agent_platform：本模块在 127.0.0.1 起一次性 loopback listener →
//! opener 打开系统浏览器到平台 `/oauth/login?desktop_port=<port>` →
//! 用户完成 IdP 授权后平台以一次性 code 302 回 loopback → 本模块拿
//! code 调平台 `/api/auth/desktop/exchange` 换取与浏览器登录等价的
//! 会话 cookie，并按 Electron 版契约写交接文件
//! `<DSH_HOME>/enterprise/agent-platform-session.json`（0600 原子写，
//! 内容 `{serverUrl, sessionCookie}`，恒用 `/` 分隔符——harness 插件
//! dsh-enterprise-agents 按同一约定拼接路径）。
//!
//! 登出即删交接文件；会话有效性由内核侧插件调平台判定，壳不做缓存。

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::config::get_dsh_data_path;

/// 平台默认地址（含子路径部署前缀，与 Electron 版常量一致）。
pub const DEFAULT_SERVER_URL: &str = "https://ai.touchit.com.cn/agent";

/// 登录等待上限：用户在系统浏览器完成 IdP 授权的时间窗。
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

/// 交接文件名（相对 $DSH_HOME，分隔符恒用 `/`）。
const HANDOFF_RELATIVE: &str = "enterprise/agent-platform-session.json";

#[derive(Debug, Deserialize)]
struct ExchangeEnvelope {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<ExchangeData>,
}

#[derive(Debug, Deserialize)]
struct ExchangeData {
    cookie_name: String,
    cookie_value: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    nickname: String,
}

/// 登录结果（前端展示用；持久态在交接文件里）。
#[derive(Debug, serde::Serialize)]
pub struct LoginResult {
    pub username: String,
    pub nickname: String,
    pub server_url: String,
}

/// 交接文件绝对路径（分隔符归一为 `/`，与 harness 插件约定一致）。
pub fn handoff_path(app: &AppHandle) -> PathBuf {
    let raw = get_dsh_data_path(app)
        .to_string_lossy()
        .replace('\\', "/");
    PathBuf::from(format!("{raw}/{HANDOFF_RELATIVE}"))
}

/// 当前登录态快照：交接文件存在即视为已登录（有效性由消费方调平台判定）。
#[derive(Debug, serde::Serialize)]
pub struct StatusSnapshot {
    pub logged_in: bool,
    pub server_url: Option<String>,
}

pub fn status(app: &AppHandle) -> StatusSnapshot {
    let path = handoff_path(app);
    match std::fs::read_to_string(&path) {
        Ok(body) => {
            let server = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("serverUrl")
                        .and_then(|s| s.as_str())
                        .map(str::to_string)
                });
            StatusSnapshot {
                logged_in: server.is_some(),
                server_url: server,
            }
        }
        Err(_) => StatusSnapshot {
            logged_in: false,
            server_url: None,
        },
    }
}

/// 登出：删除交接文件（幂等）。
pub fn logout(app: &AppHandle) {
    let _ = std::fs::remove_file(handoff_path(app));
}

/// SSO 登录回路：loopback listener + 系统浏览器 + code 交换 + 写交接文件。
///
/// 阻塞至登录完成/超时，由 bridge 层以 async command 暴露给前端。
pub async fn login(app: AppHandle, server_url_override: Option<String>) -> Result<LoginResult, String> {
    let server_url = server_url_override
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());

    // 1) 随机端口 listener
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("ENTERPRISE_SSO_BIND_FAILED: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("ENTERPRISE_SSO_ADDR_FAILED: {e}"))?
        .port();

    // 2) 打开系统浏览器（此后的等待中用户可能关闭窗口，listener 先起再开浏览器）
    let login_url = format!("{server_url}/oauth/login?desktop_port={port}");
    app.opener()
        .open_url(login_url, None::<&str>)
        .map_err(|e| format!("ENTERPRISE_SSO_OPEN_BROWSER_FAILED: {e}"))?;

    // 3) 等一次性 code（GET /?code=...）；收到即回一个可关闭的提示页
    let code = tokio::time::timeout(LOGIN_TIMEOUT, accept_code(listener))
        .await
        .map_err(|_| "ENTERPRISE_SSO_TIMEOUT: 等待登录超时".to_string())?
        .map_err(|e| format!("ENTERPRISE_SSO_LISTEN_FAILED: {e}"))?;

    // 4) code 换会话 cookie
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("ENTERPRISE_SSO_HTTP_INIT_FAILED: {e}"))?;
    let resp = client
        .post(format!("{server_url}/api/auth/desktop/exchange"))
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| format!("ENTERPRISE_SSO_EXCHANGE_REQUEST_FAILED: {e}"))?;
    let envelope: ExchangeEnvelope = resp
        .json()
        .await
        .map_err(|e| format!("ENTERPRISE_SSO_EXCHANGE_PARSE_FAILED: {e}"))?;
    let data = if envelope.success {
        envelope.data
    } else {
        // 平台 API 走 HTTP 200 包络：错误码与文案都在 body 里
        return Err(format!(
            "ENTERPRISE_SSO_EXCHANGE_REJECTED: {} {}",
            envelope.code, envelope.message
        ));
    }
    .ok_or_else(|| "ENTERPRISE_SSO_EXCHANGE_EMPTY".to_string())?;

    // 5) 写交接文件（0600 + 同目录 tmp/rename 原子写；Windows rename 不可覆盖，
    //    先删后写，代价是该窗口内非原子——与 Electron 版实现同姿态）
    let path = handoff_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("ENTERPRISE_SSO_MKDIR_FAILED: {e}"))?;
    }
    let body = format!(
        "{}\n",
        serde_json::json!({
            "serverUrl": server_url,
            "sessionCookie": format!("{}={}", data.cookie_name, data.cookie_value),
        })
    );
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)
        .map_err(|e| format!("ENTERPRISE_SSO_WRITE_FAILED: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&tmp, &path)
            .map_err(|e| format!("ENTERPRISE_SSO_RENAME_FAILED: {e}"))?;
    }

    Ok(LoginResult {
        username: data.username,
        nickname: data.nickname,
        server_url,
    })
}

/// 从 loopback 连接解析一次性 code（浏览器收到平台的 302 后请求本机）。
async fn accept_code(listener: TcpListener) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|e| format!("ENTERPRISE_SSO_ACCEPT_FAILED: {e}"))?;
        let mut buf = [0u8; 4096];
        let n = socket
            .read(&mut buf)
            .await
            .map_err(|e| format!("ENTERPRISE_SSO_READ_FAILED: {e}"))?;
        let request = String::from_utf8_lossy(&buf[..n]).to_string();
        let first_line = request.lines().next().unwrap_or_default();
        // GET /?code=xxx HTTP/1.1 —— 解析 query 里的 code
        let code = first_line
            .split_whitespace()
            .nth(1)
            .and_then(|path| path.split_once("code="))
            .map(|(_, raw)| {
                raw.split('&')
                    .next()
                    .unwrap_or(raw)
                    .trim()
                    .to_string()
            })
            .filter(|c| !c.is_empty());
        let page = "<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:system-ui;padding:3em;text-align:center\">登录成功，本页面可以关闭。</body>";
        let _ = socket
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", page.len(), page).as_bytes(),
            )
            .await;
        let _ = socket.shutdown().await;
        if let Some(code) = code {
            return Ok(code);
        }
        // 无 code 的连接（如浏览器预检/favicon）继续等
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn send_raw(port: u16, raw: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        stream.write_all(raw.as_bytes()).await.expect("write");
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.expect("read");
        String::from_utf8_lossy(&buf).to_string()
    }

    #[tokio::test]
    async fn accept_code_receives_code_and_answers_html() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(accept_code(listener));
        let response = send_raw(
            port,
            "GET /?code=abc123 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("登录成功"));
        assert_eq!(task.await.unwrap().unwrap(), "abc123");
    }

    #[tokio::test]
    async fn accept_code_ignores_codeless_probes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(accept_code(listener));
        // 无 code 的探测连接（favicon 等）不终结等待
        let probe = send_raw(port, "GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(probe.starts_with("HTTP/1.1 200 OK"));
        let hit = send_raw(port, "GET /?code=zzz&x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(hit.starts_with("HTTP/1.1 200 OK"));
        // code 后带其它 query 参数时只取 code 的值
        assert_eq!(task.await.unwrap().unwrap(), "zzz");
    }

    #[test]
    fn exchange_envelope_parses_platform_wrapped_errors() {
        // 平台 /api 包络：HTTP 200 + body {success:false, code:401, message}
        let raw = r#"{"code":401,"success":false,"message":"登录码无效或已过期，请重新登录"}"#;
        let env: ExchangeEnvelope = serde_json::from_str(raw).unwrap();
        assert!(!env.success);
        assert_eq!(env.code, 401);
        // 成功形态
        let raw = r#"{"code":0,"success":true,"data":{"cookie_name":"agent_platform_session","cookie_value":"eyJ...","username":"u","nickname":"n"}}"#;
        let env: ExchangeEnvelope = serde_json::from_str(raw).unwrap();
        assert!(env.success);
        assert_eq!(env.data.unwrap().cookie_name, "agent_platform_session");
    }
}
