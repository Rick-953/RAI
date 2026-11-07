'use strict';

(function installMarkdownTableRepair(scope) {
  // Repair model-produced tables before Markdown parsing, while leaving code intact.
  function cells(line) {
    const output = [];
    let cell = '', ticks = 0;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '\\' && index + 1 < line.length) {
        cell += char + line[++index];
      } else if (char === '`') {
        let end = index;
        while (line[end + 1] === '`') end += 1;
        const count = end - index + 1;
        ticks = ticks === count ? 0 : (ticks || count);
        cell += line.slice(index, end + 1);
        index = end;
      } else if (char === '|' && !ticks) {
        output.push(cell.trim()); cell = '';
      } else cell += char;
    }
    output.push(cell.trim());
    if (!output[0]) output.shift();
    if (!output[output.length - 1]) output.pop();
    return output;
  }
  const separatorCell = value => /^:?-{3,}:?$/.test(value);
  const separator = line => {
    const value = cells(String(line || '').trim());
    return value.length >= 2 && value.every(separatorCell) ? value : null;
  };
  const row = value => '| ' + value.map(cell => cell.replace(/\\\||\|/g, token => token === '|' ? '\\|' : token)).join(' | ') + ' |';
  const separators = (source, width) => row(Array.from({ length: width }, (_, index) => source[index] || '---'));

  function normalize(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let fence = null;
    const before = () => { if (output.length && output[output.length - 1].trim()) output.push(''); };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
        output.push(line); continue;
      }
      if (fence || !line.includes('|')) { output.push(line); continue; }
      const header = cells(line);
      const sep = separator(lines[index + 1]);
      if (header.length >= 2 && sep && !header.every(separatorCell)) {
        before(); output.push(row(header), separators(sep, header.length)); index += 1;
        while (index + 1 < lines.length) {
          const candidate = lines[index + 1];
          if (!candidate.includes('|') || /^\s*(`{3,}|~{3,})/.test(candidate)) break;
          const values = cells(candidate);
          if (values.length !== header.length || separator(candidate)) break;
          output.push(row(values)); index += 1;
        }
        if (index + 1 < lines.length && lines[index + 1].trim()) output.push('');
        continue;
      }
      // A flattened table is identifiable by its embedded separator run. The
      // header determines width, including when the model omitted a separator.
      if (/^\s*\|/.test(line)) {
        const start = header.findIndex(separatorCell);
        let end = start;
        while (end >= 0 && end < header.length && separatorCell(header[end])) end += 1;
        if (start >= 2 && end - start >= 2 && header.length - end >= start) {
          const tail = header.slice(end);
          const fullRows = Math.floor(tail.length / start);
          const remainder = tail.slice(fullRows * start);
          // Only text after a final pipe may be prose following the table.
          const safeTail = remainder.length === 0 || (remainder.length === 1 && !/\|\s*$/.test(line));
          if (safeTail) {
            before(); output.push(row(header.slice(0, start)), separators(header.slice(start, end), start));
            for (let offset = 0; offset < fullRows * start; offset += start) output.push(row(tail.slice(offset, offset + start)));
            if (remainder.length) output.push('', remainder[0]);
            else if (index + 1 < lines.length && lines[index + 1].trim()) output.push('');
            continue;
          }
        }
      }
      output.push(line);
    }
    return output.join('\n');
  }
  scope.RaiMarkdownTables = Object.freeze({ normalize });
  if (typeof module === 'object' && module.exports) module.exports = scope.RaiMarkdownTables;
})(typeof window === 'object' ? window : globalThis);
