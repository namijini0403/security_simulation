// 옆 사람 화면 (두 앱이 똑같이 쓴다).
// 이 화면이 보내는 모든 요청에는 'X-Demo-Screen: neighbor' 표시를 붙인다(화면 표시용일 뿐).
// 표시하는 것은 전부 실제 응답에서 만든다. 미리 정해 둔 성공·거절 문구는 없다.
// 응답을 아예 받지 못했을 때(연결 실패)는 그 사실을 그대로 적고, 결과 번호는 '응답 없음'으로 둔다.

(function () {
  'use strict';

  var SCREEN_HEADER = 'X-Demo-Screen';
  var SCREEN_MARK = 'neighbor';
  var COLLECT_GAP_MS = 150; // 반 전체 수집에서 요청 사이 간격(조정 가능).
  var RECHECK_GAP_MS = 2000; // 들어주지 않은 응답 뒤에 "지금 누구인가"를 다시 묻는 최소 간격.
  var ALL_GOOD = { '국어': '잘함', '수학': '잘함', '사회': '잘함', '과학': '잘함', '영어': '잘함' };

  var el = function (id) { return document.getElementById(id); };
  var currentLogin = null; // 마지막으로 로그인에 성공한 사람 또는 /api/me가 알려 준 사람.
  // 기억한 로그인을 바꾸는 일(로그인·로그아웃 단추, /api/me 질문)마다 커지는 번호.
  // 늦게 도착한 예전 /api/me 대답이 더 새로운 상태를 덮어쓰지 않게 하는 데 쓴다.
  var whoSeq = 0;
  var lastRecheckAt = null; // 마지막으로 다시 물은 시각(아직 없으면 null).

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
    }).then(null, function (error) {
      // 요청이 서버에 가지 못했거나 응답을 끝까지 받지 못했다(서버가 꺼졌거나 연결이 끊겼다).
      // 응답이 없으므로 결과 번호도 없다(status: null). 번호를 지어내지 않는다.
      var detail = error && typeof error.message === 'string' && error.message !== '' ? error.message : '';
      return { status: null, json: undefined, failed: true, detail: detail };
    });
  }

  // 응답을 받지 못했을 때 보여줄 글. 브라우저가 알려 준 내용이 있으면 그대로 붙인다.
  function failureText(result) {
    return '연결하지 못했습니다. 서버가 켜져 있는지, 연결이 끊기지 않았는지 확인해 주세요.'
      + (result.detail ? ' (브라우저가 알려 준 내용: ' + result.detail + ')' : '');
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
    appendPair(dl, '결과 번호', result.failed ? '응답 없음' : String(result.status));
    entry.appendChild(dl);

    if (result.failed) {
      var failure = document.createElement('div');
      failure.textContent = failureText(result);
      entry.appendChild(failure);
    } else {
      entry.appendChild(renderReceived(result.json));
    }

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

  // 서버가 요청을 들어주지 않았다면(응답은 받았는데 결과 번호가 200이 아니다) 기억한 로그인이
  // 지금도 맞는지 알 수 없다(예: 전체 초기화로 로그인이 풀렸다). 어떤 번호가 무슨 뜻인지 여기서
  // 짐작하지 않고, 서버에 "지금 누구로 로그인되어 있는가"를 다시 물어 그 대답으로 기억을 고친다.
  // 그런 다음에 결과 줄을 적으므로 '요청한 사람'은 서버의 실제 대답을 따른다.
  // 다시 묻지 않는 경우: 응답을 받지 못했을 때, 200일 때, 기억한 로그인이 없을 때,
  // 그리고 마지막으로 물은 지 RECHECK_GAP_MS가 지나지 않았을 때(거절이 이어져도 접속 기록이 넘치지 않게).
  function confirmWho(result) {
    if (result.failed || result.status === 200 || !currentLogin) return result;
    var now = Date.now();
    if (lastRecheckAt !== null && now - lastRecheckAt < RECHECK_GAP_MS) return result;
    lastRecheckAt = now;
    return refreshWho().then(function () { return result; });
  }

  function oneShot(method, path, studentId, body) {
    return ask(method, path, body).then(confirmWho).then(function (result) {
      addEntry(method, path, studentId, result);
      return result;
    });
  }

  function doLogin() {
    var path = '/api/login';
    whoSeq += 1; // 이보다 먼저 보낸 /api/me 질문의 대답은 이제 쓰지 않는다.
    ask('POST', path, { loginId: 'parent01', password: 'demo1234' }).then(function (result) {
      if (result.status === 200 && result.json && typeof result.json.loginId === 'string') {
        whoSeq += 1;
        currentLogin = result.json.loginId;
      }
      el('who').textContent = who();
      addEntry('POST', path, '-', result);
    });
  }

  function doLogout() {
    var path = '/api/logout';
    whoSeq += 1; // 이보다 먼저 보낸 /api/me 질문의 대답은 이제 쓰지 않는다.
    ask('POST', path).then(function (result) {
      addEntry('POST', path, '-', result);
      if (result.status === 200) {
        whoSeq += 1;
        currentLogin = null;
      }
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

    function finish() {
      collecting = false;
      el('btn-collect').disabled = false;
    }

    function step() {
      if (index > 20) {
        finish();
        return;
      }
      var id = studentNumber(index);
      index += 1;
      var path = '/api/students/' + id;
      ask('GET', path).then(confirmWho).then(function (result) {
        addEntry('GET', path, id, result);
        if (result.failed) {
          // 응답을 받지 못했다: 서버가 거절한 것이 아니므로 세지 않고, 남은 번호는 보내지 않고 여기서 멈춘다.
          // 버튼은 다시 누를 수 있다.
          finish();
          return;
        }
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
      }).then(null, finish); // 그리다가 문제가 생겨도 버튼이 잠긴 채 남지 않게 한다.
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
    refreshWho();
    // 같은 브라우저의 다른 창에서 로그인이 바뀌었을 수 있으므로,
    // 이 창으로 돌아올 때마다 지금 누구로 로그인되어 있는지 다시 물어본다.
    window.addEventListener('focus', refreshWho);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshWho();
    });
  }

  // 서버에 "지금 누구로 로그인되어 있는가"를 묻고 그 대답으로 기억을 고친다.
  function refreshWho() {
    whoSeq += 1;
    var asked = whoSeq;
    return ask('GET', '/api/me').then(function (result) {
      // 묻고 나서 대답이 오기 전에 로그인·로그아웃을 눌렀거나 더 새로 물었다면, 이 대답은 예전 것이다.
      if (asked !== whoSeq) return;
      if (result.status === 200 && result.json && typeof result.json.loginId === 'string') {
        currentLogin = result.json.loginId;
      } else if (!result.failed) {
        // 응답은 받았는데 로그인한 사람을 알려 주지 않았다: 지금은 로그인된 사람이 없다.
        currentLogin = null;
      }
      // 응답을 받지 못했으면 기억을 바꾸지 않는다.
      el('who').textContent = who();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
