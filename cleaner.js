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
 *   2. при прокрутке списка и догрузке очередной порции чатов — список
 *      читается заново;
 *   3. когда сам сайт заново запрашивает список чатов (`GET
 *      /chatik/api/chats`).
 *
 * Поводы 2 и 3 намеренно не зависят от «мира» content script. Список у
 * сайта виртуализирован (строки пересоздаются при прокрутке), поэтому
 * слушаются прокрутка контейнера (capture-фаза — событие scroll не
 * всплывает), изменения DOM внутри контейнера и — самый надёжный сигнал,
 * который браузер не может «проглотить», — раз в полторы секунды
 * читаются scrollTop (прокрутили) и scrollHeight (догрузили). Перехват
 * XMLHttpRequest/fetch оставлен как дополнительный, быстрый повод там,
 * где он работает. Смена адреса внутри приложения отслеживается опросом
 * location.href — тоже из любого мира.
 *
 * Перехват и отметка «мы на странице чатов» ставятся на document_start —
 * до кода сайта, поэтому не пропускается ни первый запрос списка, ни сам
 * факт открытия страницы. Свои обходы идут через fetch и за повод не
 * принимаются (счётчик scanRequests); все поводы сводятся к одному
 * отложенному обходу с «дебаунсом» (SETTLE_MS «тишины», не чаще
 * MIN_INTERVAL_MS).
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

  // «Тишина» после последней активности списка перед обходом: каждая новая
  // прокрутка или догрузка перезапускает отсчёт (дебаунс).
  var SETTLE_MS = 4000;
  // не чаще одного обхода в это время
  var MIN_INTERVAL_MS = 15000;

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
    var items = [], from = null, pages = 0, found = 0;
    var scan = V.newScan();

    function step() {
      if (++pages > MAX_PAGES) {
        return Promise.reject(new Error('список чатов не заканчивается (страниц больше ' +
          MAX_PAGES + ') — обход остановлен'));
      }
      var url = LIST_URL + (from ? '&from=' + encodeURIComponent(from) : '');
      return getJSON(url).then(function (j) {
        var page = (j.chats && j.chats.items) || [];
        if (pages === 1) found = (j.chats && j.chats.found) || 0;
        for (var i = 0; i < page.length; i++) items.push(page[i]);
        V.accumulatePage(scan, j);

        from = j.chats && j.chats.nextFrom;
        if (!from || !page.length) {
          return { items: items, resources: scan.resources,
                   displayInfo: scan.displayInfo, pages: pages, found: found };
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

  // Плашка «чистить нечего» — один раз за вход на страницу, чтобы не
  // повторяться на каждой прокрутке.
  var nothingTold = false;

  function toastNothing() {
    if (nothingTold) return;
    nothingTold = true;
    toast('hh: чистить нечего — ненужных чатов нет');
  }

  function runCycle(why) {
    return listAllChats().then(function (all) {
      var chats = V.buildChats(all.items, all.resources, all.displayInfo);

      var ids = [], blocked = 0;
      chats.forEach(function (c) {
        if (!c.reasons.length) return;
        if (c.canLeave) ids.push(c.id);
        else blocked++;
      });

      dbg('обход (' + why + '): страниц ' + all.pages +
        ', чатов ' + all.items.length + (all.found ? ' из ' + all.found : '') +
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

  function isChatPage() {
    return /^\/chat(\/|$)/.test(location.pathname);
  }

  var pendingTimer = null;
  var lastRunAt = 0;
  var running = false;
  var announced = false;
  var pendingWhy = null;
  var fireAt = 0;
  var rescheduleAfter = false;
  var lastLoggedWhy = null;
  var lastReasonLogAt = 0;

  // Свести все поводы к одному отложенному проходу. Время обхода назначается
  // по ПЕРВОМУ поводу пачки и не отодвигается следующими («дебаунс с
  // потолком»): непрерывная прокрутка не сбрасывает таймер бесконечно.
  // Обход стартует через SETTLE_MS после первого повода (или раньше, если
  // с прошлого обхода уже прошло MIN_INTERVAL_MS) — даже если список всё ещё
  // листают.
  function schedule(why) {
    if (!isChatPage()) return;
    pendingWhy = why;
    var now = Date.now();
    // Повод пишем в лог, когда он сменился или повторился после паузы —
    // иначе непрерывная прокрутка зальёт консоль одинаковыми строками.
    if (why !== lastLoggedWhy || now - lastReasonLogAt > 10000) {
      lastLoggedWhy = why;
      lastReasonLogAt = now;
      dbg('повод: ' + why);
    }
    if (running) { rescheduleAfter = true; return; }
    var fire = Math.max(now + SETTLE_MS, lastRunAt + MIN_INTERVAL_MS);
    if (pendingTimer && fire >= fireAt) return; // пачка уже учтена
    if (pendingTimer) clearTimeout(pendingTimer);
    fireAt = fire;
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      if (running) return;
      running = true;
      lastRunAt = Date.now();
      var w = pendingWhy;
      dbg('старт обхода (' + w + ')');
      var done = function () {
        running = false;
        // поводы, пришедшие во время обхода, не теряются
        if (rescheduleAfter) { rescheduleAfter = false; schedule(pendingWhy); }
      };
      runCycle(w).then(done, done);
    }, fire - now);
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
  // отметки, чтобы при следующем входе всё повторилось, и снимает ещё не
  // сработавший обход.
  function onRouteChange() {
    if (isChatPage()) {
      nothingTold = false;
      trigger('страница чатов открыта');
    } else {
      announced = false;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    }
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
      return open.apply(this, arguments);
    };
    proto.send = function () {
      if (this.__hhListRequest) {
        var xhr = this;
        xhr.addEventListener('load', function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            trigger('сайт запросил список чатов');
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
        p.then(function (r) {
          if (r && r.ok) trigger('сайт запросил список чатов');
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

  /* ------------------------------------------------------------------ */
  /* наблюдение за активностью списка (не зависит от main-world)         */
  /* ------------------------------------------------------------------ */

  // Контейнер списка у сайта виртуализирован: строки пересоздаются при
  // прокрутке, поэтому «число строк» — не признак догрузки. Зато и сама
  // прокрутка, и любые изменения внутри контейнера — это активность списка.
  function isListEl(el) {
    if (!el || el.nodeType !== 1) return false;
    var cn = (el.getAttribute && el.getAttribute('class')) || '';
    return cn.indexOf('scroll-container') !== -1 || cn.indexOf('chats--') !== -1;
  }

  // Событие scroll не всплывает, поэтому слушаем в capture-фазе на документе.
  function watchScroll() {
    document.addEventListener('scroll', function (e) {
      if (isListEl(e.target)) schedule('список пролистан');
    }, { capture: true, passive: true });
  }

  var listObserver = null;
  var observedEl = null;

  // Наблюдение за контейнером списка: ловим догрузку и перерисовку строк.
  // Контейнер появляется не сразу и может пересоздаваться при переходах,
  // поэтому раз в секунду сверяемся (это дёшево).
  function ensureListObserver() {
    var el = document.querySelector('[class*="scroll-container"]');
    if (!el || el === observedEl) return;
    if (listObserver) listObserver.disconnect();
    observedEl = el;
    listObserver = new MutationObserver(function () {
      schedule('список чатов изменился');
    });
    listObserver.observe(el, { childList: true, subtree: true });
    dbg('наблюдаю за контейнером списка');
  }

  var lastListSig = null; // {el, h, t} — отметка последней проверки контейнера

  // Самый надёжный, не зависящий от событий и от «мира» сигнал активности
  // списка: прокрутка меняет scrollTop, догрузка — scrollHeight. Чтение двух
  // свойств раз в полторы секунды браузер «проглотить» не может, в отличие
  // от событий scroll и мутаций.
  function checkListActivity() {
    ensureListObserver();
    var el = document.querySelector('[class*="scroll-container"]');
    if (!el) return;
    var h = el.scrollHeight, t = el.scrollTop;
    var sig = lastListSig;
    if (sig && sig.el === el) {
      if (h > sig.h) schedule('список догрузился');
      else if (t !== sig.t) schedule('список пролистан');
    }
    lastListSig = { el: el, h: h, t: t };
  }

  function watchList() {
    watchScroll();
    ensureListObserver();
    checkListActivity(); // запомнить отметку
    setInterval(checkListActivity, 1500);
  }

  // Смена адреса внутри SPA — опросом, чтобы не зависеть от main-world.
  function watchRoute() {
    var last = location.href;
    setInterval(function () {
      if (location.href === last) return;
      last = location.href;
      dbg('адрес сменился: ' + location.href);
      onRouteChange();
    }, 1000);
  }

  // Всё ставится на document_start — до кода сайта, поэтому не пропускается
  // ни первый запрос списка, ни сам факт открытия страницы чатов.
  dbg('запуск: ' +
    (typeof window.chrome !== 'undefined' && window.chrome.runtime && window.chrome.runtime.id
      ? 'изолированный мир' : 'главный мир') +
    ', путь ' + location.pathname);
  hookXHR();
  hookFetch();
  hookHistory();
  watchList();
  watchRoute();
  onRouteChange();
})();
