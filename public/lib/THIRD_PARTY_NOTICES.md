# Vendored Web Dependencies

RAI serves these reviewed browser dependencies from `public/lib` so the application does not execute CDN-hosted code at runtime. Exact versions, npm package integrity values, upstream sources, licenses, file counts, SHA-256 tree digests, and local-to-upstream file mappings are recorded in `vendor-manifest.json`. The offline integrity gate verifies the committed tree; the networked provenance gate downloads each pinned official npm tarball, verifies its SHA-512 SRI, and requires every vendored byte to match its declared upstream file.

| Component | Version | License | Upstream |
|---|---:|---|---|
| Marked | 15.0.12 | MIT | <https://github.com/markedjs/marked/releases/tag/v15.0.12> |
| DOMPurify | 3.4.12 | Apache-2.0 OR MPL-2.0 | <https://github.com/cure53/DOMPurify/releases/tag/3.4.12> |
| @highlightjs/cdn-assets | 11.9.0 | BSD-3-Clause | <https://github.com/highlightjs/highlight.js/releases/tag/11.9.0> |
| KaTeX | 0.16.47 | MIT | <https://github.com/KaTeX/KaTeX/releases/tag/v0.16.47> |

The complete upstream license texts shipped by these exact packages are included under `public/lib/licenses/` and are covered by the same integrity manifest.

Mermaid rendering is intentionally disabled in v0.11.41. The previously vendored Mermaid 11.15.0 UMD bundle contained a large hidden dependency closure, including OSV-flagged DOMPurify 3.4.0 and js-yaml 4.1.1, that could not be represented by the old top-level-only SBOM. Mermaid source is displayed as a normal code block until RAI has a reproducible build whose complete dependency closure passes the release scanner.
