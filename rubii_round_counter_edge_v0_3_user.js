// ==UserScript==
// @name         Rubii 会话轮数与指令区 (Edge 电脑/安卓/iOS 通用版)
// @namespace    https://rubii.ai/
// @version      0.3.0
// @description  Rubii 历史会话轮数、认识天数与本地指令管理，支持世界书 JSON 导入。适配 Edge 电脑端、安卓版与 iOS 版（Tampermonkey / Violentmonkey / ScriptCat）。
// @match        https://rubii.ai/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (location.origin !== 'https://rubii.ai' || pageWindow.__rubiiUserscriptLoaded) return;
  pageWindow.__rubiiUserscriptLoaded = true;

  // --- 1. Core Round Counter Logic ---
  (() => {
  'use strict';
  const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(v);
  function sessions(payload, moment) {
    if (payload?.code !== 200 || !Array.isArray(payload.data)) throw Error('历史列表结构不匹配');
    if (payload.detail != null) throw Error('历史列表包含尚未适配的附加信息，未宣称完整');
    const map = new Map();
    for (const row of payload.data) {
      if (!id(row?.session_id) || row.moment_id !== moment || !id(row.character_id)) throw Error('会话标识或聊天卡不匹配');
      const previous = map.get(row.session_id);
      if (previous && previous.character_id !== row.character_id) throw Error('重复会话的角色标识冲突');
      map.set(row.session_id, row);
    }
    if (new Set([...map.values()].map(r=>r.character_id)).size > 1) throw Error('列表含多个角色，无法作为单角色合计');
    return [...map.values()];
  }
  function count(payload, session) {
    if (payload?.code !== 200 || !Array.isArray(payload.data)) throw Error('消息响应结构不匹配');
    const groups = new Map(), messages = new Map(), issues = new Set();
    let firstCreated = null;
    if (payload.detail != null) issues.add('存在尚未适配的附加或分页信息');
    for (const m of payload.data) {
      if (m?.session_id !== session) throw Error('消息所属会话不匹配');
      const created = typeof m.created_at === 'string' ? Date.parse(m.created_at) : NaN;
      if (Number.isFinite(created) && created <= Date.now() && (firstCreated === null || created < firstCreated)) firstCreated = created;
      if (!id(m.round_id) || !['user', 'ai'].includes(m.role)) { issues.add('存在无轮标识或未知身份的消息'); continue; }
      const messageId = m.message_id || m._id;
      if (!id(messageId)) { issues.add('存在无消息标识的记录'); continue; }
      if (messages.has(messageId)) {
        const prior = messages.get(messageId);
        if (prior.round_id !== m.round_id || prior.role !== m.role) issues.add('重复消息标识冲突');
        continue;
      }
      messages.set(messageId, m);
      const g = groups.get(m.round_id) || {user: 0, ai: 0};
      g[m.role]++;
      groups.set(m.round_id, g);
      if (m.status != null && m.status !== '') issues.add('存在带状态的消息，需核对');
      if (m.active_response_id || m.response_group_id || (m.response_variants != null && (!Array.isArray(m.response_variants) || m.response_variants.length))) issues.add('含重生成或分支信息，按轮标识去重，口径待核对');
    }
    let rounds = 0, pending = 0;
    for (const g of groups.values()) {
      if (g.user && g.ai) rounds++;
      else if (g.user) pending++;
      else issues.add('存在没有对应用户消息的回复');
      if (g.user > 1 || g.ai > 1) issues.add('同轮包含多条消息，口径待核对');
    }
    return {rounds, pending, messages: messages.size, issues: [...issues], firstCreated, updated: Date.now()};
  }
  function daysSince(first, now = Date.now()) {
    if (!Number.isFinite(first) || first > now) return null;
    const day = value => { const d = new Date(value); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
    return Math.floor((day(now) - day(first)) / 86400000) + 1;
  }
  const api = {id, sessions, count, daysSince};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.__rubiiRoundCore = api;
})();
  const core = window.__rubiiRoundCore || pageWindow.__rubiiRoundCore;
  pageWindow.__rubiiRoundCore = core;

  // --- 2. Instructions Core Parser & Merger ---
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
  const instCore = globalThis.RubiiInstructionsCore;

  // --- 3. Local Storage Adapter (GM_storage with localStorage fallback) ---
  const STORAGE_KEY = 'instructionsV1';
  const FALLBACK_KEY = '__rubii_instructions_v1__';
  const makeUuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

  function readStorage() {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(STORAGE_KEY, null);
        if (val !== null && val !== undefined) return typeof val === 'string' ? JSON.parse(val) : val;
      }
    } catch {}
    try {
      const raw = localStorage.getItem(FALLBACK_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function writeStorage(items) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_KEY, items);
      }
    } catch {}
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(items));
    } catch {}
  }

  let instructionQueue = Promise.resolve();
  function handleInstructionAction(message) {
    const p = instructionQueue.catch(() => {}).then(async () => {
      let items = readStorage();
      if (!Array.isArray(items)) throw Error('指令数据格式异常，未覆盖原数据');
      if (message.action === 'import') {
        if (JSON.stringify(message.payload).length > 10 * 1024 * 1024) throw Error('JSON 文件过大，最多 10 MB');
        const parsed = instCore.parse(message.payload);
        const merged = instCore.merge(items, parsed.items, makeUuid, Date.now());
        writeStorage(merged.items);
        return {ok: true, ...merged, skipped: parsed.skipped};
      } else if (message.action === 'save') {
        if (typeof message.title !== 'string' || typeof message.content !== 'string' || !message.content.trim()) throw Error('请输入指令内容');
        if (message.title.length > 120 || message.content.length > 50000) throw Error('标题最多 120 字，内容最多 50000 字');
        const index = items.findIndex(item => item.id === message.id);
        if (message.id && index < 0) throw Error('这条指令已被其他页面删除，请另存为新指令');
        if (index < 0 && items.length >= 1000) throw Error('最多保存 1000 条指令');
        const item = {id: index < 0 ? makeUuid() : items[index].id, title: message.title.trim() || '未命名指令', content: message.content, updated: Date.now()};
        items = [...items];
        if (index < 0) items.unshift(item); else items[index] = item;
        writeStorage(items);
        return {ok: true, items, id: item.id};
      } else if (message.action === 'delete') {
        items = items.filter(item => item.id !== message.id);
        writeStorage(items);
        return {ok: true, items};
      } else if (message.action === 'list') {
        return {ok: true, items};
      } else {
        throw Error('未知操作');
      }
    });
    instructionQueue = p;
    return p;
  }

  // --- 4. Instructions UI ---
  (() => {
    const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    let items = [], editing = null, dirty = false, saving = false, loaded = false;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:18px;top:90px;z-index:2147483647;font:14px/1.6 system-ui,sans-serif;color:#252331';
    const root = host.attachShadow({mode:'closed'});
    root.innerHTML = `<style>
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    section{width:380px;max-width:calc(100vw - 24px);max-height:76vh;overflow:auto;-webkit-overflow-scrolling:touch;padding:20px;background:#fffefa;border:1px solid #e4dfe9;border-radius:18px;box-shadow:0 14px 60px #21152d40}
    header,.line,.actions{display:flex;gap:8px;align-items:center;justify-content:space-between}
    h2{font-size:18px;margin:0}
    button,input,textarea{font:inherit}
    button{border:0;border-radius:8px;padding:7px 10px;background:#f0ebf6;color:#30233d;cursor:pointer;touch-action:manipulation}
    button:disabled{opacity:.45;cursor:default}
    .primary{background:#655080;color:white}
    .danger{color:#a22b3b;background:#fceef0}
    input,textarea{width:100%;padding:9px;border:1px solid #ddd5e3;border-radius:8px;background:white;color:#252331}
    textarea{resize:vertical;min-height:150px;line-height:1.6}
    input:focus,textarea:focus{outline:2px solid #b9a3ce}
    label{display:block;margin:10px 0 5px}
    .muted{font-size:12px;color:#77717d}
    #status{margin:8px 0;min-height:22px;white-space:pre-wrap}
    .card{border-top:1px solid #e9e2ed;padding:12px 0}
    .title{font-weight:650;overflow-wrap:anywhere}
    .preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:66px;overflow:hidden;color:#77717d;font-size:12px;margin:5px 0 9px}
    .actions{justify-content:flex-start;flex-wrap:wrap}
    #editor{padding:12px;background:#f7f3fa;border-radius:10px;margin-top:12px}
    .hint{margin:8px 0}
    #query{margin:8px 0}
    @media (max-width: 600px){
      section{width:calc(100vw - 24px);max-height:78vh;padding:16px;border-radius:16px}
      input,textarea{font-size:16px}
    }
    </style><section hidden><header><h2>我的指令</h2><div class="actions"><button id="counter">轮数统计</button><button id="close" title="收起">−</button></div></header><p class="muted hint">保存在本机浏览器。复制后自行粘贴，不会自动发送。</p><div class="line"><button id="new" class="primary">＋ 新增指令</button><span id="count" class="muted"></span></div><div id="status" role="status"></div><div id="editor" hidden><strong id="heading">新增指令</strong><label for="title">标题</label><input id="title" maxlength="120" placeholder="例如：总结剧情"><label for="content">指令内容</label><textarea id="content" maxlength="50000" placeholder="输入你的指令…"></textarea><div class="actions" style="margin-top:10px"><button id="save" class="primary">保存</button><button id="cancel">取消</button></div></div><input id="query" placeholder="搜索标题或内容" aria-label="搜索指令"><div id="list"></div></section>`;
    document.documentElement.append(host);
    const $ = s => root.querySelector(s);
    function syncHostPosition() {
      host.style.right = isMobile() ? '12px' : '18px';
      host.style.top = isMobile() ? '72px' : '90px';
    }
    syncHostPosition();
    window.addEventListener('resize', syncHostPosition);
    function el(tag, text, cls) { const node=document.createElement(tag);node.textContent=text;if(cls)node.className=cls;return node; }
    function status(text) { $('#status').textContent=text; }
    async function request(action, values={}) {
      return await handleInstructionAction({action, ...values});
    }
    function discard() { return !dirty || confirm('指令尚未保存，放弃这次修改？'); }
    function editor(item) {
      if(saving || !discard())return;
      editing=item?.id || null;dirty=false;
      $('#heading').textContent=item?'编辑指令':'新增指令';
      $('#title').value=item?.title || '';$('#content').value=item?.content || '';
      $('#editor').hidden=false;$('#title').focus();status('');
    }
    function closeEditor() { editing=null;dirty=false;$('#editor').hidden=true;$('#title').value='';$('#content').value=''; }
    async function writeClip(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        ta.remove();
        if (!ok) throw Error('copy failed');
      }
    }
    async function copy(item,button) {
      try {
        await writeClip(item.content);
        button.textContent='已复制';status(`已复制「${item.title}」`);
        setTimeout(()=>{button.textContent='复制';},1500);
      } catch { status('复制未成功。点「编辑」，选中内容后手动复制。'); }
    }
    function render() {
      $('#count').textContent=`${items.length} 条指令`;
      $('#new').disabled=!loaded || saving;$('#save').disabled=saving;$('#cancel').disabled=saving;$('#title').disabled=saving;$('#content').disabled=saving;
      $('#list').replaceChildren();
      const query=$('#query').value.trim().toLowerCase();
      const filtered=items.filter(item=>`${item.title}\n${item.content}`.toLowerCase().includes(query));
      if(!filtered.length)$('#list').append(el('p',items.length?'没有匹配的指令':'还没有指令，点击「新增指令」开始。','muted'));
      for(const item of filtered){
        const card=el('div','','card');card.append(el('div',item.title,'title'),el('div',item.content.slice(0,180),'preview'));
        const actions=el('div','','actions'), cp=el('button','复制'), edit=el('button','编辑'), del=el('button','删除','danger');
        cp.onclick=()=>copy(item,cp);edit.onclick=()=>editor(item);
        edit.disabled=saving;del.disabled=saving;
        del.onclick=async()=>{
          if(saving || !confirm(`删除「${item.title}」？此操作无法撤销。`))return;
          saving=true;render();
          try{const response=await request('delete',{id:item.id});items=response.items;if(editing===item.id)closeEditor();status('已删除指令');}
          catch(error){status(error.message);}
          finally{saving=false;render();}
        };
        actions.append(cp,edit,del);card.append(actions);$('#list').append(card);
      }
    }
    $('#new').onclick=()=>editor(null);
    $('#cancel').onclick=()=>{if(discard()){closeEditor();status('');}};
    $('#title').oninput=$('#content').oninput=()=>{dirty=true;};
    $('#query').oninput=render;
    const importButton=el('button','导入 JSON');
    const file=document.createElement('input');file.type='file';file.accept='.json,application/json';file.hidden=true;
    $('#new').after(importButton);root.append(file);
    importButton.onclick=()=>{if(!loaded){status('指令正在加载，请稍后重试');return;}if(!saving)file.click();};
    file.onchange=async()=>{
      const selected=file.files?.[0];if(!selected)return;
      if(saving || !loaded){file.value='';return;}
      saving=true;importButton.disabled=true;render();status('正在导入…');
      try{
        if(selected.size>10*1024*1024)throw Error('文件最大支持 10 MB');
        let payload;
        try{payload=JSON.parse((await selected.text()).replace(/^\uFEFF/,''));}catch{throw Error('JSON 格式不正确，未导入');}
        const response=await request('import',{payload});items=response.items;
        status(`导入 ${response.added} 条；跳过 ${response.duplicates} 条重复、${response.skipped} 条空内容。`);
      }catch(error){status(error.message);}
      finally{saving=false;importButton.disabled=false;file.value='';render();}
    };
    $('#save').onclick=async()=>{
      if(saving)return;
      if(!$('#content').value.trim()){status('请输入指令内容');$('#content').focus();return;}
      saving=true;render();
      try{const response=await request('save',{id:editing,title:$('#title').value,content:$('#content').value});items=response.items;closeEditor();status('已保存到本机');}
      catch(error){status(error.message);}
      finally{saving=false;render();}
    };
    $('#close').onclick=()=>{$('section').hidden=true;document.dispatchEvent(new Event('rubii-minimize-counter'));};
    $('#counter').onclick=()=>{$('section').hidden=true;document.dispatchEvent(new Event('rubii-open-counter'));};
    document.addEventListener('rubii-close-commands',()=>{$('section').hidden=true;});
    document.addEventListener('rubii-open-commands',()=>{$('section').hidden=false;});
    window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
    request('list').then(response=>{items=response.items;loaded=true;render();}).catch(error=>status(error.message));
    render();
  })();

  // --- 5. Round Counter UI & Fetch Hook (runs on pageWindow) ---
  (() => {
    const nativeFetch = pageWindow.fetch;
    const original = nativeFetch.bind(pageWindow);
    const isChatPath = () => /^\/(?:[a-z]{2}\/)?chat\//.test(location.pathname);
    const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    let auth = '', rows = [], results = new Map(), listURL = '', busy = false, controller;
    let currentPath = location.pathname, currentSession = new URL(location.href).searchParams.get('sessionId'), generation = 0, listVersion = 0;
    let status = '先打开网站的「历史对话」，让插件识别会话列表。';
    let updated = 0, observing = true;
    const host = document.createElement('div');
    host.id = 'rubii-round-counter';
    host.style.cssText = 'position:fixed;right:18px;top:90px;z-index:2147483647;font:14px/1.6 system-ui,sans-serif;color:#252331';
    const shadow = host.attachShadow({mode:'closed'});
    shadow.innerHTML = `<style>
      *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
      section{width:360px;max-width:calc(100vw - 24px);max-height:76vh;overflow:auto;-webkit-overflow-scrolling:touch;background:#fffefa;border:1px solid #e4dfe9;border-radius:18px;box-shadow:0 14px 60px #21152d40;padding:20px}
      header{display:flex;align-items:center;justify-content:space-between;gap:8px}
      h2{font-size:18px;margin:0}
      button{font:inherit;cursor:pointer;border:0;border-radius:9px;padding:8px 12px;background:#f0ebf6;color:#30233d;touch-action:manipulation}
      button:disabled{opacity:.45;cursor:default}
      .primary{background:#655080;color:white}
      p{margin:10px 0}
      .muted{color:#77717d;font-size:12px}
      .sum{font-size:26px;font-weight:700;line-height:1.3;margin:14px 0}
      .actions{display:flex;gap:7px;flex-wrap:wrap}
      .row{padding:10px 0;border-top:1px solid #eee8ee}
      .line{display:flex;justify-content:space-between;gap:10px}
      .number{font-weight:700;color:#60447a;white-space:nowrap}
      a{color:#665080}
      details{font-size:12px;color:#77717d;margin-top:14px}
      #mini{display:none;background:#655080;color:#fff;font-weight:600;padding:8px 14px;border-radius:999px;box-shadow:0 6px 20px #21152d38}
      #status{white-space:pre-wrap}
      input{width:100%;font:inherit;border:1px solid #ddd5e3;border-radius:8px;padding:7px;margin:12px 0 5px}
      @media (max-width: 600px){
        section{width:calc(100vw - 24px);max-height:78vh;padding:16px;border-radius:16px}
        input{font-size:16px}
        .sum{font-size:22px;margin:10px 0}
      }
      </style><button id="mini">轮数统计</button><section><div id="days" style="font-size:19px;font-weight:700;margin-bottom:6px"></div><div id="days-note" class="muted" style="margin-bottom:14px"></div><header><h2>Rubii 会话轮数</h2><div class="actions"><button id="commands">指令区</button><button id="hide" title="收起">−</button></div></header><p id="scope" class="muted"></p><div id="sum" class="sum">等待会话列表</div><p id="status" role="status"></p><div class="actions"><button id="scan" class="primary">统计全部会话</button><button id="stop">停止</button></div><input id="search" placeholder="搜索会话编号或日期" aria-label="搜索会话"><div id="rows"></div><details><summary>统计范围与隐私</summary><p>统计当前聊天卡「历史对话」接口返回的独立会话，按 session_id 去重。可能不涵盖同角色的其他聊天卡。没有读取手动存档，因此不会将存档再累加一次。</p><p>每轮必须有相同 round_id 的用户消息及角色回复；未回复的用户消息单列。开场白不按正文猜测。重生成、分支等异常另作提示。</p><p>结果是已返回记录的统计，不保证平台没有截断。38 轮样本已与平台存档交叉核对，其他边界口径尚待核对。</p><p>仅在本页内存处理。聊天正文、登录凭据和数字均不写入扩展存储，不上传其他服务。点击统计后，逐段读取 Rubii 已核实的只读会话接口。</p><button id="disable">停用本页统计</button></details></section>`;
    document.documentElement.append(host);
    const $ = selector => shadow.querySelector(selector);
    function syncHostPosition() {
      host.style.right = isMobile() ? '12px' : '18px';
      host.style.top = isMobile() ? '72px' : '90px';
    }
    syncHostPosition();
    window.addEventListener('resize', syncHostPosition);
    function moment() { return location.pathname.match(/\/chat\/[^/]*__([a-zA-Z0-9_-]+)$/)?.[1] || ''; }
    function make(tag, text, cls) { const n=document.createElement(tag); n.textContent=text; if(cls)n.className=cls; return n; }
    const date = v => { const d=new Date(v); return Number.isNaN(+d) ? '时间未知' : d.toLocaleString(); };
    function sameContext() { return observing && currentPath === location.pathname && currentSession === new URL(location.href).searchParams.get('sessionId'); }
    function cleanBadges() { document.querySelectorAll('[data-rubii-round-badge]').forEach(n=>n.remove()); }
    function resultLabel(r) {
      if (!r) return '待统计';
      if (r.error) return '读取失败';
      return `${r.issues.length ? '已读 ' : ''}${r.rounds} 轮${r.pending ? ` · ${r.pending} 条待回复` : ''}${r.stale ? ' · 待刷新' : ''}`;
    }
    function render() {
      host.style.display = isChatPath() ? 'block' : 'none';
      const good=[...results.values()].filter(r=>!r.error);
      const total=good.reduce((n,r)=>n+r.rounds,0);
      $('#scope').textContent = `当前聊天卡 · ${rows[0]?.character_name || decodeURIComponent(location.pathname.split('/').pop() || '').split('__')[0]} · ${rows.length} 段会话`;
      $('#sum').textContent = rows.length ? `已读合计 ${total} 轮` : '等待会话列表';
      $('#status').textContent = `${status}${updated ? `\n读取时间：${date(updated)}` : ''}`;
      $('#scan').disabled=busy || !rows.length;
      $('#stop').disabled=!busy;
      const name = rows[0]?.character_name || decodeURIComponent(location.pathname.split('/').pop() || '').split('__')[0];
      const times = good.map(r=>r.firstCreated).filter(Number.isFinite);
      const days = times.length ? core.daysSince(Math.min(...times)) : null;
      $('#days').textContent = days === null ? `和${name}的认识天数：待读取` : `和${name}认识已经 ${days} 天了`;
      const complete = rows.length > 0 && good.length === rows.length && good.every(r=>Number.isFinite(r.firstCreated) && !r.stale);
      $('#days-note').textContent = days === null ? '统计后按可读取的最早会话记录计算' : `${complete ? '' : '尚未读全或数据待刷新 · '}按当前聊天卡可读取的最早记录计算 · ${date(Math.min(...times))}`;
      const query=$('#search').value.toLowerCase();
      $('#rows').replaceChildren();
      rows.forEach((row,i)=>{
        const r=results.get(row.session_id), title=`会话 ${i+1} · ${date(row.last_response_at)}`;
        if(query && !`${title} ${row.session_id}`.toLowerCase().includes(query))return;
        const div=make('div','','row'), line=make('div','','line');
        const a=make('a',title); const u=new URL(location.href);u.searchParams.set('sessionId',row.session_id);a.href=u.href;
        line.append(a,make('span',resultLabel(r),'number')); div.append(line,make('div',row.session_id,'muted'));
        if(r?.error)div.append(make('div',r.error,'muted'));
        if(r?.issues?.length)div.append(make('div',r.issues.join('；'),'muted'));
        $('#rows').append(div);
      });
      scheduleBadges();
    }
    function badges() {
      cleanBadges();
      if(!sameContext() || !isChatPath())return;
      const heading=[...document.querySelectorAll('h2')].find(n=>n.textContent.trim()==='历史对话');
      if(!heading)return;
      let root=heading.parentElement;
      for(let i=0;i<5 && root && !root.textContent.includes('批量管理');i++)root=root.parentElement;
      if(!root || !root.textContent.includes('批量管理'))return;
      for(let i=0;i<3 && root.parentElement && rows.length && !root.textContent.includes(rows[0].last_query);i++)root=root.parentElement;
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT), nodes=[];
      while(walker.nextNode())nodes.push(walker.currentNode);
      const used=new Set();
      for(const row of rows){
        if(!row.last_query || !row.last_response)continue;
        const matches=nodes.filter(n=>n.nodeValue.trim()===row.last_query.trim());
        if(matches.length!==1)continue;
        let card=matches[0].parentElement;
        const excerpt=row.last_response.trim().slice(0,60).replace(/\s+/g,'');
        for(let i=0;i<6 && card && !card.textContent.replace(/\s+/g,'').includes(excerpt);i++)card=card.parentElement;
        if(!card || card===root || card.contains(heading) || used.has(card) || !card.textContent.replace(/\s+/g,'').includes(excerpt))continue;
        const badge=make('span',`轮数统计：${resultLabel(results.get(row.session_id))}`);
        badge.dataset.rubiiRoundBadge=row.session_id;
        badge.style.cssText='display:block;width:fit-content;margin:8px 0;padding:3px 9px;border-radius:8px;background:#f2eafa;color:#5c3c78;font:600 13px/1.6 system-ui;pointer-events:none';
        card.append(badge);used.add(card);
      }
    }
    let badgeTimer;
    function scheduleBadges(){clearTimeout(badgeTimer);badgeTimer=setTimeout(()=>{observer.disconnect();badges();if(observing && document.body)observer.observe(document.body,{childList:true,subtree:true});},180);}
    const observer=new MutationObserver(scheduleBadges);
    if (document.body) observer.observe(document.body,{childList:true,subtree:true});
    function invalidate(message){generation++;controller?.abort();busy=false;for(const r of results.values())r.stale=true;status=message;render();}
    async function consume(url,payload){
      if(!sameContext())return;
      const list=url.pathname.match(/^\/api\/session\/moment\/([a-zA-Z0-9_-]+)$/);
      if(list && list[1]===moment()){
        const next=core.sessions(payload,list[1]);
        const old=new Map(rows.map(r=>[r.session_id,r]));
        for(const row of next){const prior=old.get(row.session_id);if(!prior || prior.last_response_at!==row.last_response_at || prior.last_query!==row.last_query || prior.last_response!==row.last_response)results.delete(row.session_id);}
        rows=next;for(const key of results.keys())if(!rows.some(r=>r.session_id===key))results.delete(key);
        listURL=url.href;listVersion++;
        status=`已识别 ${rows.length} 段会话。点击「统计全部会话」读取数字。`;
        render();
      } else {
        const m=url.pathname.match(/^\/api\/session\/([a-zA-Z0-9_-]+)$/);
        if(m && rows.some(r=>r.session_id===m[1])){results.set(m[1],core.count(payload,m[1]));updated=Date.now();render();}
      }
    }
    async function hooked(input,init){
      let u,method='GET';
      try{u=new URL(input instanceof Request ? input.url : String(input),location.href);method=(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();}catch{}
      const relevant=u?.origin===location.origin && /^\/api\/session\/(?:moment\/[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)$/.test(u.pathname);
      if(observing && relevant && method==='GET'){
        const headers=new Headers(input instanceof Request ? input.headers : undefined);
        if(init?.headers)new Headers(init.headers).forEach((v,k)=>headers.set(k,v));
        auth=headers.get('authorization') || auth;
      }
      if(observing && u?.origin===location.origin && method!=='GET' && u.pathname.startsWith('/api/'))invalidate('页面正在修改数据，先前数字待刷新。操作完成后请重新统计。');
      const response=await original(input,init);
      if(observing && relevant && method==='GET' && response.ok){
        const context=generation;
        response.clone().json().then(data=>{if(context===generation)return consume(u,data);}).catch(()=>{});
      }
      return response;
    }
    pageWindow.fetch=hooked;
    async function read(url,signal){
      const headers={Accept:'application/json'};if(auth)headers.Authorization=auth;
      const requestController=new AbortController();
      const abort=()=>requestController.abort();signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      const timeout=setTimeout(abort,30000);
      try{
        const response=await original(url,{method:'GET',headers,credentials:'include',cache:'no-store',signal:requestController.signal,redirect:'error'});
        if(!response.ok)throw Error(response.status===401 || response.status===403 ? '登录状态不可用，请重新打开历史对话后重试' : `读取失败（HTTP ${response.status}）`);
        return await response.json();
      }catch(error){if(requestController.signal.aborted && !signal.aborted)throw Error('读取超时，请重试');throw error;}
      finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);}
    }
    $('#scan').onclick=async()=>{
      if(busy || !listURL)return;
      busy=true;controller=new AbortController();const signal=controller.signal, run=++generation;
      status='正在刷新历史会话列表…';results.clear();updated=0;render();
      try{
        const url=new URL(listURL);
        const payload=await read(url.href,signal);
        if(run!==generation || !sameContext())return;
        rows=core.sessions(payload,moment());listVersion++;
        const version=listVersion, snapshot=[...rows];
        for(let i=0;i<snapshot.length;i++){
          if(run!==generation || version!==listVersion || !sameContext())throw Error('会话列表或页面已变化，请重新统计');
          const row=snapshot[i];status=`正在读取 ${i+1} / ${snapshot.length} 段会话…`;render();
          try{const data=await read(`${location.origin}/api/session/${encodeURIComponent(row.session_id)}`,signal);
            if(run!==generation || version!==listVersion || !sameContext())throw Error('会话列表或页面已变化');
            results.set(row.session_id,core.count(data,row.session_id));
          }catch(error){if(signal.aborted)throw error;results.set(row.session_id,{error:error.message});if(/登录状态/.test(error.message))throw error;}
          updated=Date.now();render();
        }
        const failed=[...results.values()].filter(r=>r.error).length;
        status=failed ? `已结束：${failed} 段读取失败，合计不完整。` : '已读完本次列表返回的会话。合计按返回记录统计。';
      }catch(error){status=signal.aborted ? '已停止，当前只显示已读取的部分。' : error.message;}
      finally{if(run===generation){busy=false;render();}}
    };
    $('#stop').onclick=()=>controller?.abort();
    function minimize(){$('section').style.display='none';$('#mini').style.display='block';}
    $('#hide').onclick=minimize;
    function show(){render();document.dispatchEvent(new Event('rubii-close-commands'));$('section').style.display='block';$('#mini').style.display='none';}
    $('#mini').onclick=show;$('#search').oninput=render;
    $('#commands').onclick=()=>{ $('section').style.display='none';$('#mini').style.display='none';document.dispatchEvent(new Event('rubii-open-commands')); };
    document.addEventListener('rubii-open-counter',show);
    document.addEventListener('rubii-minimize-counter',minimize);
    minimize();
    const timer=setInterval(()=>{
      if(currentPath!==location.pathname){
        currentPath=location.pathname;currentSession=new URL(location.href).searchParams.get('sessionId');
        invalidate('聊天卡已切换，请打开它的历史对话。');rows=[];results.clear();listURL='';auth='';
        if(isChatPath() && $('section').style.display==='none')$('#mini').style.display='block';
        render();
      }
      else if(currentSession!==new URL(location.href).searchParams.get('sessionId')){currentSession=new URL(location.href).searchParams.get('sessionId');invalidate('会话已切换，请重新统计确认最新数字。');}
      else if(updated && Date.now()-updated>60000 && !busy && [...results.values()].some(r=>!r.stale)){invalidate('数字已超过 1 分钟，请重新统计以确认最新结果。');}
    },1000);
    $('#disable').onclick=()=>{observing=false;generation++;controller?.abort();observer.disconnect();clearInterval(timer);clearTimeout(badgeTimer);window.removeEventListener('resize',syncHostPosition);cleanBadges();auth='';rows=[];results.clear();if(pageWindow.fetch===hooked)pageWindow.fetch=nativeFetch;host.remove();delete pageWindow.__rubiiRoundCounter;};
    pageWindow.__rubiiRoundCounter={show,minimize};render();
  })();
})();