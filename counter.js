(() => {
  'use strict';
  if (location.origin !== 'https://rubii.ai') return;
  if (window.__rubiiRoundCounter) { window.__rubiiRoundCounter.show(); return; }
  const core = window.__rubiiRoundCore;
  const nativeFetch = window.fetch;
  const original = nativeFetch.bind(window);
  let auth = '', rows = [], results = new Map(), listURL = '', busy = false, controller;
  let currentPath = location.pathname, currentSession = new URL(location.href).searchParams.get('sessionId'), generation = 0, listVersion = 0;
  let status = '先打开网站的「历史对话」，让插件识别会话列表。';
  let updated = 0, observing = true;
  const host = document.createElement('div');
  host.id = 'rubii-round-counter';
  host.style.cssText = 'position:fixed;right:18px;top:90px;z-index:2147483647;font:14px/1.6 system-ui,sans-serif;color:#252331';
  const shadow = host.attachShadow({mode:'closed'});
  shadow.innerHTML = `<style>
    *{box-sizing:border-box}section{width:360px;max-width:calc(100vw - 36px);max-height:76vh;overflow:auto;background:#fffefa;border:1px solid #e4dfe9;border-radius:18px;box-shadow:0 14px 60px #21152d40;padding:20px}header{display:flex;align-items:center;justify-content:space-between}h2{font-size:18px;margin:0}button{font:inherit;cursor:pointer;border:0;border-radius:9px;padding:8px 12px;background:#f0ebf6;color:#30233d}button:disabled{opacity:.45;cursor:default}.primary{background:#655080;color:white}p{margin:10px 0}.muted{color:#77717d;font-size:12px}.sum{font-size:26px;font-weight:700;line-height:1.3;margin:14px 0}.actions{display:flex;gap:7px;flex-wrap:wrap}.row{padding:10px 0;border-top:1px solid #eee8ee}.line{display:flex;justify-content:space-between;gap:10px}.number{font-weight:700;color:#60447a}a{color:#665080}details{font-size:12px;color:#77717d;margin-top:14px}#mini{display:none}#status{white-space:pre-wrap}input{width:100%;font:inherit;border:1px solid #ddd5e3;border-radius:8px;padding:7px;margin:12px 0 5px}
    </style><button id="mini">轮数统计</button><section><div id="days" style="font-size:19px;font-weight:700;margin-bottom:6px"></div><div id="days-note" class="muted" style="margin-bottom:14px"></div><header><h2>Rubii 会话轮数</h2><button id="commands">指令区</button><button id="hide" title="收起">−</button></header><p id="scope" class="muted"></p><div id="sum" class="sum">等待会话列表</div><p id="status" role="status"></p><div class="actions"><button id="scan" class="primary">统计全部会话</button><button id="stop">停止</button></div><input id="search" placeholder="搜索会话编号或日期" aria-label="搜索会话"><div id="rows"></div><details><summary>统计范围与隐私</summary><p>统计当前聊天卡「历史对话」接口返回的独立会话，按 session_id 去重。可能不涵盖同角色的其他聊天卡。没有读取手动存档，因此不会将存档再累加一次。</p><p>每轮必须有相同 round_id 的用户消息及角色回复；未回复的用户消息单列。开场白不按正文猜测。重生成、分支等异常另作提示。</p><p>结果是已返回记录的统计，不保证平台没有截断。38 轮样本已与平台存档交叉核对，其他边界口径尚待核对。</p><p>仅在本页内存处理。聊天正文、登录凭据和数字均不写入扩展存储，不上传其他服务。点击统计后，逐段读取 Rubii 已核实的只读会话接口。</p><button id="disable">停用本页统计</button></details></section>`;
  document.documentElement.append(host);
  const $ = selector => shadow.querySelector(selector);
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
  // Never associate native cards by order or role name. Require a unique exact
  // last-query text node and a containing card with the matching last reply.
  function badges() {
    cleanBadges();
    if(!sameContext())return;
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
  function scheduleBadges(){clearTimeout(badgeTimer);badgeTimer=setTimeout(()=>{observer.disconnect();badges();if(observing)observer.observe(document.body,{childList:true,subtree:true});},180);}
  const observer=new MutationObserver(scheduleBadges);
  observer.observe(document.body,{childList:true,subtree:true});
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
  window.fetch=hooked;
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
  $('#hide').onclick=()=>{$('section').style.display='none';$('#mini').style.display='block';};
  function show(){render();document.dispatchEvent(new Event('rubii-close-commands'));$('section').style.display='block';$('#mini').style.display='none';}
  $('#mini').onclick=show;$('#search').oninput=render;
  $('#commands').onclick=()=>{ $('section').style.display='none';$('#mini').style.display='none';document.dispatchEvent(new Event('rubii-open-commands')); };
  document.addEventListener('rubii-open-counter',show);
  const timer=setInterval(()=>{
    if(currentPath!==location.pathname){currentPath=location.pathname;currentSession=new URL(location.href).searchParams.get('sessionId');invalidate('聊天卡已切换，请打开它的历史对话。');rows=[];results.clear();listURL='';auth='';render();}
    else if(currentSession!==new URL(location.href).searchParams.get('sessionId')){currentSession=new URL(location.href).searchParams.get('sessionId');invalidate('会话已切换，请重新统计确认最新数字。');}
    else if(updated && Date.now()-updated>60000 && !busy && [...results.values()].some(r=>!r.stale)){invalidate('数字已超过 1 分钟，请重新统计以确认最新结果。');}
  },1000);
  $('#disable').onclick=()=>{observing=false;generation++;controller?.abort();observer.disconnect();clearInterval(timer);clearTimeout(badgeTimer);cleanBadges();auth='';rows=[];results.clear();if(window.fetch===hooked)window.fetch=nativeFetch;host.remove();delete window.__rubiiRoundCounter;};
  window.__rubiiRoundCounter={show};render();
})();
