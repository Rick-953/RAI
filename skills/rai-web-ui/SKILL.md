---
name: rai-web-ui
description: RAI Web controls and settings by device.
---

# RAI Web UI
Determine desktop browser, mobile browser or installed Home Screen PWA from the current user-turn context; ask only if the distinction matters. Never guess a hidden control.

- Desktop: conversation list in the side panel; its footer gear opens Settings. Session ellipsis menu: rename, folders, pin, export, share/manage link, delete.
- Mobile: header sidebar button opens the conversation panel; use its footer Settings button. Model selector stays centered. Adaptive handedness can mirror sidebar/send/navigation controls; use labels instead of assuming left/right.
- Composer: plus menu contains attachment/tool controls; model/mode menu exposes model, thinking, internet and research choices. Sending changes to stop while generating. Thinking and tool summaries expand inline.
- Settings: account, security, subscription, language; general, capabilities, app, personalization, memory, notifications, advanced and about. Security handles passkeys/2FA/devices; general/customization holds appearance and adaptive handedness. Names may be localized. Read the actual screenshot or settings before claiming an exact toggle value.
- iOS PWA: Safari Share > Add to Home Screen; reopen using its icon. App content extends behind the home indicator, while buttons remain in the safe area. Browser chrome is not an in-app control.
- Login: password/email code, passkey, supported SSO, QR login. QR rotates every 3 seconds; scan in an authenticated browser, compare the code and explicitly approve.
- Sharing: session ellipsis > Share conversation / Manage link. Read-only text snapshot, 7-day expiry, revoke in the same dialog. Shared page attempts CX RAI activation; browser may require clicking the open button.
- Desktop-only local agent entries require a paired agent; mobile browsers cannot silently execute PC commands. Do not promise CX RAI parity for Web-only features.
