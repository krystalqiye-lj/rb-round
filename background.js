importScripts('instructions-core.js');
chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !/^https:\/\/rubii\.ai\/(?:[a-z]{2}\/)?chat\//.test(tab.url || '')) {
    await chrome.action.setBadgeText({tabId: tab.id, text: '聊天页'});
    return;
  }
  try {
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['instructions.js']});
    await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', files: ['core.js', 'counter.js']});
    await chrome.action.setBadgeText({tabId: tab.id, text: ''});
  } catch {
    await chrome.action.setBadgeText({tabId: tab.id, text: '重试'});
  }
});

// Serialize mutations so two tabs do not overwrite each other's instructions.
let instructionQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !/^https:\/\/rubii\.ai\//.test(sender.url || '') || message?.area !== 'rubii-instructions') return;
  instructionQueue = instructionQueue.catch(() => {}).then(async () => {
    try {
      const saved = await chrome.storage.local.get('instructionsV1');
      let items = saved.instructionsV1 || [];
      if (!Array.isArray(items)) throw Error('指令数据格式异常，未覆盖原数据');
      if (message.action === 'import') {
        if (JSON.stringify(message.payload).length > 10 * 1024 * 1024) throw Error('JSON 文件过大，最多 10 MB');
        const parsed = RubiiInstructionsCore.parse(message.payload);
        const merged = RubiiInstructionsCore.merge(items, parsed.items, () => crypto.randomUUID(), Date.now());
        await chrome.storage.local.set({instructionsV1: merged.items});
        reply({ok:true, ...merged, skipped:parsed.skipped});
      } else if (message.action === 'save') {
        if (typeof message.title !== 'string' || typeof message.content !== 'string' || !message.content.trim()) throw Error('请输入指令内容');
        if (message.title.length > 120 || message.content.length > 50000) throw Error('标题最多 120 字，内容最多 50000 字');
        const index = items.findIndex(item => item.id === message.id);
        if (message.id && index < 0) throw Error('这条指令已被其他页面删除，请另存为新指令');
        if (index < 0 && items.length >= 1000) throw Error('最多保存 1000 条指令');
        const item = {id: index < 0 ? crypto.randomUUID() : items[index].id, title: message.title.trim() || '未命名指令', content: message.content, updated: Date.now()};
        items = [...items];
        if (index < 0) items.unshift(item); else items[index] = item;
        await chrome.storage.local.set({instructionsV1: items});
        reply({ok: true, items, id: item.id});
      } else if (message.action === 'delete') {
        items = items.filter(item => item.id !== message.id);
        await chrome.storage.local.set({instructionsV1: items});
        reply({ok: true, items});
      } else if (message.action === 'list') reply({ok: true, items});
      else throw Error('未知操作');
    } catch (error) { reply({ok: false, error: error.message || '保存失败'}); }
  });
  return true;
});
