// 옆 사람 화면 (두 앱이 똑같이 쓴다).
// 이 화면이 보내는 모든 요청에는 'X-Demo-Screen: neighbor' 표시를 붙인다(화면 표시용일 뿐).
// 표시하는 것은 전부 실제 응답에서 만든다. 미리 정해 둔 성공·거절 문구는 없다.

(function () {
  'use strict';

  var SCREEN_HEADER = 'X-Demo-Screen';
  var SCREEN_MARK = 'neighbor';
  var COLLECT_GAP_MS = 150; // 반 전체 수집에서 요청 사이 간격(조정 가능).
  var ALL_GOOD = { '국어': '잘함', '수학': '잘함', '사회': '잘함', '과학': '잘함', '영어': '잘함' };

  var el = function (id) { return document.getElementById(id); };
  var currentLogin = null; // 마지막으로 로그인에 성공한 사람 또는 /api/me가 알려 준 사람.

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function who() { return currentLogin ? currentLogin : '로그인 안 함'; }

  function ask(method, path, body) {
    var headers = {};
    headers[SCREEN_HEADER] = SCREEN_MARK;
    var init = { method: method, credentials: 'same-origin', headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var json;
        try { json = text === '' ? undefined : JSON.parse(text); } catch (e) { json = undefined; }
        return { status: response.status, json: json };
      });
    });
  }

  function isStudentRecord(value) {
    return value && typeof value === 'object' && typeof value.id === 'string' && value.ratings && typeof value.ratings === 'object';
  }

  // ---------------------------------------------------------------- 결과 한 줄 그리기

  function addEntry(method, path, studentId, result) {
    var entry = document.createElement('div');
    entry.className = 'entry';

    var dl = document.createElement('dl');
    appendPair(dl, '요청 주소', method + ' ' + path);
    appendPair(dl, '요청한 사람', who());
    appendPair(dl, '대상 학생 번호', studentId ? studentId : '-');
    appendPair(dl, '결과 번호', String(result.status));
    entry.appendChild(dl);

    entry.appendChild(renderReceived(result.json));

    var feed = el('feed');
    feed.insertBefore(entry, feed.firstChild);
  }

  function appendPair(dl, term, value) {
    var dt = document.createElement('dt');
    dt.textContent = term;
    var dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderReceived(json) {
    if (json === undefined) {
      var none = document.createElement('div');
      none.textContent = '받은 내용 없음';
      return none;
    }
    if (isStudentRecord(json)) return recordTable([json]);
    if (Array.isArray(json) && json.length > 0 && isStudentRecord(json[0])) return recordTable(json);
    var pre = document.createElement('pre');
    pre.className = 'body';
    pre.textContent = JSON.stringify(json, null, 2);
    return pre;
  }

  function recordTable(records) {
    var table = document.createElement('table');
    var head = document.createElement('tr');
    ['이름', '성적', '담임 종합의견', '보호자 연락처'].forEach(function (title) {
      var th = document.createElement('th');
      th.textContent = title;
      head.appendChild(th);
    });
    table.appendChild(head);
    records.forEach(function (record) {
      var tr = document.createElement('tr');
      tr.appendChild(cell(record.name));
      tr.appendChild(cell(ratingsText(record.ratings)));
      tr.appendChild(cell(record.comment));
      tr.appendChild(cell((record.guardianName || '') + ' ' + (record.guardianPhone || '')));
      table.appendChild(tr);
    });
    return table;
  }

  function cell(text) {
    var td = document.createElement('td');
    td.textContent = text === undefined || text === null ? '' : String(text);
    return td;
  }

  function ratingsText(ratings) {
    if (!ratings || typeof ratings !== 'object') return '';
    return ['국어', '수학', '사회', '과학', '영어'].map(function (subject) {
      return subject + ' ' + (ratings[subject] === undefined ? '' : ratings[subject]);
    }).join(', ');
  }

  // ---------------------------------------------------------------- 버튼 하나하나

  function oneShot(method, path, studentId, body) {
    return ask(method, path, body).then(function (result) {
      addEntry(method, path, studentId, result);
      return result;
    });
  }

  function doLogin() {
    var path = '/api/login';
    ask('POST', path, { loginId: 'parent01', password: 'demo1234' }).then(function (result) {
      if (result.status === 200 && result.json && typeof result.json.loginId === 'string') {
        currentLogin = result.json.loginId;
      }
      el('who').textContent = who();
      addEntry('POST', path, '-', result);
    });
  }

  function doLogout() {
    var path = '/api/logout';
    ask('POST', path).then(function (result) {
      addEntry('POST', path, '-', result);
      if (result.status === 200) currentLogin = null;
      el('who').textContent = who();
    });
  }

  // ---------------------------------------------------------------- 반 전체 수집

  var collecting = false;

  function studentNumber(n) {
    return 'TEST-10' + (n < 10 ? '0' + n : String(n));
  }

  function doCollect() {
    if (collecting) return;
    collecting = true;
    el('btn-collect').disabled = true;
    el('count-got').textContent = '0';
    el('count-refused').textContent = '0';
    var box = el('collect-table');
    clear(box);
    var table = document.createElement('table');
    var head = document.createElement('tr');
    ['이름', '성적', '담임 종합의견', '보호자 연락처'].forEach(function (title) {
      var th = document.createElement('th');
      th.textContent = title;
      head.appendChild(th);
    });
    table.appendChild(head);
    box.appendChild(table);

    var got = 0;
    var refused = 0;
    var seen = {};
    var index = 1;

    function step() {
      if (index > 20) {
        collecting = false;
        el('btn-collect').disabled = false;
        return;
      }
      var id = studentNumber(index);
      index += 1;
      var path = '/api/students/' + id;
      ask('GET', path).then(function (result) {
        addEntry('GET', path, id, result);
        if (result.status === 200 && isStudentRecord(result.json)) {
          if (!seen[result.json.id]) {
            seen[result.json.id] = true;
            got += 1;
            el('count-got').textContent = String(got);
          }
          var record = result.json;
          var tr = document.createElement('tr');
          tr.appendChild(cell(record.name));
          tr.appendChild(cell(ratingsText(record.ratings)));
          tr.appendChild(cell(record.comment));
          tr.appendChild(cell((record.guardianName || '') + ' ' + (record.guardianPhone || '')));
          table.appendChild(tr);
        } else {
          // 거절된 요청과 없는 번호는 모두 받아내지 못한 것으로 센다.
          refused += 1;
          el('count-refused').textContent = String(refused);
        }
        setTimeout(step, COLLECT_GAP_MS);
      });
    }
    step();
  }

  // ---------------------------------------------------------------- 준비

  function fillPicker() {
    var picker = el('pick-id');
    for (var n = 2; n <= 20; n += 1) {
      var id = studentNumber(n);
      var option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      picker.appendChild(option);
    }
  }

  function wire() {
    el('btn-roster').addEventListener('click', function () { oneShot('GET', '/api/roster', '-'); });
    el('btn-login').addEventListener('click', doLogin);
    el('btn-mine').addEventListener('click', function () {
      oneShot('GET', '/api/students/TEST-1001', 'TEST-1001');
    });
    el('btn-pick').addEventListener('click', function () {
      var id = el('pick-id').value;
      oneShot('GET', '/api/students/' + id, id);
    });
    el('btn-collect').addEventListener('click', doCollect);
    el('btn-list').addEventListener('click', function () { oneShot('GET', '/api/students', '-'); });
    el('btn-fix').addEventListener('click', function () {
      oneShot('PUT', '/api/students/TEST-1001/ratings', 'TEST-1001', { ratings: ALL_GOOD });
    });
    el('logout').addEventListener('click', doLogout);
  }

  function start() {
    fillPicker();
    wire();
    ask('GET', '/api/app').then(function (result) {
      if (result.status === 200 && result.json && typeof result.json.label === 'string') {
        el('app-name').textContent = result.json.label;
      }
    });
    ask('GET', '/api/me').then(function (result) {
      if (result.status === 200 && result.json && typeof result.json.loginId === 'string') {
        currentLogin = result.json.loginId;
        el('who').textContent = who();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
