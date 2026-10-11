/* hh — чистка чатов.
 *
 * Расширение работает само, в фоне, без единой кнопки: оно перебирает
 * список чатов, покидает ненужные и коротко сообщает об этом всплывающей
 * плашкой в углу страницы. Плашка появляется сама и исчезает через 3
 * секунды: одна — когда расширение начинает работу, другая — сколько чатов
 * удалось покинуть. Никакого другого интерфейса у расширения нет.
 *
 * Ненужные — ровно по двум признакам и только по ним:
 *
 *   1. ОТКАЗ             — currentApplicantState === "DISCARD";
 *   2. ВАКАНСИЯ В АРХИВЕ — у объекта вакансии есть ключ "archived".
 *
 * Оба признака лежат прямо в ответе списка чатов, поэтому расширение не
 * делает ни одного запроса сверх чтения самого списка и самого покидания.
 *
 * Ничего больше не проверяется: ни даты последнего сообщения, ни того,
 * кто кому отвечал, ни «как давно молчат». Никакой оценочности.
 *
 * ── Правило, которому подчинено всё ────────────────────────────────────
 *
 * Нет полной уверенности, что чат можно покинуть, — чат НЕ покидается.
 * Чат с неопознанным признаком, непривычной формой ответа или ошибкой
 * чтения списка остаётся как есть. Ошибка обхода не оставляет «частично
 * покинутое»: пока список не прочитан целиком, не покидается никто.
 *
 * ── Когда срабатывает ──────────────────────────────────────────────────
 *
 *   1. при входе на страницу чатов — сразу: первой же показывается плашка
 *      «работает автоматическая очистка чатов» и запускается обход (вход на
 *      страницу и есть загрузка списка);
 *   2. когда сам сайт загружает страницу чатов — подгружает очередную
 *      пачку (по 20 чатов, в том числе периодически, без нашего участия) —
 *      эта страница читается и обходится.
 *
 * Работает только при загрузке страницы: какую страницу сайт загрузил —
 * ту расширение и обходит. Вглубь курсорной пагинацией оно не ходит и
 * ничего не делает от простой прокрутки. Слежения за адресом, событиями
 * прокрутки и мутациями DOM нет — только загрузка страницы.
 *
 * Загрузка страницы ловится перехватом запроса списка самим сайтом
 * (`GET /chatik/api/chats`): расширение перехватывает XHR/fetch, извлекает из
 * URL курсор загруженной страницы (`from`) и обрабатывает ровно её. Никаких
 * переборов и лишних событий. Перехват работает там, где браузер исполняет
 * "world": "MAIN" (Chrome, Edge).
 *
 * Перехват и отметка «мы на странице чатов» ставятся на document_start —
 * до кода сайта, поэтому не пропускается ни первый запрос списка, ни сам
 * факт открытия страницы. Свои обходы идут через fetch и за повод не
 * принимаются (счётчик scanRequests).
 *
 * Повторные заходы безопасны: покинутый чат просто исчезает из списка, а
 * каждый обход читает список заново. Никакого локального списка «уже
 * покинутых» расширение не ведёт.
 *
 * Работает целиком на куках текущей сессии hh.ru: ни токенов, ни паролей
 * расширению не нужно — запросы уходят с теми же куками, что и у сайта.
 * Покидание подтверждается не ответом сервера (он не доказывает ничего:
 * повторный POST возвращает 200 с тем же телом), а перечитыванием списка.
 */
(function () {
  'use strict';

  var V = window.HhVerdicts;
  if (!V) {
    console.error('[hh] verdicts.js не загрузился — расширение не работает');
    return;
  }

  var API = 'https://chatik.hh.ru/chatik/api';
  var LIST_URL = API + '/chats?filterUnread=false&filterHasTextMessage=false' +
                 '&do_not_track_session_events=false';
  var LEAVE_URL = API + '/bulk/leave';

  // размер пачки при покидании — ровно такой же, как у самого сайта
  var LEAVE_CHUNK = 20;
  // пауза между пачками покидания, чтобы не лить запросы подряд
  var LEAVE_DELAY_MS = 700;

  // путь запроса, которым сайт ходит за списком чатов
  var LIST_PATH = '/chatik/api/chats';

  var LOG = '[hh] ';

  // Диагностика: ход работы пишется в консоль страницы (F12 → Console).
  // Поставь false, чтобы выключить.
  var DEBUG = true;

  function dbg(message) {
    if (!DEBUG) return;
    console.info('[hh] ' + message);
  }

  // сколько своих запросов списка сейчас в полёте — чтобы перехват не
  // принимал собственный обход за обновление списка сайтом
  var scanRequests = 0;

  /* ------------------------------------------------------------------ */
  /* сеть                                                                */
  /* ------------------------------------------------------------------ */

  function msg(e) {
    return e && e.message ? e.message : String(e);
  }

  function tag(url) {
    return url.replace(API, '/chatik/api');
  }

  function getJSON(url) {
    scanRequests++;
    return withTimeout(fetch(url, { credentials: 'include' }).then(function (r) {
      scanRequests--;
      if (!r.ok) throw new Error('HTTP ' + r.status + ' на ' + tag(url));
      return r.json();
    }, function (e) {
      scanRequests--;
      throw e;
    }), REQUEST_MS);
  }

  var xsrfToken = null;

  // Сайт шлёт этот токен на все обращения к api-хосту; он лежит и в куке
  // _xsrf, и в конфигурации страницы. Проверено на живом POST 2026-10-09.
  function getXsrf() {
    if (xsrfToken) return xsrfToken;
    var m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
    if (m && m[1]) {
      xsrfToken = decodeURIComponent(m[1]);
      return xsrfToken;
    }
    var g = window.globalServiceVars && window.globalServiceVars.chatik;
    xsrfToken = (g && g.xsrfToken) || '';
    return xsrfToken;
  }

  function postJSON(url, body) {
    return withTimeout(fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Xsrftoken': getXsrf()
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (text) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' на ' + tag(url));
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
        if (parsed === null) throw new Error('нечитаемый ответ на ' + tag(url));
        return parsed;
      });
    }), REQUEST_MS);
  }

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  // Потолок на один запрос: если ответ не пришёл, обход падает ошибкой и
  // следующая активность запустит его заново — а не висит молча навсегда
  // (зависший обход блокировал бы все последующие поводы).
  var REQUEST_MS = 20000;

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('нет ответа ' + ms + ' мс')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); },
                   function (e) { clearTimeout(t); reject(e); });
    });
  }

  /* ------------------------------------------------------------------ */
  /* плашка                                                              */
  /* ------------------------------------------------------------------ */

  // Единственный видимый отклик расширения. Стили ставятся свойствами
  // элемента, а не через <style>: так их не блокирует CSP страницы.
  var TOAST_MS = 5000;
  var TOAST_FADE_MS = 250;
  var toastBox = null;

  function toastBoxEl() {
    if (toastBox && toastBox.parentNode) return toastBox;
    toastBox = document.createElement('div');
    toastBox.id = 'hh-cleaner-toasts';
    var s = toastBox.style;
    s.position = 'fixed';
    s.top = '16px';
    s.right = '16px';
    s.zIndex = '2147483647';
    s.display = 'flex';
    s.flexDirection = 'column';
    s.alignItems = 'flex-end';
    s.gap = '8px';
    s.pointerEvents = 'none';
    (document.body || document.documentElement).appendChild(toastBox);
    return toastBox;
  }

  function toast(text, kind) {
    // document_start: body ещё может не существовать — переносим показ на
    // момент готовности DOM, чтобы контейнер попал в body, а не в <html>.
    if (!document.body && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { toast(text, kind); },
        { once: true });
      return;
    }
    var el = document.createElement('div');
    el.setAttribute('data-hh-cleaner-toast', '');
    var s = el.style;
    s.maxWidth = '360px';
    s.padding = '10px 14px';
    s.borderRadius = '8px';
    s.font = '14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    s.color = '#fff';
    s.background = kind === 'ok'   ? '#1f7a3d'      // зелёный — всё в порядке
                 : kind === 'left' ? '#c0392b'      // красный — покинули чаты
                 : kind === 'warn' ? '#9a5b00'      // жёлтый — внимание
                 : 'rgba(20, 20, 20, 0.92)';         // нейтральный
    s.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.28)';
    s.opacity = '0';
    s.transform = 'translateY(-6px)';
    s.transition = 'opacity ' + TOAST_FADE_MS + 'ms ease, ' +
                   'transform ' + TOAST_FADE_MS + 'ms ease';
    el.textContent = text;
    toastBoxEl().appendChild(el);

    requestAnimationFrame(function () {
      s.opacity = '1';
      s.transform = 'translateY(0)';
    });
    setTimeout(function () {
      s.opacity = '0';
      s.transform = 'translateY(-6px)';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, TOAST_FADE_MS + 30);
    }, TOAST_MS);
  }

  /* ------------------------------------------------------------------ */
  /* сбор списка                                                         */
  /* ------------------------------------------------------------------ */

  // Курсор последней прочитанной страницы (для перечитывания при проверке).
  var lastReadFrom = null;

  // Читает одну страницу списка по курсору (null — первую). Своей
  // пагинацией вглубь не ходит: какую страницу загрузил сайт — ту и читаем.
  // Ресурсы и заголовки лежат на той же странице, что и сами чаты, поэтому
  // признак ищется в рамках прочитанной страницы.
  function readPage(cursor) {
    var scan = V.newScan();
    var url = LIST_URL + (cursor ? '&from=' + encodeURIComponent(cursor) : '');
    return getJSON(url).then(function (j) {
      var items = (j.chats && j.chats.items) || [];
      V.accumulatePage(scan, j);
      return {
        items: items,
        resources: scan.resources,
        displayInfo: scan.displayInfo,
        pages: 1,
        found: (j.chats && j.chats.found) || 0
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* покидание                                                           */
  /* ------------------------------------------------------------------ */

  function leaveChats(ids) {
    var applied = 0, rejected = 0, sentChunks = 0, error = null;

    function chunk(from) {
      if (from >= ids.length) return Promise.resolve();
      var part = ids.slice(from, from + LEAVE_CHUNK);
      return postJSON(LEAVE_URL, { chatIds: part })
        .then(function (r) {
          // Сервер отвечает applied/rejected массивами id (проверено боевым
          // POST 2026-10-09). Счётчики приходят с каждым ответом.
          applied += (Array.isArray(r.applied) ? r.applied.length : 0);
          rejected += (Array.isArray(r.rejected) ? r.rejected.length : 0);
          sentChunks++;
          return sleep(LEAVE_DELAY_MS).then(function () {
            return chunk(from + LEAVE_CHUNK);
          });
        })
        .catch(function (e) {
          // как сайт: прерываемся, неотправленные остаются нетронутыми
          error = msg(e);
          return null;
        });
    }

    return chunk(0).then(function () {
      return { applied: applied, rejected: rejected, error: error, sentChunks: sentChunks };
    });
  }

  // Ответ сервера не является доказательством: повторный POST того же чата
  // возвращает 200 с тем же телом (проверено 2026-10-09). Поэтому
  // фактическое покидание подтверждаем перечитыванием списка — чат должен
  // из него исчезнуть.
  function verifyGone(ids) {
    if (!ids.length) return Promise.resolve({ gone: [], leftOver: [] });
    // перечитываем ту же страницу, с которой покидали
    return readPage(lastReadFrom).then(function (all) {
      var present = {};
      all.items.forEach(function (it) { present[String(it.id)] = true; });
      var gone = [], leftOver = [];
      ids.forEach(function (id) { (present[id] ? leftOver : gone).push(id); });
      return { gone: gone, leftOver: leftOver };
    });
  }

  /* ------------------------------------------------------------------ */
  /* один проход                                                         */
  /* ------------------------------------------------------------------ */

  // Плашка «чистить нечего» — один раз за вход на страницу.
  var nothingTold = false;

  function toastNothing() {
    if (nothingTold) return;
    nothingTold = true;
    toast('hh: нет чатов, которые нужно покинуть', 'ok');
  }

  function runCycle(why, cursor) {
    return readPage(cursor).then(function (all) {
      lastReadFrom = cursor;
      var chats = V.buildChats(all.items, all.resources, all.displayInfo);

      var ids = [], blocked = 0;
      chats.forEach(function (c) {
        if (!c.reasons.length) return;
        if (c.canLeave) ids.push(c.id);
        else blocked++;
      });

      dbg('обход (' + why + '): чатов на странице ' + all.items.length +
        (all.found ? ' из ' + all.found : '') +
        ', откликов ' + chats.length + ', к покиданию ' + ids.length +
        (blocked ? ' (сервер не разрешает ' + blocked + ')' : ''));

      if (!ids.length) {
        if (blocked) {
          console.warn(LOG + 'ненужных чатов: ' + blocked +
            ', но сервер не разрешает их покинуть — оставлены как есть');
          toast('hh: ненужные чаты есть, но сервер не разрешает их покинуть', 'warn');
        } else {
          toastNothing();
        }
        return;
      }

      console.log(LOG + why + ': покидаю ' + ids.length + ' ' +
        V.plural(ids.length, 'чат', 'чата', 'чатов') +
        (blocked ? ' (ещё ' + blocked + ' сервер покинуть не разрешил)' : '') + '…');

      return leaveChats(ids).then(function (res) {
        if (res.error) {
          console.warn(LOG + 'покидание прервано: ' + res.error +
            ' (принято ' + res.applied + ', отклонено ' + res.rejected + ')');
        }
        return verifyGone(ids).then(function (ver) {
          dbg('проверка: покинуто ' + ver.gone.length + ' из ' + ids.length +
            (ver.leftOver.length ? ', остались ' + ver.leftOver.length : ''));
          console.log(LOG + 'покинуто ' + ver.gone.length + ' из ' + ids.length +
            (ver.leftOver.length ? ', остались в списке: ' + ver.leftOver.length : '') +
            (res.rejected ? ', отклонено сервером: ' + res.rejected : ''));
          if (ver.gone.length) {
            toast(V.leftMessage(ver.gone.length), 'left');
          } else {
            toast('hh: покидание не подтвердилось — чаты остались в списке', 'warn');
          }
        }).catch(function (e) {
          console.warn(LOG + 'отправлено, но подтвердить перечитыванием не удалось: ' +
            msg(e));
        });
      });
    }).catch(function (e) {
      // нет уверенности — не покинуто ничего; следующий заход попробует снова
      console.warn(LOG + 'обход не удался, ничего не покинуто: ' + msg(e));
    });
  }

  /* ------------------------------------------------------------------ */
  /* поводы: активность списка                                           */
  /* ------------------------------------------------------------------ */

  // Своих XHR у расширения нет (обходы идут через fetch), поэтому любой GET
  // к /chatik/api/chats — это сайт. Годится и первая выдача, и страница
  // очередной порции (from=). Повод, но не единственный: перехват работает,
  // только если браузер исполняет "world": "MAIN".
  function isListRequest(url, method) {
    if (!url) return false;
    if ((method || 'GET').toUpperCase() !== 'GET') return false;
    return String(url).indexOf(LIST_PATH) !== -1;
  }

  // Курсор страницы из URL запроса сайта (null — первая страница).
  function listCursor(url) {
    var m = String(url).match(/[?&]from=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function isChatPage() {
    return /^\/chat(\/|$)/.test(location.pathname);
  }

  var announced = false;
  var running = false;
  var pendingWhy = null;
  var pendingCursor = null;

  // Единственный повод — загрузка страницы чатов. Реагируем только на неё:
  // никаких слежений за адресом, прокруткой и прочими событиями.
  function trigger(why, cursor) {
    if (!isChatPage()) return;
    if (running) { pendingWhy = why; pendingCursor = cursor; return; } // обход идёт — после него повторим
    if (!announced) { announced = true; toast(V.START_MESSAGE); }
    dbg('повод: ' + why + (cursor ? ' (страница ' + cursor.slice(0, 24) + '…)' : ''));
    running = true;
    var done = function () {
      running = false;
      if (pendingWhy) { var w = pendingWhy, c = pendingCursor; pendingWhy = null; pendingCursor = null; trigger(w, c); }
    };
    runCycle(why, cursor).then(done, done);
  }

  /* ------------------------------------------------------------------ */
  /* перехват запросов сайта (быстрый повод, где доступен main-world)    */
  /* ------------------------------------------------------------------ */

  // Сайт ходит за списком через XMLHttpRequest. Своих XHR у расширения нет,
  // поэтому обособлять здесь нечего: успешный такой запрос и есть повод.
  function hookXHR() {
    var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__hhHooked) return;
    var open = proto.open, send = proto.send;
    proto.open = function (method, url) {
      this.__hhListRequest = isListRequest(url, method);
      this.__hhCursor = listCursor(url);
      return open.apply(this, arguments);
    };
    proto.send = function () {
      if (this.__hhListRequest) {
        var xhr = this, cursor = this.__hhCursor;
        xhr.addEventListener('load', function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            trigger('сайт загрузил страницу', cursor);
          }
        });
      }
      return send.apply(this, arguments);
    };
    proto.__hhHooked = true;
  }

  // Перехват fetch — на случай, если сайт когда-нибудь сменит транспорт.
  // Свои обходы идут через fetch, поэтому их исключаем счётчиком.
  function hookFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__hhHooked) return;
    var orig = window.fetch;
    var wrapped = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      var method = (init && init.method) || (input && input.method) || 'GET';
      var mine = scanRequests > 0;
      var p = orig.apply(this, arguments);
      if (!mine && isListRequest(url, method)) {
        var cursor = listCursor(url);
        p.then(function (r) {
          if (r && r.ok) trigger('сайт загрузил страницу', cursor);
        }, function () {});
      }
      return p;
    };
    wrapped.__hhHooked = true;
    window.fetch = wrapped;
  }

  /* ------------------------------------------------------------------ */
  /* догрузка страницы сайтом (не зависит от main-world)                 */
  /* ------------------------------------------------------------------ */

  // Всё ставится на document_start — до кода сайта, поэтому не пропускается
  // ни первый запрос списка, ни сам факт открытия страницы чатов.
  dbg('запуск: ' +
    (typeof window.chrome !== 'undefined' && window.chrome.runtime && window.chrome.runtime.id
      ? 'изолированный мир' : 'главный мир') +
    ', путь ' + location.pathname);
  hookXHR();
  hookFetch();
})();
