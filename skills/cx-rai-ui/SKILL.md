---
name: cx-rai-ui
description: Native CX RAI controls, settings and platform limits.
---

# CX RAI UI
Native UWP client for Windows Phone/Windows 10/11; not the Web layout. Use control names instead of guessed coordinates.

- Main page: conversation sidebar, top conversation title, chat input. Open the settings entry for native category navigation; small screens navigate category pages rather than showing desktop columns.
- Settings categories: general, account, custom API, personalization, devices, notifications, desktop program, cache/storage, about. Developer/server options may be hidden. Use cxrai_setting(action=list) when available to discover exact supported settings; get before set, and respect SETTING_NOT_SUPPORTED.
- Desktop program: startup and Windows 11 visual effects. Windows 11 effects require a supported desktop build; Windows Phone does not have full-trust helper, tray or local desktop automation.
- Login: server URL and account controls, password/2FA or QR login. Use a trusted HTTPS server; compare the QR security code on the approving phone.
- Chat: attachments/images, model and thinking controls, local work-directory permissions where supported. Questions appear as choice buttons plus a text answer; wait for the active generation to finish before submitting. Tool rows expand for details.
- Shared Web link: cxrai://conversation opens an anonymous read-only snapshot. It neither imports the conversation nor executes its tools. Unsupported origins must be verified in the browser.
- Local computer mode is distinct from app settings: OS actions require explicit scope and client permission. Never turn an app setting request into a system change without clarifying scope.
- Availability differs by version; inspect an actual screenshot or exposed tools rather than inventing Web-only controls such as canvas or research panels.
