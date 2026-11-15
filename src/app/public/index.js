// 성적 관리 앱 메인 화면 (두 앱이 똑같이 쓴다).
// 화면이 보여주는 모든 것은 서버가 실제로 돌려준 응답에서만 만든다.
// 서버가 돌려준 값은 전부 textContent로 그린다(HTML로 끼워 넣지 않는다).
// 응답을 아예 받지 못했을 때(연결 실패)는 "연결하지 못했습니다"라고 적는다. 결과 번호는 지어내지 않는다.

(function () {
  'use strict';

  var SUBJECTS = ['국어', '수학', '사회', '과학', '영어'];
  var RATING_VALUES = ['잘함', '보통', '노력요함'];

  var el = function (id) { return document.getElementById(id); };

  function ask(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
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

  var NO_CONNECTION = '연결하지 못했습니다. 서버가 켜져 있는지, 연결이 끊기지 않았는지 확인해 주세요.';

  function errorText(result, fallback) {
    if (result.failed) return fallback + ' ' + NO_CONNECTION;
    if (result.json && typeof result.json.error === 'string') return result.json.error;
    return fallback + ' (결과 번호 ' + result.status + ')';
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function show(id) { el(id).classList.remove('hidden'); }
  function hide(id) { el(id).classList.add('hidden'); }

  // ---------------------------------------------------------------- 성적표 그리기

  function renderReport(target, record) {
    clear(target);
    var table = document.createElement('table');
    var rows = [
      ['이름', record.name],
      ['학급', record.className]
    ];
    SUBJECTS.forEach(function (subject) {
      rows.push([subject, record.ratings ? record.ratings[subject] : '']);
    });
    rows.push(['담임 종합의견', record.comment]);
    rows.push(['보호자 이름', record.guardianName]);
    rows.push(['보호자 연락처', record.guardianPhone]);
    rows.forEach(function (pair) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.textContent = pair[0];
      var td = document.createElement('td');
      td.textContent = pair[1] === undefined || pair[1] === null ? '' : String(pair[1]);
      tr.appendChild(th);
      tr.appendChild(td);
      table.appendChild(tr);
    });
    target.appendChild(table);
  }

  // ---------------------------------------------------------------- 학부모 화면

  function showParent(studentId) {
    hide('login-view');
    hide('teacher-view');
    show('parent-view');
    ask('GET', '/api/students/' + encodeURIComponent(studentId)).then(function (result) {
      var box = el('parent-card');
      if (result.status === 200 && result.json) {
        renderReport(box, result.json);
      } else {
        clear(box);
        var p = document.createElement('p');
        p.className = 'feedback';
        p.textContent = errorText(result, '성적표를 불러오지 못했습니다.');
        box.appendChild(p);
      }
    });
  }

  // ---------------------------------------------------------------- 담임 화면

  var selectedId = null;

  function showTeacher() {
    hide('login-view');
    hide('parent-view');
    show('teacher-view');
    loadRoster();
  }

  function loadRoster() {
    ask('GET', '/api/roster').then(function (result) {
      var list = el('roster-list');
      clear(list);
      if (result.status === 200 && Array.isArray(result.json)) {
        result.json.forEach(function (item) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'minor';
          button.textContent = item.name + ' (' + item.id + ')';
          button.addEventListener('click', function () { openStudent(item.id, item.name); });
          list.appendChild(button);
        });
      } else {
        var p = document.createElement('p');
        p.className = 'feedback';
        p.textContent = errorText(result, '명단을 불러오지 못했습니다.');
        list.appendChild(p);
      }
    });
  }

  function openStudent(id, name) {
    selectedId = id;
    el('save-msg').textContent = '';
    el('delete-msg').textContent = '';
    clear(el('draft-box'));
    resetDeleteRow();
    show('detail');
    el('detail-title').textContent = name + ' (' + id + ') 성적표';
    ask('GET', '/api/students/' + encodeURIComponent(id)).then(function (result) {
      var card = el('detail-card');
      if (result.status === 200 && result.json) {
        renderReport(card, result.json);
        buildEditors(result.json.ratings || {});
      } else {
        clear(card);
        clear(el('rating-editors'));
        var p = document.createElement('p');
        p.className = 'feedback';
        p.textContent = errorText(result, '학생 기록을 불러오지 못했습니다.');
        card.appendChild(p);
      }
    });
  }

  function buildEditors(ratings) {
    var holder = el('rating-editors');
    clear(holder);
    SUBJECTS.forEach(function (subject) {
      var label = document.createElement('label');
      label.textContent = subject;
      var select = document.createElement('select');
      select.setAttribute('data-subject', subject);
      RATING_VALUES.forEach(function (value) {
        var option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        if (ratings[subject] === value) option.selected = true;
        select.appendChild(option);
      });
      holder.appendChild(label);
      holder.appendChild(select);
    });
  }

  function collectRatings() {
    var ratings = {};
    var selects = el('rating-editors').querySelectorAll('select[data-subject]');
    for (var i = 0; i < selects.length; i += 1) {
      ratings[selects[i].getAttribute('data-subject')] = selects[i].value;
    }
    return ratings;
  }

  function saveRatings() {
    if (!selectedId) return;
    el('save-msg').textContent = '';
    ask('PUT', '/api/students/' + encodeURIComponent(selectedId) + '/ratings', { ratings: collectRatings() })
      .then(function (result) {
        if (result.status === 200 && result.json) {
          el('save-msg').textContent = '저장되었습니다';
          renderReport(el('detail-card'), result.json);
        } else {
          el('save-msg').textContent = errorText(result, '성적을 저장하지 못했습니다.');
        }
      });
  }

  function makeDraft() {
    if (!selectedId) return;
    var box = el('draft-box');
    clear(box);
    ask('POST', '/api/students/' + encodeURIComponent(selectedId) + '/ai-draft').then(function (result) {
      var p = document.createElement('p');
      p.className = 'feedback';
      if (result.status === 200 && result.json && typeof result.json.draft === 'string') {
        p.textContent = '';
        var title = document.createElement('div');
        title.textContent = 'AI 종합의견 초안';
        title.style.fontWeight = '700';
        var pre = document.createElement('pre');
        pre.className = 'body';
        pre.textContent = result.json.draft;
        box.appendChild(title);
        box.appendChild(pre);
        return;
      }
      p.textContent = errorText(result, '초안을 만들지 못했습니다.');
      box.appendChild(p);
    });
  }

  function resetDeleteRow() {
    var row = el('delete-row');
    clear(row);
    var start = document.createElement('button');
    start.type = 'button';
    start.className = 'danger';
    start.textContent = '학생 기록 삭제';
    start.addEventListener('click', function () { confirmDelete(row); });
    row.appendChild(start);
  }

  function confirmDelete(row) {
    clear(row);
    var ask2 = document.createElement('span');
    ask2.className = 'feedback';
    ask2.textContent = '이 학생 기록을 삭제할까요?';
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'danger';
    yes.textContent = '삭제';
    yes.addEventListener('click', doDelete);
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'minor';
    no.textContent = '취소';
    no.addEventListener('click', function () { resetDeleteRow(); });
    row.appendChild(ask2);
    row.appendChild(yes);
    row.appendChild(no);
  }

  function doDelete() {
    if (!selectedId) return;
    ask('DELETE', '/api/students/' + encodeURIComponent(selectedId)).then(function (result) {
      if (result.status === 200) {
        el('delete-msg').textContent = '삭제되었습니다';
        hide('detail');
        selectedId = null;
        loadRoster();
      } else {
        el('delete-msg').textContent = errorText(result, '삭제하지 못했습니다.');
        resetDeleteRow();
      }
    });
  }

  // ---------------------------------------------------------------- 로그인 / 로그아웃

  function applySession(session) {
    if (session.role === 'teacher') showTeacher();
    else showParent(session.studentId);
  }

  function doLogout() {
    ask('POST', '/api/logout').then(function (result) {
      selectedId = null;
      hide('parent-view');
      hide('teacher-view');
      show('login-view');
      el('login-id').value = '';
      el('login-pw').value = '';
      // 요청이 가지 못했다면 서버에는 로그인이 남아 있을 수 있다. 그 사실을 알린다.
      el('login-msg').textContent = result.failed ? errorText(result, '로그아웃을 확인하지 못했습니다.') : '';
    });
  }

  function wire() {
    el('login-form').addEventListener('submit', function (event) {
      event.preventDefault();
      el('login-msg').textContent = '';
      ask('POST', '/api/login', { loginId: el('login-id').value, password: el('login-pw').value })
        .then(function (result) {
          if (result.status === 200 && result.json) {
            applySession(result.json);
          } else {
            el('login-msg').textContent = errorText(result, '로그인하지 못했습니다.');
          }
        });
    });
    el('parent-logout').addEventListener('click', doLogout);
    el('teacher-logout').addEventListener('click', doLogout);
    el('teacher-refresh').addEventListener('click', loadRoster);
    el('save-ratings').addEventListener('click', saveRatings);
    el('ai-draft').addEventListener('click', makeDraft);
    resetDeleteRow();
  }

  function start() {
    wire();
    ask('GET', '/api/app').then(function (result) {
      if (result.status === 200 && result.json && typeof result.json.label === 'string') {
        el('app-name').textContent = result.json.label;
      }
    });
    ask('GET', '/api/me').then(function (result) {
      if (result.status === 200 && result.json) {
        applySession(result.json);
        return;
      }
      show('login-view');
      if (result.failed) el('login-msg').textContent = NO_CONNECTION;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
