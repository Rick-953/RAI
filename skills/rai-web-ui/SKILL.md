---
name: rai-web-ui
description: RAI Web controls and settings by device.
---

# RAI Web UI
Determine desktop browser, mobile browser or installed Home Screen PWA from the current user-turn context; ask only if the distinction matters. Never guess a hidden control.

- Desktop: conversation list in the side panel; its footer gear opens Settings. Session ellipsis menu: rename, folders, pin, export, share/manage link, delete.
- Mobile: header sidebar button opens the conversation panel; use its footer Settings button. Model selector stays centered. Adaptive handedness can mirror sidebar/send/navigation controls; use labels instead of assuming left/right.
- Files: open 文件 inside the scrollable sidebar, above folders/conversations; it scrolls out of view and is not pinned under 新对话. The file page shows storage usage, 搜索文件 and 上传; its close button returns to chat. Open an item’s actions for preview, using it in a conversation, download or delete. On mobile first open the sidebar; use labels rather than a fixed screen side.
- Composer: plus menu contains attachment/tool controls; model/mode menu exposes model, thinking, internet and research choices. Sending changes to stop while generating. Thinking and tool summaries expand inline.
- Settings: account, security, subscription, language; general, capabilities, app, personalization, memory, notifications, advanced and about. Security handles passkeys/2FA/devices; general/customization holds appearance and adaptive handedness. Names may be localized. Read the actual screenshot or settings before claiming an exact toggle value.
- iOS PWA: Safari Share > Add to Home Screen; reopen using its icon. App content extends behind the home indicator, while buttons remain in the safe area. Browser chrome is not an in-app control.
- Login: password/email code, passkey, supported SSO, QR login. Compact language buttons share the registration footer. QR rotates every 3 seconds. On a logged-in device open the sidebar, choose 扫码授权登录 beside 临时对话, then scan with the camera or a fresh QR image. Check the waiting device, IP and approximate location; 确认登录 authorizes it directly. The matching code is visual only, not an input. IP location is approximate (VPN/proxy), not identity proof.
- Sharing: session ellipsis > Share conversation / Manage link. Read-only text snapshot, 7-day expiry, revoke in the same dialog. Shared page attempts CX RAI activation; browser may require clicking the open button.
- Desktop-only local agent entries require a paired agent; mobile browsers cannot silently execute PC commands. Do not promise CX RAI parity for Web-only features.

- Diagnostics: Settings > About > 导出脱敏诊断日志. Downloads tab-local bounded request/stream metadata; no messages, keys, IPs or file names. Share only after reviewing. Cache token counts appear only when actually supplied by the provider.
