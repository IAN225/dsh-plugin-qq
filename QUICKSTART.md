# QQ/OneBot quick start (Windows)

## Critical timing and hot reload

SnowLuma creates its OneBot token **after the first successful QQ injection/login**. The per-account file is:

```text
<SnowLuma-root>\config\onebot_<uin>.json
```

The token in that file is generated randomly. The external DSH plugin config must be written **after** that file exists:

```text
start SnowLuma
  -> inject/sign in QQ
  -> read config/onebot_<uin>.json
  -> write %USERPROFILE%\.dsh\qq-plugin\config.json
  -> install/enable the DSH plugin
```

If the plugin was already enabled before `config.json` was written, it watches the config directory and reconnects automatically after the file changes. The manual fallback is:

```text
qq_setup {"action":"reload"}
```

Then verify:

```text
qq_setup {"action":"verify"}
qq_channel {"module":"status"}
```

A plugin disable/enable or DSH restart also reloads the config, but should not be necessary with the current version.

## After a Windows reboot

The DSH plugin is loaded by DSH automatically if it remains installed. SnowLuma/NapCat are separate services and do not start themselves.

1. Sign in to QQNT if it did not auto-login.
2. Start SnowLuma with `launcher.bat` (or start NapCat).
3. Open the SnowLuma WebUI and load/inject the running QQ process again.
4. Wait for the plugin WebSocket to reconnect, or force it:
   ```text
   qq_setup {"action":"reload"}
   ```
5. Verify:
   ```text
   qq_setup {"action":"verify"}
   qq_channel {"module":"status"}
   ```

The account binding, SQLite message history and receipts persist across reboot. Do not reinstall the DSH plugin. If SnowLuma was reset and generated a new OneBot token, update `%USERPROFILE%\.dsh\qq-plugin\config.json`; the plugin watches that file and reloads automatically.

## Windows file security and integrity

Two unrelated Windows mechanisms can block a local service install:

1. **Mark of the Web / Attachment Manager**
   - The dialog about Internet security settings blocking a file comes from a `Zone.Identifier` alternate data stream.
   - Open the archive's Properties and choose **Unblock**, or run:
     ```powershell
     Unblock-File .\local-dsh-plugin-qq-0.2.5.tgz
     ```
   - If files were extracted from the archive, unblock the extracted tree as well:
     ```powershell
     Get-ChildItem -Recurse -File <directory> | Unblock-File
     ```
2. **Low Integrity files**
   - Do not extract SnowLuma into the DSH workspace. Files there may inherit a Low Integrity label and cannot inject into a Medium-integrity QQNT process.
   - Example location, only after the user confirms it:
     ```text
     %USERPROFILE%\SnowLuma
     ```
   - If needed, repair the service directory integrity label:
     ```powershell
     icacls "%USERPROFILE%\SnowLuma" /setintegritylevel (OI)(CI)M
     ```

Do not disable system-wide security controls. Verify the plugin tarball SHA256, unblock only files you intentionally downloaded, and keep tokens in the external config file.

This document is written for a DSH assistant that is helping a user install the external QQ service framework. The DSH plugin does **not** bundle SnowLuma, NapCat, QQNT, account credentials or message data.

## What the assistant can do

- Inspect running QQ/SnowLuma/NapCat processes and listening ports.
- Launch SnowLuma with its `launcher.bat`, or launch NapCat with the user's existing startup script.
- Create `%USERPROFILE%\.dsh\qq-plugin\config.json` with the local account, owner and OneBot access token.
- Verify `get_login_info` through the OneBot HTTP API.
- Install/enable the DSH plugin bundle and call `qq_channel` to bind the new session.

## What only the user can do

- Install QQNT and sign in to the QQ account.
- Sign in to the SnowLuma/NapCat WebUI.
- Scan the QQ login QR code or confirm the login on a phone.
- Accept friend requests or send the first test message from another QQ account.

## Choose the install directory once

Ask once, using the same language as the user, where SnowLuma/NapCat should be installed or extracted. Do not demand that the user provide an absolute path.

Accept answers such as:

```text
D 盘随便一个目录
只要不是 C 盘就行
你帮我选
```

If the user delegates or gives a vague preference, choose one reasonable writable location that matches it and continue. Do not repeatedly ask. Resolve the path internally and check write permission, free space, and that it is outside the DSH workspace.

Ask again only when the chosen directory is not writable or an existing installation/data conflict needs a user decision. Avoid `C:/Program Files` and the DSH workspace. `%LOCALAPPDATA%\SnowLuma` or `%USERPROFILE%\SnowLuma` are examples when the user has no preference; they are not automatic choices when the user requested another drive.

## SnowLuma + QQNT

1. Install QQNT outside the DSH plugin directory.
2. Extract SnowLuma into a directory owned by the user, for example:

```text
<workspace>\vendor\SnowLuma\SnowLuma
```

3. Start SnowLuma:

```powershell
Set-Location <SnowLuma-root>
.\launcher.bat
```

4. Open the WebUI, usually:

```text
http://127.0.0.1:5099
```

5. Sign in to the SnowLuma admin page and load/inject the running QQ process. Then sign in to QQ if needed.
6. Confirm the OneBot adapters:

```text
HTTP       127.0.0.1:3000
WebSocket  127.0.0.1:3001
messageFormat = array
reportSelfMessage = true
accessToken = <local secret>
```

7. Create the external plugin configuration:

```text
%USERPROFILE%\.dsh\qq-plugin\config.json
```

```json
{
  "account": "QQ_NUMBER",
  "owner": "OWNER_QQ",
  "onebot": {
    "mode": "ws",
    "url": "ws://127.0.0.1:3001/",
    "httpUrl": "http://127.0.0.1:3000/",
    "accessToken": "<local secret>"
  }
}
```

Do not put the access token in a distributed `.tgz`.

## NapCat / generic OneBot 11

1. Start NapCat and sign in to QQ.
2. Enable an OneBot 11 WebSocket server at `ws://127.0.0.1:3001/` or an HTTP event sink.
3. Use `messageFormat=array`.
4. Keep the access token in the external `config.json` shown above.
5. The plugin supports standard `send_group_msg`, `send_private_msg`, `send_msg`, group-file and `get_forward_msg` actions.

## Verify

Run the bundled doctor script:

```powershell
.\scripts\verify-onebot.ps1 -ConfigFile "$env:USERPROFILE\.dsh\qq-plugin\config.json"
```

Expected result includes:

```json
{"status":"ok","retcode":0,"data":{"user_id":123456789}}
```

Then install the plugin `.tgz` in DSH and open a new session. The first `qq_channel` call binds that session to the QQ account. A later session that calls any QQ tool takes over; the old session cannot reclaim the account by reconnecting.

## Model-facing setup helper

When SnowLuma/NapCat or OneBot is not ready, ask the model:

```text
qq_channel {"module":"setup"}
```

It returns the same quick-start phases, current connection state, whether an access token is configured, the external config path, and the assistant/user responsibilities.

