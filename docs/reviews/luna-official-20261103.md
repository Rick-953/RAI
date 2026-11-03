# Luna official allowance and usage verification

New clients and users without a saved model preference default to GPT 6 Luna with thinking disabled. Both Smart and thinking-off routing defaults select Luna with effort `none`, including requests that omit the model and reasoning fields. Existing saved user preferences and the explicit Thinking-mode default are preserved.

The official Luna allowance is **250,000 input plus output tokens per UTC day**. RAI keeps a 10,000-token safety margin, so admitted requests can reserve at most 240,000 tokens. Output reservations include the API maximum output, which also bounds reasoning tokens. A request is admitted only after the official input-token-count endpoint succeeds and a SQLite transaction reserves its full input plus maximum output. Concurrent requests, tool continuations and restarts share this ledger. Unknown consumption retains its reservation. The router uses the existing dedicated Luna gateway on failed admission or provider failure, and during the final 15 minutes before UTC reset.

The production key stays in a regular mode-0600 file outside source. Production always uses `https://api.openai.com/v1`; the relay receives its own existing credential. The official body exposes only RAI function tools. Search continues through the existing RAI `web_search` function, with no OpenAI hosted search tool. Encrypted reasoning is retained only within a request for tool continuation and is never written to the usage ledger.

The supplied project key can access Luna and the exact input-token-count endpoint. It cannot read organization-wide usage (HTTP 403). Therefore the local cap covers RAI, while other applications or models using the same organization-wide incentive pool must be covered by `RAI_OPENAI_LUNA_EXTERNAL_TOKEN_RESERVE`. The remaining allowance cannot be presented as a confirmed OpenAI organization balance.

## Historical estimate

The existing production message database and 30-day application journal contain no saved provider token counters. Exact historical daily token billing cannot be recovered. Saved messages were tokenized locally using `o200k_base` as an approximation, with up to 40 preceding saved user/assistant messages reconstructed for each answer. No historic chat content was sent to OpenAI for this estimate; the temporary private extraction was removed after calculation.

| Period, Asia/Shanghai, complete days | Saved model answers | Answers/day | Saved output and visible reasoning/day | Reconstructed saved input/day | Text-only estimate/day |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-10-27 through 2026-11-02 (7 days) | 81 | 11.6 | 5,495 | 4,339 | 9,835 |
| 2026-10-04 through 2026-11-02 (30 days) | 200 | 6.7 | 3,981 | 8,452 | 12,433 |

These estimates omit historical system prompts, function schemas, real tool-round inputs, attachment/image tokens, hidden reasoning that was not saved, retries, temporary or deleted conversations and other API consumers. They cannot establish actual billing or prove that the daily allowance covers the full service. The new ledger reports provider input/output counters, marks unmeasured calls, and computes averages only over complete UTC measurement days after the initial partial day.

## Validation

- Local tests cover concurrent admission, the 10,000-token margin, UTC reset, restart preservation, uncertain usage, external reserves, exact preflight count, fragmented/metadata-only SSE, Responses-to-Chat tool adaptation, retained reasoning, cancellation, failed admission and duplicate usage snapshots.
- Isolated Linux tests exercise authenticated RAI chat with mocked official Responses, persistent input/output counters, restricted administrator usage access and fallback to the existing Luna API when the official budget is full.
- Real official synthetic calls passed text output, a RAI `web_search` function request, and a continuation with retained reasoning. Reported input/output were respectively 10/5, 56/19 and 95/43 tokens; the last call included 36 reasoning tokens within its 43 output tokens. All are recorded in the same production budget, along with conservative reservations from interrupted probes.
- Browser tests verify that ordinary settings and settings search hide administration, the global shortcut has no effect, seven About-version taps reveal Developer options, and the entry still opens separate administrator authentication.

Official references: [Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna), [token counting](https://developers.openai.com/api/docs/guides/token-counting), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [reasoning](https://developers.openai.com/api/docs/guides/reasoning).
