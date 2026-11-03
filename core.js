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
