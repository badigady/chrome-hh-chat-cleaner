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
 *   2. когда сам сайт заново запрашивает список чатов (`GET
 *      /chatik/api/chats`) — этот запрос и есть «список обновился».
 *
 * Живой замер 2026-10-09 показал, что сайт ходит за списком через
 * XMLHttpRequest примерно раз в 2 минуты (initiatorType "xmlhttprequest"),
 * поэтому перехватывается именно этот запрос, а не изменения DOM и не
 * таймер. Своего периодического опроса у расширения нет: ритм задаёт сайт.
 *
 * Перехват и отметка «мы на странице чатов» ставятся на document_start —
 * до кода сайта, поэтому не пропускается ни первый запрос списка, ни сам
 * факт открытия страницы. Свои обходы идут через fetch и за обновление
 * списка сайтом не принимаются (счётчик scanRequests).
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
  // потолок на число страниц списка — защита от зацикливания пагинации: если
  // сервер начнёт повторять курсор, обход остановится ошибкой (и ничего не
  // будет покинуто), а не бесконечным потоком запросов. На живом аккаунте
  // страниц ~46.
  var MAX_PAGES = 200;

  // тишина после последнего изменения списка перед обходом
  var SETTLE_MS = 4000;
  // не чаще одного обхода в это время
  var MIN_INTERVAL_MS = 2 * 60 * 1000;

  // путь запроса, которым сайт обновляет список чатов (без курсора from=)
  var LIST_PATH = '/chatik/api/chats';

  var LOG = '[hh] ';

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
    return fetch(url, { credentials: 'include' }).then(function (r) {
      scanRequests--;
      if (!r.ok) throw new Error('HTTP ' + r.status + ' на ' + tag(url));
      return r.json();
    }, function (e) {
      scanRequests--;
      throw e;
    });
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
    return fetch(url, {
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
    });
  }

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  /* ------------------------------------------------------------------ */
  /* плашка                                                              */
  /* ------------------------------------------------------------------ */

  // Единственный видимый отклик расширения. Стили ставятся свойствами
  // элемента, а не через <style>: так их не блокирует CSP страницы.
  var TOAST_MS = 3000;
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
    s.background = kind === 'ok'   ? '#1f7a3d'
                 : kind === 'warn' ? '#9a5b00'
                 : 'rgba(20, 20, 20, 0.92)';
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

  // Курсорная пагинация: сервер отдаёт nextFrom, по нему берётся следующая
  // страница. Возвращает весь список одним проходом.
  //
  // Ресурсы и заголовки лежат на той же странице, что и сами чаты, поэтому
  // ключ чата может оказаться на любой из ~46 страниц. Накопление живёт в
  // verdicts.js (newScan/accumulatePage), чтобы оно было покрыто тестом:
  // перезапись содержимого последней страницей вместо слияния оставляет
  // признаки в нуле — на последней странице ~15 записей из 915, и ключа
  // archived среди них может не быть. Такую ошибку уже допускали.
  function listAllChats() {
    var items = [], from = null, pages = 0;
    var scan = V.newScan();

    function step() {
      if (++pages > MAX_PAGES) {
        return Promise.reject(new Error('список чатов не заканчивается (страниц больше ' +
          MAX_PAGES + ') — обход остановлен'));
      }
      var url = LIST_URL + (from ? '&from=' + encodeURIComponent(from) : '');
      return getJSON(url).then(function (j) {
        var page = (j.chats && j.chats.items) || [];
        for (var i = 0; i < page.length; i++) items.push(page[i]);
        V.accumulatePage(scan, j);

        from = j.chats && j.chats.nextFrom;
        if (!from || !page.length) {
          return { items: items, resources: scan.resources, displayInfo: scan.displayInfo };
        }
        return step();
      });
    }
    return step();
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
    return listAllChats().then(function (all) {
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

  function runCycle(why) {
    return listAllChats().then(function (all) {
      var chats = V.buildChats(all.items, all.resources, all.displayInfo);

      var ids = [], blocked = 0;
      chats.forEach(function (c) {
        if (!c.reasons.length) return;
        if (c.canLeave) ids.push(c.id);
        else blocked++;
      });

      if (!ids.length) {
        if (blocked) {
          console.warn(LOG + 'ненужных чатов: ' + blocked +
            ', но сервер не разрешает их покинуть — оставлены как есть');
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
          console.log(LOG + 'покинуто ' + ver.gone.length + ' из ' + ids.length +
            (ver.leftOver.length ? ', остались в списке: ' + ver.leftOver.length : '') +
            (res.rejected ? ', отклонено сервером: ' + res.rejected : ''));
          if (ver.gone.length) {
            toast(V.leftMessage(ver.gone.length), 'ok');
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
  /* повод: сайт обновил список чатов                                    */
  /* ------------------------------------------------------------------ */

  // Единственный повод для обхода — запрос списка, который делает САМ сайт.
  // Наблюдение за DOM не используется: оно срабатывало бы на любую
  // перерисовку. Своего опроса по таймеру тоже нет вовсе.
  function isListRefresh(url, method) {
    if (!url) return false;
    if ((method || 'GET').toUpperCase() !== 'GET') return false;
    if (String(url).indexOf(LIST_PATH) === -1) return false;
    // страница очередной порции (курсор from=) — не «обновление списка»
    return String(url).indexOf('from=') === -1;
  }

  function isChatPage() {
    return /^\/chat(\/|$)/.test(location.pathname);
  }

  var pendingTimer = null;
  var lastRunAt = 0;
  var running = false;
  var announced = false;

  // Свести все поводы к одному отложенному проходу. Пауза — не меньше
  // SETTLE_MS после последнего изменения и не меньше MIN_INTERVAL_MS после
  // прошлого прохода.
  function schedule(why) {
    if (pendingTimer) return;
    var wait = Math.max(SETTLE_MS, MIN_INTERVAL_MS - (Date.now() - lastRunAt));
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      if (running) return;
      running = true;
      lastRunAt = Date.now();
      runCycle(why).then(function () { running = false; },
                         function () { running = false; });
    }, wait);
  }

  // Повод к работе: сначала обещанная плашка о старте (один раз за вход),
  // затем отложенный обход. Срабатываем только на странице чатов.
  function trigger(why) {
    if (!isChatPage()) return;
    if (!announced) { announced = true; toast(V.START_MESSAGE); }
    schedule(why);
  }

  // Вход на страницу чатов — сразу уведомляем и запускаем первый обход
  // (вход на страницу и есть загрузка списка). Уход со страницы сбрасывает
  // отметку, чтобы при следующем входе плашка показалась снова, и снимает
  // ещё не сработавший обход.
  function onRouteChange() {
    if (isChatPage()) {
      trigger('страница чатов открыта');
    } else {
      announced = false;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    }
  }

  // Сайт ходит за списком через XMLHttpRequest. Своих XHR у расширения нет,
  // поэтому обособлять здесь нечего: успешный такой запрос и есть повод.
  function hookXHR() {
    var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__hhHooked) return;
    var open = proto.open, send = proto.send;
    proto.open = function (method, url) {
      this.__hhListRefresh = isListRefresh(url, method);
      return open.apply(this, arguments);
    };
    proto.send = function () {
      if (this.__hhListRefresh) {
        var xhr = this;
        xhr.addEventListener('load', function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            trigger('сайт обновил список чатов');
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
      if (!mine && isListRefresh(url, method)) {
        p.then(function (r) {
          if (r && r.ok) trigger('сайт обновил список чатов');
        }, function () {});
      }
      return p;
    };
    wrapped.__hhHooked = true;
    window.fetch = wrapped;
  }

  // Смена адреса внутри приложения без перезагрузки страницы.
  function hookHistory() {
    var push = history.pushState, replace = history.replaceState;
    history.pushState = function () {
      var r = push.apply(this, arguments); onRouteChange(); return r;
    };
    history.replaceState = function () {
      var r = replace.apply(this, arguments); onRouteChange(); return r;
    };
    window.addEventListener('popstate', onRouteChange);
  }

  // Всё ставится на document_start — до кода сайта, поэтому не пропускается
  // ни первый запрос списка, ни сам факт открытия страницы чатов.
  hookXHR();
  hookFetch();
  hookHistory();
  onRouteChange();
})();
