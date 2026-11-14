// 받는 쪽 화면. 받는 쪽 프로그램에 1초마다 실제로 물어보고, 돌아온 값만 그린다.
// 받은 값은 언제나 글자(textContent)로만 넣는다.

(function () {
  'use strict';

  var SUBJECTS = ['국어', '수학', '사회', '과학', '영어'];
  var POLL_MS = 1000;

  function $(id) { return document.getElementById(id); }
  function show(el, visible) { el.hidden = !visible; }
  function text(value) { return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value); }

  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = text(content);
    return node;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function timeOf(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return text(iso);
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return two(date.getHours()) + ':' + two(date.getMinutes()) + ':' + two(date.getSeconds());
  }

  function request(method, path, body) {
    var options = { method: method, cache: 'no-store' };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, json: json }; });
    });
  }

  // ------------------------------------------------------------------ 받은 내용

  var lastReceivedText = null;

  function ratingsOf(payload) {
    return payload && payload.ratings && typeof payload.ratings === 'object' ? payload.ratings : {};
  }

  function drawSheet(items) {
    var body = $('sheet-body');
    clearChildren(body);
    items.forEach(function (item) {
      var payload = item.payload || {};
      var ratings = ratingsOf(payload);
      var row = document.createElement('tr');
      row.appendChild(el('td', 'nowrap', timeOf(item.receivedAt)));
      row.appendChild(el('td', 'nowrap', item.from));
      row.appendChild(el('td', 'nowrap', payload.id));
      row.appendChild(el('td', 'nowrap', payload.name));
      row.appendChild(el('td', 'nowrap', payload.className));
      SUBJECTS.forEach(function (subject) {
        var value = text(ratings[subject]);
        row.appendChild(el('td', value === '노력요함' ? 'nowrap rating-low' : 'nowrap', value));
      });
      row.appendChild(el('td', 'comment', payload.comment));
      row.appendChild(el('td', 'nowrap', payload.guardianName));
      row.appendChild(el('td', 'nowrap', payload.guardianPhone));
      body.appendChild(row);
    });
    show($('sheet-table'), items.length > 0);
    show($('empty-sheet'), items.length === 0);
    $('count-sheet').textContent = String(items.length);
  }

  function aiRow(label, value) {
    var row = el('p', 'ai-row');
    row.appendChild(el('span', 'ai-label', label));
    row.appendChild(el('span', '', value));
    return row;
  }

  function drawAi(items) {
    var list = $('ai-list');
    clearChildren(list);
    items.forEach(function (item) {
      var payload = item.payload || {};
      var ratings = ratingsOf(payload);
      var entry = document.createElement('li');
      entry.appendChild(el('p', 'ai-meta', '받은 시각 ' + timeOf(item.receivedAt) + ' · 보낸 쪽 ' + text(item.from)));
      entry.appendChild(el('p', 'ai-who', text(payload.id) + ' ' + text(payload.name)));
      entry.appendChild(aiRow('평가', SUBJECTS.map(function (subject) {
        return subject + ' ' + text(ratings[subject]);
      }).join(' · ')));
      entry.appendChild(aiRow('종합의견', payload.comment));
      list.appendChild(entry);
    });
    show($('empty-ai'), items.length === 0);
    $('count-ai').textContent = String(items.length);
  }

  function refreshReceived() {
    return fetch('/api/received', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('received');
      return res.text();
    }).then(function (raw) {
      if (raw === lastReceivedText) return; // 달라진 것이 없으면 다시 그리지 않는다.
      var data = JSON.parse(raw);
      drawSheet(Array.isArray(data.sheet) ? data.sheet : []);
      drawAi(Array.isArray(data.ai) ? data.ai : []);
      lastReceivedText = raw;
    });
  }

  // ------------------------------------------------------------------ 탭

  function selectTab(name) {
    var sheet = name === 'sheet';
    $('tab-sheet').setAttribute('aria-selected', sheet ? 'true' : 'false');
    $('tab-ai').setAttribute('aria-selected', sheet ? 'false' : 'true');
    show($('panel-sheet'), sheet);
    show($('panel-ai'), !sheet);
  }
  $('tab-sheet').addEventListener('click', function () { selectTab('sheet'); });
  $('tab-ai').addEventListener('click', function () { selectTab('ai'); });

  // ------------------------------------------------------------------ 모두 지우기

  function askClear(asking) {
    show($('btn-clear'), !asking);
    show($('clear-confirm'), asking);
  }
  $('btn-clear').addEventListener('click', function () { askClear(true); });
  $('btn-clear-no').addEventListener('click', function () { askClear(false); });
  $('btn-clear-yes').addEventListener('click', function () {
    askClear(false);
    request('POST', '/api/clear').then(function (result) {
      show($('clear-error'), !result.ok);
      if (!result.ok) $('clear-error').textContent = text(result.json && result.json.error) || '지우지 못했습니다.';
      return refreshReceived();
    }).catch(function () {
      $('clear-error').textContent = '지우지 못했습니다. 받는 쪽 프로그램이 켜져 있는지 확인해 주세요.';
      show($('clear-error'), true);
    });
  });

  // ------------------------------------------------------------------ 다른 기기 접속 스위치

  var confirming = false;
  var lastStatus = null;

  function minutesOf(ms) {
    var minutes = ms / 60000;
    return minutes >= 1 ? String(Math.round(minutes)) : String(Math.round(minutes * 100) / 100);
  }

  function clock(ms) {
    var total = Math.ceil(Math.max(0, ms) / 1000);
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function fillList(list, values) {
    clearChildren(list);
    values.forEach(function (value) { list.appendChild(el('li', '', value)); });
  }

  function drawSwitch(status) {
    lastStatus = status;
    var on = status.on === true;
    if (on) confirming = false;

    show($('switch-on'), on);
    show($('switch-off'), !on && !confirming);
    show($('switch-confirm'), !on && confirming);

    show($('switch-auto-off'), !on && status.autoOff === true);
    if (status.autoOffMessage) $('switch-auto-off-text').textContent = text(status.autoOffMessage);

    var limit = minutesOf(Number(status.limitMs) || 0);
    $('confirm-limit').textContent = limit;
    $('extend-limit').textContent = limit;

    if (!on) return;

    $('remaining').textContent = clock(Number(status.remainingMs) || 0);
    $('remaining').className = status.warning ? 'remaining is-warning' : 'remaining';
    show($('switch-warning'), status.warning === true);

    var addresses = Array.isArray(status.addresses) ? status.addresses : [];
    var open = Array.isArray(status.openAddresses) ? status.openAddresses : [];
    fillList($('addresses'), addresses.length > 0 ? addresses : ['찾지 못함']);
    fillList($('open-addresses'), open.length > 0 ? open : ['없음']);

    var portNote = $('open-port-note');
    show(portNote, open.length > 1);
    if (open.length > 1) portNote.textContent = '주소가 여러 개면 두 노트북이 함께 쓰는 연결의 주소를 고르세요. 모르면 하나씩 넣고 진행 화면의 연결 확인을 눌러 보세요.';

    var noAddress = $('no-address');
    show(noAddress, status.noInternalAddress === true);
    if (status.noInternalAddress === true) {
      noAddress.textContent = text(status.guidance) || '이 PC의 내부 주소를 찾지 못했습니다. 와이파이나 핫스팟에 연결되어 있는지 확인해 주세요.';
    }

    var failures = Array.isArray(status.failures) ? status.failures : [];
    fillList($('failures'), failures);
    show($('failures'), failures.length > 0);
  }

  function switchError(message) {
    show($('switch-error'), Boolean(message));
    $('switch-error').textContent = message || '';
  }

  function refreshSwitch() {
    return request('GET', '/local/switch').then(function (result) {
      if (!result.ok) throw new Error('switch');
      drawSwitch(result.json);
    });
  }

  function act(path, body) {
    switchError('');
    return request('POST', path, body).then(function (result) {
      if (result.ok) {
        drawSwitch(result.json);
      } else {
        switchError(text(result.json && result.json.error) || '요청을 처리하지 못했습니다.');
        return refreshSwitch();
      }
    }).catch(function () {
      switchError('요청을 보내지 못했습니다. 받는 쪽 프로그램이 켜져 있는지 확인해 주세요.');
    });
  }

  $('btn-on').addEventListener('click', function () {
    confirming = true;
    switchError('');
    if (lastStatus) drawSwitch(lastStatus);
    $('btn-cancel').focus();
  });
  $('btn-cancel').addEventListener('click', function () {
    confirming = false;
    if (lastStatus) drawSwitch(lastStatus);
  });
  $('btn-confirm').addEventListener('click', function () {
    confirming = false;
    act('/local/switch/on', { confirmed: true });
  });
  $('btn-extend').addEventListener('click', function () { act('/local/switch/extend'); });
  $('btn-off').addEventListener('click', function () { act('/local/switch/off'); });
  $('btn-dismiss').addEventListener('click', function () { act('/local/switch/dismiss'); });

  // ------------------------------------------------------------------ 1초마다 새로 물어보기

  var busy = false;

  function tick() {
    if (busy) return;
    busy = true;
    Promise.all([refreshReceived(), refreshSwitch()]).then(function () {
      show($('lost'), false);
    }).catch(function () {
      show($('lost'), true);
    }).then(function () {
      busy = false;
    });
  }

  show($('switch-off'), true);
  tick();
  setInterval(tick, POLL_MS);
})();
