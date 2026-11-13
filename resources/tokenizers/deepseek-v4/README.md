# DeepSeek V4 tokenizer

The tokenizer and configuration are copied without modification from the official
`deepseek-ai/DeepSeek-V4-Flash` model repository at revision
`60d8d70770c6776ff598c94bb586a859a38244f1`. The repository metadata declares `mit`;
the accompanying `LICENSE` is the upstream MIT license, copyright DeepSeek.

| File | SHA-256 |
| --- | --- |
| tokenizer.json | `8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf` |
| tokenizer_config.json | `6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547` |
| LICENSE | `f2c6c602815669d292889e5be8c802f2ed950653b77999b1584e8e6aed25d040` |

Sources:

- https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/tree/60d8d70770c6776ff598c94bb586a859a38244f1
- https://api-docs.deepseek.com/quick_start/token_usage

The official documentation links a V4 tokenizer ZIP. Its BPE vocabulary, merges,
normalizer and pre-tokenizer match this model repository; its older special-token
metadata and configuration differ. The files here use the model repository's
configuration, which declares a 1,048,576-token model length.

`lib/deepseek-tokenizer.js` uses `@huggingface/tokenizers` 0.2.0 to tokenize each
string in messages, tool calls, tool schemas and response schemas. It counts JSON
framing separately so newline escaping does not inflate the source text. It adds
32 tokens per message and the existing 16,384-token media reserve. The surrounding
context policy also retains its output reserve and 8,192-token safety margin.
This is a tokenizer-based estimate of the API input, not the provider's exact
message-envelope count; returned API usage remains the source of truth.

Synthetic live calibration on 2026-11-07 used the configured DeepSeek V4.1 Flash
relay. The official endpoint returned HTTP 402, so official-route equivalence was
not verified. No conversation data was used.

| Synthetic request | Estimate | Reported prompt tokens |
| --- | ---: | ---: |
| 30,000 characters of Chinese text and newlines (80,000 UTF-8 bytes) | 15,054 | 15,004 |
| Chinese JSON result, function schema and one completed tool exchange | 1,946 | 1,702 |
| Three completed tool exchanges with Chinese, Markdown and JSON results | 3,449 | 3,059 |

The estimate exceeded reported usage by 50, 244 and 390 tokens respectively, before
the context policy's separate safety and output reserves. These fixtures verify
the real vocabulary and full request fields without claiming that a relay's
unpublished envelope is identical to the official API.
