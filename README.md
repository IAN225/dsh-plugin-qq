# DSH QQ plugin (OneBot 11)

Windows host plugin for DeepSeek Harness. It connects to SnowLuma or NapCat through OneBot 11, stores messages per QQ account in SQLite (WAL), buffers each conversation independently, and wakes the bound DSH session with compact receipts. The model sees short JSON while the database keeps the original event, sender identity, reply relationship, recall state and media references.

## Files and runtime

- Host plugin (no build step, no npm dependencies): `index.js`, `lib/*.js`
- Bundle manifest: `package.json`, `cordis.patch.yml`
- Local protocol configuration: `%USERPROFILE%\.dsh\qq-plugin\config.json` (preferred; package-local `config.local.json` is a development fallback)
- Per-account data: `%USERPROFILE%\.dsh\qq-plugin\accounts\<QQ>\qq.db`
- Media and downloads live beside each account database

`node:sqlite`, global `fetch` and global `WebSocket` are used, all available in the DSH Node runtime.

## Quick start

See [QUICKSTART.md](QUICKSTART.md). When SnowLuma/NapCat or OneBot is not ready, call `qq_channel {"module":"setup"}` from the new DSH session; it returns the install checklist and current connection state.

## Install

1. Configure SnowLuma or NapCat:
   - message format: `array`
   - report self messages: `true` if you want messages sent from another device to be visible as `{"self":...}`
   - open the OneBot WebSocket server and copy its access token
2. Create `%USERPROFILE%\.dsh\qq-plugin\config.json` from `config.local.example.json`, for example:

```json
{
  "account": "1000000001",
  "owner": "1000000002",
  "onebot": {
    "mode": "ws",
    "url": "ws://127.0.0.1:3001/",
    "accessToken": "replace-me"
  }
}
```

The plugin also checks `QQ_CONFIG_FILE` and a package-local `config.local.json` for development. Keep credentials outside the distributed package.

`mode: "http"` runs a local event sink (default `http://127.0.0.1:5701/onebot/events`) and sends actions to `httpUrl`. `mode: "ws"` is the recommended SnowLuma setup.

Protocol connection settings are local-only. Model-facing `qq_settings` never changes the URL, port or token.

3. In DSH, open **Plugins > Add plugin** and choose the packaged `.tgz`, or select a local checkout during development. Enable the row named **QQ channel (OneBot)**. SnowLuma/NapCat are external services and are not bundled in the plugin package.
4. Start a new session and call any QQ tool once. That session becomes the account holder. A later session that calls a QQ tool takes over; the previous holder receives `该账号已被其他会话接管` on later calls and cannot reclaim the account by reconnecting.

If the plugin is installed before the account is known, wait until OneBot is connected. The plugin obtains `self_id` through `get_login_info`.

## Ask before extracting

The assistant should ask once, in the user's language, where SnowLuma/NapCat should be installed. The user does not need to provide an absolute path. Accept vague preferences such as another drive or anywhere outside C:, and if the user delegates, choose one reasonable writable location and continue. Ask again only on write permission errors or an existing data conflict. Do not use the DSH workspace or `C:/Program Files`; `%USERPROFILE%\SnowLuma` is only an example.

## After a Windows reboot

DSH reloads installed plugins automatically. SnowLuma/NapCat must be started again, QQ must be signed in, and SnowLuma needs its QQ process injected/loaded again. Then call `qq_setup {"action":"reload"}` if the WebSocket has not reconnected within the retry window, followed by `qq_setup {"action":"verify"}` and `qq_channel {"module":"status"}`.

SQLite history, receipts and the account binding survive reboot. Reinstall the plugin only when updating the package. If SnowLuma data was reset and the OneBot token changed, update the external `config.json`; the file watcher reloads it.

## Install timing and config reload

SnowLuma generates `config/onebot_<uin>.json` only after the first QQ injection/login, with a random token. Write the external DSH config after that:

```text
start SnowLuma -> inject/login QQ -> read OneBot token -> write external config.json -> enable plugin
```

If the plugin is already enabled, it watches `%USERPROFILE%\.dsh\qq-plugin\config.json` and reconnects after the file is written. Use the dedicated tool when troubleshooting:

```json
{"tool":"qq_setup","arguments":{"action":"reload"}}
```

or `qq_setup {"action":"verify"}`. `qq_setup` is registered separately from `qq_channel` so it is visible in the initial tool list.

Windows may attach Mark-of-the-Web to downloaded archives. Use file Properties > **Unblock** or `Unblock-File`; do not extract SnowLuma into the DSH workspace because Low Integrity files may prevent injection into QQNT. The preferred directory is `%USERPROFILE%\SnowLuma`.

## Daily model flow

- A ready short batch is inline:
  `[QQ] c3d4e5f6 private=Alice(1000000002) {"authority":"owner","messages":["晚上好"]}`
- A long batch is only:
  `[QQ group] a1b2c3d4 群1(123456) 10条`
- Read it with `qq_receive {"receipt":"a1b2c3d4"}`.
- Reply with `qq_send {"receipt":"a1b2c3d4","reply":3,"content":"收到"}`.
- Mark a batch silent with `qq_send {"receipt":"a1b2c3d4"}`.
- Active send: `qq_send {"target":"private:1000000002","content":"收到"}`.

Message refs:

- Receipt item: `a1b2c3d4#3`
- DSH-sent or otherwise unbatched message: `m1a2b3c4`
- Media: `media:1a2b3c4`
- Forward: `f:1a2b3c4`
- Group file: `gf:1a2b3c4`

## Buffering

Each chat has its own durable pool. A chat becomes ready when any of these is true:

- last message has been silent for `silenceSeconds`
- buffered raw messages reach `countMessages`
- first buffered message has waited `maxWaitSeconds`

A forwarded bundle or a composite message is one raw message. Withdrawing a buffered message only adds `{"recalled":true}`; it does not renumber other messages. Drawing a receipt freezes its message set and numbering, with at most 10 messages.

Pending messages survive restart. While no session holds the account, messages keep accumulating. On a new bind or a resumed holder, the plugin sends one `[QQ backlog]` summary rather than waking once per batch.

## Settings

Use `qq_settings`. Target is `global`, `group:all`, `private:all`, `group:<id>` or `private:<id>`. Specific scopes override category scopes, which override global. Use `"inherit"` in a patch to remove that scope's override.

Common fields:

```json
{"set":{"silenceSeconds":15,"countMessages":5,"maxWaitSeconds":60}}
{"set":{"inlineThreshold":360,"quoteThreshold":160,"splitDelayMs":700}}
{"set":{"dnd":"at"}}
{"set":{"dnd":"all","dndHours":2}}
{"set":{"uploadDirs":["C:/QQBot/media"],"downloadDir":"C:/QQBot/downloads"}}
{"set":{"cacheMaxMb":1024,"mediaRetentionDays":30,"messageRetentionDays":30,"messageMaxPerChat":2000,"receiptRetentionDays":14,"receiptMax":2000}}
```

DND modes: `off` = wake normally, `at` = only direct @/reply-bot messages can wake, `all` = store only. `all` requires `dndHours`. Long-active chats get a once-per-hour hint appended to an existing notification only.

Whitelist changes require owner confirmation:

```json
{"whitelist":{"add":["group:123456"]}}
```

The plugin sends the owner a private QQ request. The owner replies `同意 <id>` or `拒绝 <id>`. Direct `set.whitelist` is refused.

## Media and group files

Images and stickers are downloaded eagerly; voice, video and file segments are downloaded when within the configured auto-download size. `qq_ref` resolves a ref locally and reports `missing`, `failed` or `deleted` explicitly. `qq_files`, `qq_upload_file`, and `qq_download_file` use group numbers directly; `group` in those tools is not a `group:` target string.

Custom-face support is capability-dependent. SnowLuma supports `fetch_custom_face_detail`; NapCat capabilities vary. If an emoji has no downloadable URL the tool reports the limitation instead of inventing a media file.

## Notes and limits

- One active QQ account per plugin instance. Storage is still partitioned per account.
- DSH must be idle before notifications are delivered. Running turns, approvals and user questions are never interrupted.
- The plugin records DSH-origin messages separately from messages sent by the same QQ account on another device. DSH-origin messages are normally hidden from notifications and remain queryable with their own `m...` ref.
- This workspace build was syntax-checked and exercised with deterministic unit/integration fixtures. Real QQ login and SnowLuma end-to-end delivery require the QQ account to be signed in.

## License

MIT
