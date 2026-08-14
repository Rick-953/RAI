# RAI Connect

This GitHub release is installed as an unpacked Manifest V3 extension. The public manifest key fixes the extension ID to `clnmniaaodjmcgnemigghniekmahgcgi` in Chrome and Edge so Native Messaging remains bound across updates.

1. Run the RAI Local Agent installer for your operating system.
2. Open `chrome://extensions` or `edge://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension` directory printed by the installer.
4. Open RAI, then bind the device in **Settings > Capabilities > RAI Local Agent**.
5. Click the RAI Connect toolbar button. The side panel shows the current RAI
   conversation and can send messages through that logged-in RAI tab. Browser
   clicks, typing, scrolling, and navigation use the separate controlled tab;
   high-risk actions still require confirmation in the side panel.

The manifest key is public identity data, not a signing secret. This package is not a Chrome Web Store or Edge Add-ons listing.
