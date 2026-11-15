// 진행 화면 (명세 7, 8, 9, 10).
//
// 이 파일은 서버가 알려 준 상태(GET /api/state)를 그대로 그린다.
//   - 단계 문구, 2부 내용, 공개 뒤의 설명, 마무리 문장은 모두 서버 상태에서 온다. 여기에 적어 두지 않는다.
//   - 결과 번호와 받은 내용은 그 순간 서버가 실제로 돌려준 값이다. 여기에 미리 적어 둔 결과는 없다.
//   - 서버가 준 값은 언제나 textContent로만 넣는다.
(() => {
  'use strict';

  const POLL_MS = 1000;
  const TICK_MS = 250;
  const LOG_KEEP = 300;
  const GENERIC_ERROR = '요청을 처리하지 못했습니다. 다시 눌러 주세요.';

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) {
    node.textContent = '';
    return node;
  }
  function show(node, on) {
    node.classList.toggle('hidden', !on);
  }
  function setText(node, text) {
    const value = text === undefined || text === null ? '' : String(text);
    if (node.textContent !== value) node.textContent = value;
  }
  function list(parent, items, className) {
    clear(parent);
    for (const item of items || []) parent.append(el('li', className, item));
  }

  /** 여러 줄을 위아래로 쌓은 표 칸. lines: [글자, 클래스] 또는 글자. 빈 줄은 건너뛴다. */
  function stack(className, lines) {
    const td = el('td', className);
    for (const line of lines) {
      const [text, lineClass] = Array.isArray(line) ? line : [line, ''];
      if (text === undefined || text === null || text === '') continue;
      td.append(el('div', lineClass, text));
    }
    return td;
  }

  /** 값이 지난번과 달라졌을 때만 true (같으면 다시 그리지 않는다: 스크롤 위치를 지킨다). */
  const signatures = {};
  function changed(key, value) {
    const signature = JSON.stringify(value === undefined ? null : value);
    if (signatures[key] === signature) return false;
    signatures[key] = signature;
    return true;
  }

  const two = (n) => String(n).padStart(2, '0');
  function clock(at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '';
    return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  }
  function clip(text, max = 140) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  function ratingsText(ratings) {
    if (ratings === null || typeof ratings !== 'object') return '';
    return Object.keys(ratings).map((subject) => `${subject} ${ratings[subject]}`).join(' · ');
  }
  /** 결과 번호의 색: 실제로 돌아온 숫자의 백의 자리만 본다. */
  function statusClass(status) {
    if (typeof status !== 'number') return 'st-none';
    return Math.floor(status / 100) === 2 ? 'st-ok' : 'st-other';
  }
  /** 새 창으로 여는 링크. 이 프로그램이 알려 준 주소만 쓴다. */
  function link(text, url, className) {
    const a = el('a', className || 'btn btn-link', text);
    try {
      const parsed = new URL(url);
      if (parsed.protocol.replace(':', '') === 'http') a.href = parsed.href;
    } catch {
      // 주소가 아니면 글자만 보여 준다.
    }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  // ------------------------------------------------------------------ 화면이 기억하는 것

  let state = null;
  let acting = false;
  let actionSeq = 0;
  let polling = false;
  let pollTimer = null;
  let lost = false;

  const ui = {
    confirmSwitch: false,
    confirmReset: false,
    confirmPart2Reset: false,
    hostDirty: false,
    resetNoticeClosedAt: null,
    errors: { action: null, sw: null, reveal: null, part2: null, receiver: null },
    part2Mark: null,
  };

  const log = { epoch: null, revealed: null, lastId: 0, count: 0, labels: {} };
  const remain = { base: 0, at: 0 };

  // ------------------------------------------------------------------ 서버와 주고받기

  async function call(method, path, body) {
    const init = { method, cache: 'no-store' };
    if (method !== 'GET') {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body || {});
    }
    const response = await fetch(path, init);
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { ok: response.ok, json };
  }

  function setLost(value) {
    lost = value;
    show($('lost-banner'), lost);
    document.body.classList.toggle('lost', lost);
  }

  /**
   * 버튼 하나의 동작. 처리하는 동안에는 어떤 버튼도 다시 눌리지 않는다.
   * 서버가 거절하면 서버가 보낸 한국어 설명을 slot 자리에 보여 준다.
   */
  async function act(button, path, body, slot) {
    if (acting) return null;
    acting = true;
    button.disabled = true;
    button.classList.add('busy');
    button.setAttribute('aria-busy', 'true');
    document.body.classList.add('acting');
    let result = null;
    try {
      result = await call('POST', path, body);
      setLost(false);
      let message = result.json && typeof result.json.error === 'string' ? result.json.error : null;
      if (!result.ok && !message) message = GENERIC_ERROR;
      ui.errors[slot] = message;
      if (result.json && result.json.state) apply(result.json.state, true);
    } catch {
      result = null;
      setLost(true);
    } finally {
      acting = false;
      actionSeq += 1;
      button.classList.remove('busy');
      button.removeAttribute('aria-busy');
      button.disabled = false;
      document.body.classList.remove('acting');
      if (state) render();
    }
    return result;
  }

  async function poll() {
    clearTimeout(pollTimer);
    let delay = POLL_MS;
    if (!acting && !polling) {
      polling = true;
      const seq = actionSeq;
      const since = log.lastId;
      try {
        const result = await call('GET', `/api/state?since=${since}&limit=${LOG_KEEP}`);
        if (!result.ok || !result.json || !result.json.accessLog) throw new Error('state');
        setLost(false);
        // 그 사이에 버튼 동작이 있었다면 그 동작이 돌려준 상태가 더 새것이다.
        if (!acting && seq === actionSeq) {
          if (apply(result.json, since === 0)) delay = 0;
          render();
        }
      } catch {
        setLost(true);
      }
      polling = false;
    }
    pollTimer = setTimeout(poll, delay);
  }

  /**
   * 새 상태를 받아들인다. full: 접속 기록을 처음부터(가장 최근 것까지) 받은 상태인가.
   * @returns {boolean} 접속 기록을 처음부터 다시 받아야 하면 true
   */
  function apply(next, full) {
    state = next;
    remain.base = next.switch.remainingMs;
    remain.at = performance.now();
    if (next.switch.on) ui.confirmSwitch = false;

    const accessLog = next.accessLog;
    let refetch = false;
    // 초기화로 기록이 비워졌거나, 줄마다 실리는 항목이 달라졌으면 가진 줄을 버리고 다시 받는다.
    if (accessLog.epoch !== log.epoch || next.revealed !== log.revealed) {
      clear($('log-rows'));
      log.epoch = accessLog.epoch;
      log.revealed = next.revealed;
      log.lastId = 0;
      log.count = 0;
      log.labels = {};
      show($('log-extra-head'), false);
      if (!full) refetch = true;
    }
    if (!refetch) addLogRows(accessLog.entries);
    return refetch;
  }

  // ------------------------------------------------------------------ 접속 기록

  function addLogRows(entries) {
    const rows = $('log-rows');
    for (const entry of entries || []) {
      if (typeof entry.id !== 'number' || entry.id <= log.lastId) continue;
      log.lastId = entry.id;
      rows.prepend(logRow(entry));
      log.count += 1;
    }
    while (rows.childElementCount > LOG_KEEP) rows.lastElementChild.remove();
    log.count = rows.childElementCount;
  }

  function logRow(entry) {
    const tr = el('tr', entry.otherDevice ? 'other' : '');
    tr.append(el('td', 'nowrap', clock(entry.at)));
    tr.append(el('td', 'nowrap strong', entry.app));
    const source = el('td', 'source');
    source.append(el('span', entry.otherDevice ? 'tag tag-other' : 'tag', entry.sourceLabel));
    source.append(el('div', 'mono nowrap', entry.clientAddress));
    if (entry.notice) source.append(el('div', 'notice', entry.notice));
    tr.append(source);
    tr.append(el('td', 'nowrap', entry.loginLabel));
    tr.append(el('td', 'mono request', entry.request));
    tr.append(el('td', `status ${statusClass(entry.status)}`, entry.status));
    // 이 칸은 서버가 그 항목을 실어 보냈을 때만 생긴다. 글자도 서버가 보낸 것이다.
    const extra = el('td', 'extra-col');
    if (typeof entry.permissionLabel === 'string') {
      const flag = String(entry.permissionChecked === true);
      extra.append(el('span', flag === 'true' ? 'tag flag-on' : 'tag flag-off', entry.permissionLabel));
      log.labels[flag] = entry.permissionLabel;
      show($('log-extra-head'), true);
    } else {
      extra.classList.add('hidden');
    }
    tr.append(extra);
    return tr;
  }

  /** 서버가 알려 준 앱에 붙일 글자(접속 기록의 줄에 실려 온 글자를 그대로 쓴다). 없으면 null. */
  function appFlag(key) {
    const reveal = state && state.reveal;
    if (!reveal || !reveal.revealed) return null;
    if (reveal.appWithoutCheck && reveal.appWithoutCheck.key === key) return { on: false, text: log.labels.false || null };
    if (reveal.appWithCheck && reveal.appWithCheck.key === key) return { on: true, text: log.labels.true || null };
    return null;
  }

  function renderLog() {
    setText($('log-count'), state.accessLog.total > 0 ? `모두 ${state.accessLog.total}건 · 최근 ${log.count}건 표시` : '');
    show($('log-empty'), log.count === 0);
    const reveal = state.reveal;
    const flags = reveal && reveal.revealed ? (reveal.apps || []).map((app) => ({ label: app.label, flag: appFlag(app.key) })) : [];
    if (changed('log-after', flags)) {
      const box = clear($('log-after'));
      for (const item of flags) {
        if (!item.flag || !item.flag.text) continue;
        const chip = el('span', item.flag.on ? 'after-chip flag-on' : 'after-chip flag-off');
        chip.append(el('strong', '', item.label), document.createTextNode(` — ${item.flag.text}`));
        box.append(chip);
      }
      show(box, box.childElementCount > 0);
    }
  }

  // ------------------------------------------------------------------ 위쪽 막대와 지금 단계

  function renderTop() {
    setText($('fixed-notice'), state.fixedNotice);
    const step = state.step;
    if (changed('chips', [state.steps, step.id])) {
      const box = clear($('step-chips'));
      for (const item of state.steps) {
        const chip = el('button', item.id === step.id ? 'chip current' : 'chip', item.label);
        chip.type = 'button';
        chip.title = item.title;
        if (item.id === step.id) chip.setAttribute('aria-current', 'step');
        chip.addEventListener('click', () => act(chip, '/api/step', { to: item.id }, 'action'));
        box.append(chip);
      }
    }
    $('btn-prev').disabled = !step.hasPrev;
    $('btn-next').disabled = !step.hasNext;
    show($('reset-confirm'), ui.confirmReset);
    $('btn-reset').disabled = ui.confirmReset;

    show($('action-error'), Boolean(ui.errors.action));
    setText($('action-error-text'), ui.errors.action);
    const reset = state.lastReset;
    const notice = reset && reset.notice && reset.at !== ui.resetNoticeClosedAt ? reset.notice : null;
    show($('reset-notice'), Boolean(notice));
    // 이유와 결과 번호는 서버가 지우기 요청에서 실제로 받은 것이다(대답이 없었으면 번호도 없다).
    const number = notice && typeof reset.receiverStatus === 'number' ? `, 결과 번호 ${reset.receiverStatus}` : '';
    const reason = notice && reset.reason ? ` (${reset.reason}${number})` : '';
    setText($('reset-notice-text'), notice ? `${clock(reset.at)} 전체 초기화: ${notice}${reason}` : '');
  }

  function renderStep() {
    const step = state.step;
    const current = step.current;
    setText($('step-count'), `${step.index + 1} / ${step.total} 단계`);
    setText($('step-title'), current.label === current.title ? current.title : `${current.label} · ${current.title}`);
    setText($('step-subtitle'), current.subtitle);
    if (changed('step-live', current.live)) {
      const box = clear($('step-live'));
      for (const line of current.live || []) box.append(el('p', 'live-line', line));
      show(box, box.childElementCount > 0);
    }
    if (changed('step-say', current.say)) list($('step-say'), current.say);
    if (changed('step-guide', current.guide)) list($('step-guide'), current.guide);

    const stage = stageOf(step.id);
    show($('quick-links'), stage === null);
    if (changed('quick-links', state.switch.apps)) {
      const row = clear($('quick-links-row'));
      for (const app of state.switch.apps) row.append(link(app.label, app.localUrl));
      for (const app of state.switch.apps) row.append(link(`${app.label} 옆 사람 화면`, app.localNeighborUrl));
    }
    document.body.dataset.step = step.id;
  }

  /** 단계마다 따로 그리는 영역이 있는 단계인가. */
  function stageOf(id) {
    if (id === 'reveal') return 'stage-reveal';
    if (id === 'part2') return 'stage-part2';
    if (id === 'closing') return 'stage-closing';
    return null;
  }

  // ------------------------------------------------------------------ 다른 기기 접속 스위치

  function renderSwitch() {
    const sw = state.switch;
    const panel = $('switch-panel');
    panel.classList.toggle('is-on', sw.on);
    panel.classList.toggle('is-warning', Boolean(sw.on && sw.warning));
    const badge = $('switch-badge');
    setText(badge, sw.on ? '켜짐' : '꺼짐');
    badge.className = sw.on ? 'state-badge badge-on' : 'state-badge badge-off';

    show($('switch-local'), !sw.on && Boolean(sw.localOnlyMessage));
    setText($('switch-local'), sw.localOnlyMessage);
    show($('switch-auto-off'), Boolean(sw.autoOff && sw.autoOffMessage));
    setText($('switch-auto-off-text'), sw.autoOffMessage);

    show($('switch-off-box'), !sw.on && !ui.confirmSwitch);
    show($('switch-confirm'), !sw.on && ui.confirmSwitch);
    setText($('switch-confirm-text'), sw.confirmWarning);

    show($('switch-on-box'), sw.on);
    if (sw.on) {
      setText($('switch-scope'), sw.scope);
      show($('switch-warning'), Boolean(sw.warning && sw.warningMessage));
      setText($('switch-warning'), sw.warningMessage);
      setText($('switch-hint'), sw.secondLaptopHint);
      if (changed('switch-addresses', sw.addresses)) {
        const box = clear($('switch-addresses'));
        for (const address of sw.addresses || []) box.append(el('span', 'address', address));
      }
      if (changed('switch-urls', sw.apps)) {
        const urls = clear($('switch-neighbor-urls'));
        const local = clear($('switch-local-links'));
        for (const app of sw.apps) {
          const row = el('div', 'url-row');
          row.append(el('div', 'url-app', app.label));
          for (const url of app.neighborUrls || []) row.append(el('div', 'url', url));
          urls.append(row);
          local.append(link(`${app.label} 옆 사람 화면`, app.localNeighborUrl));
        }
      }
      tick();
    }
    show($('switch-guidance'), Boolean(sw.on && sw.guidance));
    setText($('switch-guidance'), sw.guidance);
    if (changed('switch-failures', sw.failures)) {
      list($('switch-failures'), sw.failures);
      show($('switch-failures'), (sw.failures || []).length > 0);
    }
    show($('switch-error'), Boolean(ui.errors.sw));
    setText($('switch-error'), ui.errors.sw);
  }

  /** 남은 시간: 서버가 알려 준 값에서 흐른 시간만큼 줄여 가며 보여 준다. */
  function tick() {
    if (!state || !state.switch.on) return;
    const left = lost ? remain.base : Math.max(0, remain.base - (performance.now() - remain.at));
    const seconds = Math.ceil(left / 1000);
    setText($('switch-timer'), `${two(Math.floor(seconds / 60))}:${two(seconds % 60)}`);
  }

  // ------------------------------------------------------------------ 공개

  /** 받은 내용을 한 줄로 줄여 보여 준다(실제로 받은 값에서만 만든다). */
  function compact(body) {
    if (body === null || body === undefined) return '(받은 내용 없음)';
    if (typeof body === 'string') return clip(body);
    if (Array.isArray(body)) {
      const names = body.slice(0, 3).map((item) => (item && typeof item.name === 'string' ? item.name : null)).filter(Boolean);
      const more = body.length > names.length && names.length > 0 ? ' …' : '';
      return `기록 ${body.length}건${names.length > 0 ? `: ${names.join(', ')}${more}` : ''}`;
    }
    if (typeof body === 'object') {
      if (typeof body.error === 'string') return body.error;
      if (typeof body.name === 'string') {
        const parts = [body.name, ratingsText(body.ratings)];
        if (typeof body.guardianPhone === 'string') parts.push(body.guardianPhone);
        return parts.filter(Boolean).join(' · ');
      }
      return clip(JSON.stringify(body));
    }
    return String(body);
  }

  function renderReveal() {
    const reveal = state.reveal;
    $('btn-reveal').disabled = Boolean(reveal.running);
    setText($('reveal-meta'), reveal.revealed
      ? `${clock(reveal.ranAt)}에 두 앱에 실제로 보낸 결과입니다 · ${reveal.runCount}번째`
      : (reveal.running ? '요청을 보내는 중입니다…' : ''));
    show($('reveal-error'), Boolean(ui.errors.reveal));
    setText($('reveal-error'), ui.errors.reveal);

    const flags = reveal.revealed ? (reveal.apps || []).map((app) => appFlag(app.key)) : [];
    if (!changed('reveal', [reveal.revealed ? reveal : null, flags])) return;
    const body = clear($('reveal-body'));
    if (!reveal.revealed) return;

    const table = el('table', 'grid reveal-table');
    const head = el('tr');
    head.append(el('th', 'attempt-col', '시도'));
    reveal.apps.forEach((app, index) => {
      const th = el('th', 'app-col');
      th.append(el('div', 'app-name', app.label));
      const flag = flags[index];
      if (flag) {
        th.classList.add(flag.on ? 'flag-on' : 'flag-off');
        if (flag.text) th.append(el('div', 'app-flag', flag.text));
      }
      head.append(th);
    });
    const thead = el('thead');
    thead.append(head);
    table.append(thead);

    const tbody = el('tbody');
    for (const attempt of reveal.attempts) {
      const tr = el('tr');
      const what = el('td', 'attempt-col');
      what.append(el('div', 'attempt-title', `${attempt.no}. ${attempt.title}`));
      what.append(el('div', 'mono small', attempt.request));
      if (attempt.loginId) what.append(el('div', 'small', `로그인: ${attempt.loginId}`));
      if (attempt.sent !== null && attempt.sent !== undefined) what.append(el('div', 'small', `보낸 내용: ${clip(JSON.stringify(attempt.sent))}`));
      tr.append(what);
      for (const app of reveal.apps) {
        const result = (attempt.results || {})[app.key] || {};
        const td = el('td', `result ${statusClass(result.status)}`);
        const top = el('div', 'result-top');
        top.append(el('span', 'result-label', '결과 번호'));
        top.append(el('span', 'result-status', typeof result.status === 'number' ? result.status : '—'));
        td.append(top);
        td.append(el('div', 'result-body', result.error ? result.error : compact(result.body)));
        tr.append(td);
      }
      tbody.append(tr);
    }
    const foot = el('tr', 'reveal-foot');
    foot.append(el('td', 'attempt-col small', '이번 공개에 쓴 로그인 · 로그아웃 요청의 결과 번호'));
    for (const app of reveal.apps) {
      const show2 = (value) => (typeof value === 'number' ? value : '—');
      foot.append(el('td', 'small', `로그인 ${show2(app.loginStatus)} · 로그아웃 ${show2(app.logoutStatus)}`));
    }
    tbody.append(foot);
    table.append(tbody);
    body.append(table);

    const notes = el('ul', 'reveal-notes');
    for (const note of reveal.notes || []) notes.append(el('li', '', note));
    body.append(notes);
    if (reveal.comparisonNotice) body.append(el('p', 'reveal-notice', reveal.comparisonNotice));
    if (reveal.realRequestNote) body.append(el('p', 'reveal-notice', reveal.realRequestNote));
  }

  // ------------------------------------------------------------------ 2부

  function part2Section(title, className) {
    const section = el('section', `p2 ${className || ''}`);
    section.append(el('h3', '', title));
    return section;
  }

  function choiceButtons(p2, which, picked, enabled) {
    const row = el('div', 'choice-row');
    for (const choice of p2.choices || []) {
      const button = el('button', 'btn btn-choice', choice.label);
      button.type = 'button';
      if (picked && picked.id === choice.id) {
        button.classList.add('picked');
        button.setAttribute('aria-pressed', 'true');
      }
      button.disabled = !enabled;
      button.addEventListener('click', () => act(button, '/api/part2', { action: 'choose', which, choice: choice.id }, 'part2'));
      row.append(button);
    }
    return row;
  }

  function renderPart2() {
    const p2 = state.part2;
    setText($('part2-stage'), `2부 ${p2.stageNo} / ${p2.stageCount} 단계`);
    $('btn-part2-next').disabled = p2.stageNo >= p2.stageCount;
    show($('part2-reset-confirm'), ui.confirmPart2Reset);
    $('btn-part2-reset').disabled = ui.confirmPart2Reset;
    show($('part2-error'), Boolean(ui.errors.part2));
    setText($('part2-error'), ui.errors.part2);
    if (!changed('part2', p2)) return;

    const body = clear($('part2-body'));
    const opened = (p2.contexts || []).length;

    const journal = part2Section(`감정일지 — ${p2.subject}`, 'p2-journal');
    const days = el('div', 'journal');
    for (const line of p2.journal || []) {
      const card = el('div', 'journal-day');
      card.append(el('div', 'day', line.day), el('div', 'day-text', line.text));
      days.append(card);
    }
    journal.append(days);
    body.append(journal);

    if (p2.facts) {
      const facts = part2Section('관찰된 사실');
      const ul = el('ul', 'facts');
      for (const fact of p2.facts) ul.append(el('li', '', fact));
      facts.append(ul);
      body.append(facts);
    }

    if (p2.ai) {
      const ai = part2Section('AI의 해석', 'p2-ai');
      ai.append(el('p', 'ai-text', p2.ai.text));
      ai.append(el('p', 'ai-label', p2.ai.label));
      body.append(ai);
    }

    if (p2.choices) {
      const first = part2Section('첫 선택');
      first.append(choiceButtons(p2, 'first', p2.firstChoice, p2.stage === 'firstChoice' && opened === 0));
      body.append(first);

      const context = part2Section('추가 맥락');
      const bar = el('div', 'context-bar');
      const more = el('button', 'btn btn-big btn-primary', '맥락 하나 더 보기');
      more.type = 'button';
      more.disabled = !p2.firstChoice || opened >= p2.contextTotal;
      more.addEventListener('click', () => act(more, '/api/part2', { action: 'context' }, 'part2'));
      bar.append(more, el('span', 'context-count', `${opened} / ${p2.contextTotal}`));
      context.append(bar);
      const items = el('div', 'contexts');
      for (const item of p2.contexts || []) {
        const card = el('div', 'context');
        card.append(el('div', 'day', item.day), el('div', 'context-journal', item.journal), el('div', 'context-text', item.context));
        items.append(card);
      }
      context.append(items);
      if (p2.noContextNote) context.append(el('p', 'context-note', p2.noContextNote));
      body.append(context);
    }

    if (p2.choices && opened >= p2.contextTotal) {
      const second = part2Section('다시 선택');
      second.append(choiceButtons(p2, 'second', p2.secondChoice, p2.stage === 'secondChoice'));
      body.append(second);
    }

    if (p2.comparison) {
      const compare = part2Section('나란히 보기', 'p2-compare');
      const pair = el('div', 'compare');
      const a = el('div', 'compare-card');
      a.append(el('div', 'compare-title', '첫 선택'), el('div', 'compare-choice', p2.comparison.first.label));
      const b = el('div', 'compare-card');
      b.append(el('div', 'compare-title', '다시 한 선택'), el('div', 'compare-choice', p2.comparison.second.label));
      pair.append(a, b);
      compare.append(pair, el('p', 'compare-message', p2.comparison.message));
      body.append(compare);
    }

    if (p2.explanation) {
      const explain = part2Section('설명과 문구', 'p2-explain');
      const concepts = el('dl', 'concepts');
      for (const item of p2.explanation.concepts || []) concepts.append(el('dt', '', item.term), el('dd', '', item.text));
      explain.append(concepts);
      explain.append(el('p', 'role', p2.explanation.role));
      for (const message of p2.explanation.messages || []) {
        explain.append(el('p', message.emphasis ? 'message emphasis' : 'message', message.text));
      }
      body.append(explain);
    }

    // 새로 열린 부분이 보이게 한다(처음 그릴 때는 움직이지 않는다).
    const mark = `${p2.stageNo}/${opened}`;
    if (ui.part2Mark !== null && ui.part2Mark !== mark && body.lastElementChild && state.step.id === 'part2') {
      body.lastElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    ui.part2Mark = mark;
  }

  // ------------------------------------------------------------------ 마무리

  function renderClosing() {
    const closing = state.closing;
    if (!changed('closing', closing)) return;
    const box = clear($('closing-list'));
    for (const sentence of (closing && closing.sentences) || []) {
      const li = el('li', sentence.emphasis ? 'emphasis' : '');
      li.append(el('span', 'closing-no', sentence.no), el('span', 'closing-text', sentence.text));
      box.append(li);
    }
  }

  function renderStage() {
    const active = stageOf(state.step.id);
    for (const id of ['stage-reveal', 'stage-part2', 'stage-closing']) show($(id), id === active);
    renderReveal();
    renderPart2();
    renderClosing();
  }

  // ------------------------------------------------------------------ 옆 기기가 가져간 것

  function renderTaken() {
    if (!changed('taken', state.taken)) return;
    const box = clear($('taken-apps'));
    for (const app of state.taken) {
      const card = el('div', 'taken-app');
      const head = el('div', 'taken-head');
      head.append(el('span', 'taken-name', app.app));
      const count = el('span', 'taken-count');
      count.append(el('strong', '', app.studentCount), document.createTextNode('명'));
      head.append(count);
      head.append(el('span', 'taken-caption', '가져간 학생 수 (서로 다른 학생)'));
      head.append(el('span', 'taken-roster', app.rosterLabel));
      card.append(head);

      if ((app.students || []).length > 0) {
        const wrap = el('div', 'scroll short');
        const table = el('table', 'grid');
        const thead = el('thead');
        const tr = el('tr');
        for (const title of ['이름', '성적 / 담임 종합의견', '보호자 이름·연락처']) tr.append(el('th', '', title));
        thead.append(tr);
        table.append(thead);
        const tbody = el('tbody');
        for (const student of app.students) {
          const row = el('tr');
          row.append(el('td', 'nowrap strong', student.name));
          row.append(stack('', [[ratingsText(student.ratings), 'ratings'], student.comment]));
          row.append(stack('nowrap', [student.guardianName, [student.guardianPhone, 'mono']]));
          tbody.append(row);
        }
        table.append(tbody);
        wrap.append(table);
        card.append(wrap);
      } else {
        card.append(el('p', 'empty', '아직 가져간 기록이 없습니다.'));
      }
      box.append(card);
    }
  }

  // ------------------------------------------------------------------ 받는 쪽에 도착한 것

  /** 개수 칸의 글자. 받는 쪽이 실제로 알려 준 개수만 "N건"으로 쓴다. 물어보지 못했으면(null) 모른다고 쓴다. */
  function countText(count) {
    return typeof count === 'number' ? `${count}건` : '확인하지 못함';
  }

  /** 목록이 비어 있을 때의 글자. "없다"는 말은 받는 쪽이 실제로 대답했을 때만 쓴다. */
  function emptyListText(reachable) {
    if (reachable === true) return '아직 도착한 것이 없습니다.';
    if (reachable === false) return '받는 쪽에 물어보지 못해서, 도착한 것이 있는지 확인하지 못했습니다.';
    return '받는 쪽에 물어보는 중입니다.';
  }

  function receivedTable(items, columns, reachable) {
    if (!items || items.length === 0) return el('p', 'empty', emptyListText(reachable));
    const table = el('table', 'grid');
    const thead = el('thead');
    const head = el('tr');
    for (const column of columns) head.append(el('th', '', column.title));
    thead.append(head);
    table.append(thead);
    const tbody = el('tbody');
    // 가장 최근에 도착한 것이 위로 오게 한다.
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i] || {};
      const payload = item.payload !== null && typeof item.payload === 'object' ? item.payload : {};
      const row = el('tr');
      for (const column of columns) row.append(stack(column.className || '', column.lines(item, payload)));
      tbody.append(row);
    }
    table.append(tbody);
    return table;
  }

  const WHEN = { title: '받은 시각 / 보낸 쪽', className: 'nowrap', lines: (item) => [clock(item.receivedAt), [item.from, 'mono']] };
  const SHEET_COLUMNS = [
    WHEN,
    { title: '학생', className: 'nowrap', lines: (item, p) => [[p.name, 'strong'], p.id, p.className] },
    { title: '성적 / 담임 종합의견', lines: (item, p) => [[ratingsText(p.ratings), 'ratings'], p.comment] },
    { title: '보호자 이름·연락처', className: 'nowrap', lines: (item, p) => [p.guardianName, [p.guardianPhone, 'mono']] },
  ];
  const AI_COLUMNS = [
    WHEN,
    { title: '학생', className: 'nowrap', lines: (item, p) => [[p.name, 'strong'], p.id] },
    { title: '성적 / 담임 종합의견', lines: (item, p) => [[ratingsText(p.ratings), 'ratings'], p.comment] },
  ];

  function renderReceiver() {
    const receiver = state.receiver;
    const input = $('receiver-host');
    if (!ui.hostDirty && document.activeElement !== input && input.value !== receiver.host) input.value = receiver.host;
    setText($('receiver-port'), `: ${receiver.port} (고정)`);
    setText($('receiver-location'), receiver.locationLabel);

    const badge = $('receiver-badge');
    if (receiver.reachable === true) {
      setText(badge, '연결됨');
      badge.className = 'state-badge badge-ok';
    } else if (receiver.reachable === false) {
      setText(badge, '닿지 못함');
      badge.className = 'state-badge badge-bad';
    } else {
      setText(badge, '확인 중');
      badge.className = 'state-badge badge-wait';
    }

    show($('receiver-error'), Boolean(ui.errors.receiver));
    setText($('receiver-error'), ui.errors.receiver);

    if (changed('receiver-ping', receiver.ping)) {
      const box = clear($('receiver-ping'));
      const ping = receiver.ping;
      show(box, Boolean(ping));
      if (ping) {
        box.className = ping.ok ? 'ping ping-ok' : 'ping ping-bad';
        box.append(el('p', 'ping-message', `연결 확인 (${clock(ping.at)}) — ${ping.message}`));
        if (ping.base) box.append(el('p', 'mono small', ping.base));
        if ((ping.causes || []).length > 0) {
          box.append(el('p', 'small strong', '원인 후보와 조치'));
          const causes = el('dl', 'causes');
          for (const item of ping.causes) causes.append(el('dt', '', item.cause), el('dd', '', item.action));
          box.append(causes);
        }
      }
    }

    if (changed('receiver-problem', [receiver.error, receiver.help])) {
      const box = clear($('receiver-problem'));
      const has = Boolean(receiver.error) || (receiver.help || []).length > 0;
      show(box, has);
      if (receiver.error) box.append(el('p', 'problem-title', receiver.error));
      if ((receiver.help || []).length > 0) {
        const ul = el('ul');
        for (const line of receiver.help) ul.append(el('li', '', line));
        box.append(ul);
      }
    }

    setText($('sheet-count'), countText(receiver.sheetCount));
    setText($('ai-count'), countText(receiver.aiCount));
    if (changed('sheet', [receiver.reachable, receiver.sheet])) {
      clear($('sheet-box')).append(receivedTable(receiver.sheet, SHEET_COLUMNS, receiver.reachable));
    }
    if (changed('ai', [receiver.reachable, receiver.ai])) {
      clear($('ai-box')).append(receivedTable(receiver.ai, AI_COLUMNS, receiver.reachable));
    }

    if (changed('failed', receiver.failedTransfers)) {
      const failed = receiver.failedTransfers || [];
      show($('failed-box'), failed.length > 0);
      const ul = clear($('failed-list'));
      for (let i = failed.length - 1; i >= 0; i -= 1) {
        const item = failed[i];
        const number = typeof item.status === 'number' ? ` (결과 번호 ${item.status})` : '';
        ul.append(el('li', '', `${clock(item.at)} · ${item.app} · ${item.kindLabel} · ${item.studentId} — ${item.error || ''}${number}`));
      }
    }
  }

  // ------------------------------------------------------------------ 전체 그리기

  function render() {
    if (!state) return;
    document.body.classList.add('ready');
    renderTop();
    renderStep();
    renderSwitch();
    renderStage();
    renderLog();
    renderTaken();
    renderReceiver();
  }

  // ------------------------------------------------------------------ 버튼

  function on(id, handler) {
    const button = $(id);
    button.addEventListener('click', () => handler(button));
  }

  on('btn-prev', (button) => act(button, '/api/step', { to: 'prev' }, 'action'));
  on('btn-next', (button) => act(button, '/api/step', { to: 'next' }, 'action'));
  on('btn-error-close', () => {
    ui.errors.action = null;
    render();
  });

  on('btn-reset', () => {
    ui.confirmReset = true;
    render();
  });
  on('btn-reset-no', () => {
    ui.confirmReset = false;
    render();
  });
  on('btn-reset-yes', async (button) => {
    const result = await act(button, '/api/reset', {}, 'action');
    if (!result) return;
    ui.confirmReset = false;
    ui.confirmSwitch = false;
    ui.confirmPart2Reset = false;
    ui.resetNoticeClosedAt = null;
    for (const slot of ['sw', 'reveal', 'part2', 'receiver']) ui.errors[slot] = null;
    render();
    window.scrollTo(0, 0);
  });
  on('btn-reset-notice-close', () => {
    ui.resetNoticeClosedAt = state && state.lastReset ? state.lastReset.at : null;
    render();
  });

  on('btn-switch-on', () => {
    ui.confirmSwitch = true;
    ui.errors.sw = null;
    render();
  });
  on('btn-switch-no', () => {
    ui.confirmSwitch = false;
    render();
  });
  // 경고에서 '확인'을 눌렀을 때만 켜기 요청을 보낸다.
  on('btn-switch-yes', async (button) => {
    const result = await act(button, '/api/switch', { action: 'on', confirmed: true }, 'sw');
    if (!result) return;
    ui.confirmSwitch = false;
    render();
  });
  on('btn-switch-extend', (button) => act(button, '/api/switch', { action: 'extend' }, 'sw'));
  on('btn-switch-off', (button) => act(button, '/api/switch', { action: 'off' }, 'sw'));
  on('btn-switch-dismiss', (button) => act(button, '/api/switch', { action: 'dismiss' }, 'sw'));

  on('btn-reveal', async (button) => {
    const result = await act(button, '/api/reveal', {}, 'reveal');
    if (result && result.ok) $('stage-reveal').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  on('btn-part2-next', (button) => act(button, '/api/part2', { action: 'next' }, 'part2'));
  on('btn-part2-reset', () => {
    ui.confirmPart2Reset = true;
    render();
  });
  on('btn-part2-reset-no', () => {
    ui.confirmPart2Reset = false;
    render();
  });
  on('btn-part2-reset-yes', async (button) => {
    const result = await act(button, '/api/part2', { action: 'reset' }, 'part2');
    if (!result) return;
    ui.confirmPart2Reset = false;
    render();
  });

  const hostInput = $('receiver-host');
  hostInput.addEventListener('input', () => {
    ui.hostDirty = !state || hostInput.value.trim() !== state.receiver.host;
  });
  async function applyHost(button) {
    const result = await act(button, '/api/receiver', { action: 'set', host: hostInput.value.trim() }, 'receiver');
    if (result && result.ok) {
      ui.hostDirty = false;
      hostInput.value = state.receiver.host;
      render();
    }
    return Boolean(result && result.ok);
  }
  on('btn-receiver-set', (button) => applyHost(button));
  hostInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyHost($('btn-receiver-set'));
    }
  });
  // 칸에 새 주소를 적어 둔 채로 누르면, 먼저 그 주소를 적용한 다음에 연결을 확인한다.
  on('btn-receiver-ping', async (button) => {
    if (ui.hostDirty && !(await applyHost(button))) return;
    await act(button, '/api/receiver', { action: 'ping' }, 'receiver');
  });

  setInterval(tick, TICK_MS);
  poll();
})();
