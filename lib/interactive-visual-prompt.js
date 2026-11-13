'use strict';

const { limits } = require('../public/interactive-visual-schema');

function buildInteractiveVisualPrompt(language) {
  const english = typeof language === 'string' && /^en(?:[-_]|$)/i.test(language);
  const examples = [
    { type: 'budget', title: english ? 'Travel budget' : '出行预算', unit: english ? 'CNY' : '元', budget: 1000, items: [{ label: english ? 'Transport' : '交通', value: 300 }] },
    { type: 'comparison', title: english ? 'Duration' : '耗时', unit: english ? 'hours' : '小时', items: [{ label: 'A', value: 2 }, { label: 'B', value: 3 }] },
    { type: 'checklist', title: english ? 'Preparation' : '准备清单', items: [{ label: english ? 'Confirm the time' : '确认时间', checked: false }] }
  ].map(spec => '```rai_visual\n' + JSON.stringify(spec) + '\n```').join('\n');
  const bounds = `${limits.maxItems}/${limits.maxTitleLength}/${limits.maxLabelLength}/${limits.maxUnitLength}`;
  return english
    ? `This Web client supports optional local interactive visuals. Use one proactively when adjusting a budget, comparing alternatives on ONE metric, or tracking a checklist helps the user's actual question; do not force visuals into every answer. Ordinary Markdown and Mermaid still work.
Use a standalone \`\`\`rai_visual fenced block containing one JSON object, with exactly the fields below. No HTML, JavaScript, URLs, extra fields, or nested visuals. Limits (items/title chars/label chars/unit chars): ${bounds}; at least one item and nonempty single-line text. Budget amounts: 0..${limits.maxValue}, at most 2 decimals. Comparison values: -${limits.maxValue}..${limits.maxValue}, at most 6 decimals. checked is a boolean.
Data must come from the user or verified results; explain its source and distinguish facts from assumptions in nearby prose. Ask for missing data instead of inventing values. Planning scenarios are not verified quotes. Comparisons must share one metric and unit; never sum independent alternatives. Controls stay local; confirmation only fills a draft, never sends or changes server conditions.
These are FORMAT EXAMPLES ONLY. Replace their titles, items and numbers with actual conversation data; do not copy them as a demo:
${examples}`
    : `此 Web 界面支持可选的本地交互可视化。预算调整、同一度量的选项比较、清单进度能帮助当前问题时可主动使用；不要每个回答都强行可视化。普通 Markdown 与已有 Mermaid 照常使用。
输出独立的 \`\`\`rai_visual 围栏代码块，内容是一个 JSON 对象，严格使用下方字段。不允许 HTML、JavaScript、URL、额外字段或嵌套可视化。上限（项目数/标题字数/项目名字数/单位字数）：${bounds}；至少一项，文字为非空单行。预算金额 0..${limits.maxValue}、最多两位小数；对比数值 -${limits.maxValue}..${limits.maxValue}、最多六位小数；checked 必须为布尔值。
数据必须来自用户或已核实结果，正文注明来源并区分事实和试算假设；缺少数据先询问，不要编造。计划值不是真实报价。对比必须是同一指标与单位，不能把独立选项相加。操作仅在本地生效，确认只填写草稿，不自动发送或提交服务器条件。
下方仅为格式示例，标题、项目和数值必须替换为实际对话数据，不要照搬成演示：
${examples}`;
}

module.exports = { buildInteractiveVisualPrompt };
