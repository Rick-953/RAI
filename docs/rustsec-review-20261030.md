# RustSec exception review - 2026-10-30

This is an explicit, time-bounded review of the existing **17** RustSec exceptions, not a zero-vulnerability claim. The separate block-buffer version-scope exception is unchanged and still expires on November 11.

The scope is RAI Tauri desktop, especially the Linux GTK3/WebKitGTK graph; it is not the CX RAI UWP binary or the production Node Web process. The checked-in graph pins Tauri 2.12.1. The current upstream Tauri 2.12.5 release still builds GTK 0.18.2 and glib 0.18.5, as shown in its [published build log](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.12.5). The old statement that Tauri 2.11.2 is latest was stale and is removed.

## Decisions

- 5 obsolete ignores are removed because their packages no longer exist in Cargo.lock. 11 retained entries are unmaintained-crate advisories without a patched version in current OSV metadata. These are maintenance risks, not proof of an exploitable defect or proof of safety.
- RUSTSEC-2024-0429 is a real glib iterator soundness advisory. OSV fixes it in 0.20.0, but the GTK3 dependency graph requires glib 0.18. A forced cross-major override is not a compatible remediation. RAI Rust sources do not directly use VariantStrIter, but indirect dependency reachability is not claimed absent.
- Retain only 12 existing, present-package IDs until **2026-11-30**, a 31-day window, with per-advisory package/version and a concrete root-to-dependency path in the JSON review. No unrelated ignore is added.
- Re-review when the Tauri/affected graph changes or a compatible fix/replacement appears. Prefer removing an exception when a patched compatible graph exists; migrate from GTK3 when upstream supports it. Do not fork or replace the GUI stack merely to silence the scanner.
- CI verifies every ignore against this review, its actual locked dependency path, and its deadline. OSV, RustSec, npm audit, CodeQL and the independent CodeQL check remain enabled.

| Advisory | Locked package | Class | Dependency path |
| --- | --- | --- | --- |
| [RUSTSEC-2024-0429](https://osv.dev/vulnerability/RUSTSEC-2024-0429) | glib 0.18.5 | unsound-api | rai_desktop@0.11.43 -> tauri@2.12.1 -> gtk@0.18.2 -> glib@0.18.5 |
| [RUSTSEC-2024-0411](https://osv.dev/vulnerability/RUSTSEC-2024-0411) | gdkwayland-sys 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> tauri-runtime-wry@2.12.1 -> tao@0.37.1 -> gdkwayland-sys@0.18.2 |
| [RUSTSEC-2024-0412](https://osv.dev/vulnerability/RUSTSEC-2024-0412) | gdk 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> gtk@0.18.2 -> gdk@0.18.2 |
| [RUSTSEC-2024-0413](https://osv.dev/vulnerability/RUSTSEC-2024-0413) | atk 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> gtk@0.18.2 -> atk@0.18.2 |
| [RUSTSEC-2024-0414](https://osv.dev/vulnerability/RUSTSEC-2024-0414) | gdkx11-sys 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> tauri-runtime-wry@2.12.1 -> tao@0.37.1 -> gdkx11-sys@0.18.2 |
| [RUSTSEC-2024-0415](https://osv.dev/vulnerability/RUSTSEC-2024-0415) | gtk 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> gtk@0.18.2 |
| [RUSTSEC-2024-0416](https://osv.dev/vulnerability/RUSTSEC-2024-0416) | atk-sys 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> gtk@0.18.2 -> atk@0.18.2 -> atk-sys@0.18.2 |
| [RUSTSEC-2024-0417](https://osv.dev/vulnerability/RUSTSEC-2024-0417) | gdkx11 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> tauri-runtime-wry@2.12.1 -> wry@0.57.0 -> gdkx11@0.18.2 |
| [RUSTSEC-2024-0418](https://osv.dev/vulnerability/RUSTSEC-2024-0418) | gdk-sys 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> webkit2gtk@2.0.2 -> gdk-sys@0.18.2 |
| [RUSTSEC-2024-0419](https://osv.dev/vulnerability/RUSTSEC-2024-0419) | gtk3-macros 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> gtk@0.18.2 -> gtk3-macros@0.18.2 |
| [RUSTSEC-2024-0420](https://osv.dev/vulnerability/RUSTSEC-2024-0420) | gtk-sys 0.18.2 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> gtk@0.18.2 -> gtk-sys@0.18.2 |
| [RUSTSEC-2024-0370](https://osv.dev/vulnerability/RUSTSEC-2024-0370) | proc-macro-error 1.0.4 | unmaintained | rai_desktop@0.11.43 -> tauri@2.12.1 -> gtk@0.18.2 -> gtk3-macros@0.18.2 -> proc-macro-error@1.0.4 |

## Removed obsolete exceptions

- RUSTSEC-2025-0075: unic-char-range is absent from the current lockfile.
- RUSTSEC-2025-0080: unic-common is absent from the current lockfile.
- RUSTSEC-2025-0081: unic-char-property is absent from the current lockfile.
- RUSTSEC-2025-0098: unic-ucd-version is absent from the current lockfile.
- RUSTSEC-2025-0100: unic-ucd-ident is absent from the current lockfile.

## Evidence and limitations

The accompanying JSON records current OSV advisory modification dates, fixed-version metadata, the reviewed Cargo.lock digest, and explicit dispositions. The lock graph is static evidence, not a Linux device exercise, Miri proof, complete transitive API audit, or an assertion that suppressed advisories are fixed. The risk remains visible and expires rather than being silently accepted forever.
