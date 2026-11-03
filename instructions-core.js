(() => {
  'use strict';
  function parse(payload) {
    let entries;
    if (Array.isArray(payload)) entries = payload;
    else if (payload && typeof payload === 'object' && payload.entries && typeof payload.entries === 'object') entries = Array.isArray(payload.entries) ? payload.entries : Object.values(payload.entries);
    else if (Array.isArray(payload?.instructions)) entries = payload.instructions;
    else throw Error('未识别 JSON 格式：需要 entries 世界书或标题、内容组成的数组');
    if (entries.length > 1000) throw Error('一个文件最多导入 1000 条');
    const items = []; let skipped = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string' || !entry.content.trim()) { skipped++; continue; }
      const title = [entry.title, entry.comment, entry.name].find(v => typeof v === 'string' && v.trim())?.trim() || '未命名指令';
      if (title.length > 120 || entry.content.length > 50000) throw Error('某条标题超过 120 字或内容超过 50000 字，未导入任何条目');
      items.push({title, content: entry.content});
    }
    if (!items.length) throw Error('文件中没有可导入的指令内容');
    return {items, skipped};
  }
  function merge(existing, incoming, makeId, now) {
    const keys = new Set(existing.map(item => JSON.stringify([item.title,item.content])));
    const additions = []; let duplicates = 0;
    for (const item of incoming) {
      const key = JSON.stringify([item.title,item.content]);
      if (keys.has(key)) { duplicates++; continue; }
      keys.add(key);additions.push({id:makeId(), title:item.title, content:item.content, updated:now});
    }
    if (existing.length + additions.length > 1000) throw Error('导入后超过 1000 条，未写入任何条目');
    return {items:[...additions,...existing], added:additions.length, duplicates};
  }
  const api={parse,merge};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  else globalThis.RubiiInstructionsCore=api;
})();
