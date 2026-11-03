(() => {
  'use strict';
  if (location.origin !== 'https://rubii.ai' || globalThis.__rubiiInstructions) return;
  globalThis.__rubiiInstructions = true;
  let items = [], editing = null, dirty = false, saving = false, loaded = false;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:18px;top:90px;z-index:2147483647;font:14px/1.6 system-ui,sans-serif;color:#252331';
  const root = host.attachShadow({mode:'closed'});
  root.innerHTML = `<style>
  *{box-sizing:border-box}section{width:380px;max-width:calc(100vw - 36px);max-height:76vh;overflow:auto;padding:20px;background:#fffefa;border:1px solid #e4dfe9;border-radius:18px;box-shadow:0 14px 60px #21152d40}header,.line,.actions{display:flex;gap:8px;align-items:center;justify-content:space-between}h2{font-size:18px;margin:0}button,input,textarea{font:inherit}button{border:0;border-radius:8px;padding:7px 10px;background:#f0ebf6;color:#30233d;cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:#655080;color:white}.danger{color:#a22b3b;background:#fceef0}input,textarea{width:100%;padding:9px;border:1px solid #ddd5e3;border-radius:8px;background:white;color:#252331}textarea{resize:vertical;min-height:150px;line-height:1.6}input:focus,textarea:focus{outline:2px solid #b9a3ce}label{display:block;margin:10px 0 5px}.muted{font-size:12px;color:#77717d}#status{margin:8px 0;min-height:22px;white-space:pre-wrap}.card{border-top:1px solid #e9e2ed;padding:12px 0}.title{font-weight:650;overflow-wrap:anywhere}.preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:66px;overflow:hidden;color:#77717d;font-size:12px;margin:5px 0 9px}.actions{justify-content:flex-start;flex-wrap:wrap}.listhead{margin:18px 0 8px}#editor{padding:12px;background:#f7f3fa;border-radius:10px;margin-top:12px}.hint{margin:8px 0}#query{margin:8px 0}
  </style><section hidden><header><h2>我的指令</h2><div class="actions"><button id="counter">轮数统计</button><button id="close" title="收起">−</button></div></header><p class="muted hint">保存在本机 Chrome。复制后自行粘贴，不会自动发送。</p><div class="line"><button id="new" class="primary">＋ 新增指令</button><span id="count" class="muted"></span></div><div id="status" role="status"></div><div id="editor" hidden><strong id="heading">新增指令</strong><label for="title">标题</label><input id="title" maxlength="120" placeholder="例如：总结剧情"><label for="content">指令内容</label><textarea id="content" maxlength="50000" placeholder="输入你的指令…"></textarea><div class="actions" style="margin-top:10px"><button id="save" class="primary">保存</button><button id="cancel">取消</button></div></div><input id="query" placeholder="搜索标题或内容" aria-label="搜索指令"><div id="list"></div></section>`;
  document.documentElement.append(host);
  const $ = s => root.querySelector(s);
  function el(tag, text, cls) { const node=document.createElement(tag);node.textContent=text;if(cls)node.className=cls;return node; }
  function status(text) { $('#status').textContent=text; }
  async function request(action, values={}) {
    const response=await chrome.runtime.sendMessage({area:'rubii-instructions', action, ...values});
    if(!response?.ok)throw Error(response?.error || '扩展已更新，请刷新网页后重新打开插件');
    return response;
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
  async function copy(item,button) {
    try {
      await navigator.clipboard.writeText(item.content);
      button.textContent='已复制';status(`已复制「${item.title}」`);
      setTimeout(()=>{button.textContent='复制';},1500);
    } catch { status('复制未成功。点「编辑」，选中内容后按 ⌘C / Ctrl+C 复制。'); }
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
  $('#close').onclick=()=>{$('section').hidden=true;};
  $('#counter').onclick=()=>{$('section').hidden=true;document.dispatchEvent(new Event('rubii-open-counter'));};
  document.addEventListener('rubii-close-commands',()=>{$('section').hidden=true;});
  document.addEventListener('rubii-open-commands',()=>{$('section').hidden=false;});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && changes.instructionsV1){items=changes.instructionsV1.newValue || [];render();}});
  // Warn before a full reload would discard an unfinished edit.
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  request('list').then(response=>{items=response.items;loaded=true;render();}).catch(error=>status(error.message));
  render();
})();
