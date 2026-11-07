#!/usr/bin/env python3
"""Measure real streamed answer latency with synthetic prompts and server-only keys."""
import argparse
import json
import math
import os
import statistics
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


def sample(base_url, key, model, prompt, mode, overrides=None):
    body = {"model": model, "stream": True, "max_tokens": 64,
            "messages": [{"role": "system", "content": prompt},
                         {"role": "user", "content": "请用一句话说明怎样安排今天的工作。"}]}
    if model.startswith("deepseek"):
        body["thinking"] = {"type": "disabled"}
    else:
        body["reasoning_effort"] = mode
    body.update(overrides or {})
    request = urllib.request.Request(base_url.rstrip("/") + "/chat/completions",
                                    data=json.dumps(body).encode(),
                                    headers={"Authorization": "Bearer " + key,
                                             "Content-Type": "application/json"})
    start = time.perf_counter()
    result = {"ok": False, "thinking_requested": "disabled" if model.startswith("deepseek") else mode,
              "first_answer_s": None, "first_reasoning_s": None, "reasoning_chars": 0}
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            result["headers_s"] = round(time.perf_counter() - start, 4)
            result["http_status"] = response.status
            for raw in response:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if event.get("error"):
                    result["error_code"] = str(event["error"].get("code", "upstream_error"))[:80]
                    break
                result["response_model"] = event.get("model", result.get("response_model"))
                for choice in event.get("choices", []):
                    delta = choice.get("delta", {})
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
                    if reasoning:
                        result["reasoning_chars"] += len(reasoning)
                        if result["first_reasoning_s"] is None:
                            result["first_reasoning_s"] = round(time.perf_counter() - start, 4)
                    if delta.get("content") and result["first_answer_s"] is None:
                        result["first_answer_s"] = round(time.perf_counter() - start, 4)
                        result["ok"] = True
    except urllib.error.HTTPError as error:
        result["http_status"] = error.code
        result["error_code"] = "http_error"
        try:
            message = str(json.loads(error.read(4096)).get("error", {}).get("message", ""))
            result["error_message"] = message.replace(key, "[redacted]")[:220]
        except Exception:
            pass
    except Exception as error:
        result["error_code"] = type(error).__name__
    result["total_s"] = round(time.perf_counter() - start, 4)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xcm-key-file", required=True)
    parser.add_argument("--baseline-url", required=True)
    parser.add_argument("--baseline-key-file", required=True)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--diagnostics-only", action="store_true")
    parser.add_argument("--old-reasoning-none", action="store_true",
                        help="Use the old relay's effective DeepSeek no-thinking setting discovered by diagnostics")
    args = parser.parse_args()
    pid = subprocess.check_output(["systemctl", "show", "rai.service", "-p", "MainPID", "--value"], text=True).strip()
    env = dict(item.split("=", 1) for item in Path("/proc/" + pid + "/environ").read_text().split("\0") if "=" in item)

    def private_key(name):
        return Path(env[name + "_FILE"]).read_text().strip() if env.get(name + "_FILE") else env[name]

    old_key = Path(args.baseline_key_file).read_text().strip()
    xcm_key = Path(args.xcm_key_file).read_text().strip()
    gpt_key = private_key("RAI_GPT_GATEWAY_API_KEY")
    old_url = args.baseline_url
    gpt_url = env["RAI_GPT_GATEWAY_BASE_URL"]
    prompt = subprocess.check_output([os.readlink("/proc/" + pid + "/exe"), "-e", "process.stdout.write(require('./public/rai-system-prompt').buildEffectiveSystemPrompt({includeMemory:false}))"],
                                     cwd="/opt/rai/apps/formal", text=True)
    rows = []
    scenarios = [("short", "你是一个简洁的中文助手。"), ("rai_baseline", prompt)]
    if args.diagnostics_only:
        cases = [
            ("old_fast_enable_false", old_url, old_key, "deepseek-v4.1-flash", "disabled", {"enable_thinking": False}),
            ("old_fast_none", old_url, old_key, "deepseek-v4.1-flash", "disabled", {"reasoning_effort": "none"}),
            ("old_fast_template_false", old_url, old_key, "deepseek-v4.1-flash", "disabled", {"chat_template_kwargs": {"enable_thinking": False}}),
            ("new_xcm_1017", "https://xcmapi.org/v1", xcm_key, "deepseek-v4.1-flash-1017", "disabled", {}),
            ("old_fast_gpt_none", gpt_url, gpt_key, "gpt-6.1-sol", "none", {}),
            ("old_fast_luna_low", gpt_url, gpt_key, "gpt-6-luna", "low", {}),
        ]
        for name, url, key, model, mode, overrides in cases:
            for turn in range(3 if name in ["new_xcm_1017", "old_fast_luna_low"] else 1):
                row = {"provider": name, "round": turn + 1, "requested_model": model,
                       **sample(url, key, model, scenarios[0][1], mode, overrides)}
                print(json.dumps(row, ensure_ascii=False), flush=True)
        return
    for scenario, system in scenarios:
        for turn in range(args.rounds):
            providers = [("old_fast", old_url, old_key), ("new_xcm", "https://xcmapi.org/v1", xcm_key)]
            if turn % 2:
                providers.reverse()
            for name, url, key in providers:
                row = {"provider": name, "scenario": scenario, "round": turn + 1,
                       "requested_model": "deepseek-v4.1-flash", "system_chars": len(system),
                       "reasoning_effort_requested": "none" if args.old_reasoning_none and name == "old_fast" else None,
                       **sample(url, key, "deepseek-v4.1-flash", system, "disabled",
                                {"reasoning_effort": "none"} if args.old_reasoning_none and name == "old_fast" else None)}
                rows.append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)
    for mode in ["none", "low"]:
        for turn in range(1 if mode == "none" else 3):
            row = {"provider": "old_fast_gpt", "scenario": "short", "round": turn + 1,
                   "requested_model": "gpt-6.1-sol", **sample(gpt_url, gpt_key, "gpt-6.1-sol", scenarios[0][1], mode)}
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
    for scenario, _ in scenarios:
        for provider in ["old_fast", "new_xcm"]:
            group = [r for r in rows if r["provider"] == provider and r["scenario"] == scenario]
            times = sorted(r["first_answer_s"] for r in group if r["ok"] and not r["reasoning_chars"])
            summary = {"summary": True, "provider": provider, "scenario": scenario,
                       "samples": len(group), "successful_without_reasoning": len(times)}
            if times:
                summary.update(median_s=round(statistics.median(times), 4),
                               min_s=times[0], max_s=times[-1], p95_s=times[math.ceil(.95 * len(times)) - 1])
            print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
