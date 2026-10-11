/* hh — чистка чатов.
 *
 * Расширение работает само, в фоне, без единой кнопки: перехваченный
 * xhr-ответ сайта /chatik/api/chats читается, все чаты этого ответа
 * проверяются по встроенному алгоритму (verdicts.js), ненужные покидаются
 * POST /chatik/api/bulk/leave, и в правом верхнем углу появляется одна
 * и единственная плашка: красная «Покинуто N чатов», когда покинуто хотя
 * бы один чат, или зелёная «не найдено чатов для покидания», когда ни
 * один. После этой плашки расширение не делает ничего: не перечитывает
 * список, не верифицирует, не показывает других сообщений.
 *
 * Ненужные — ровно по двум признакам и только по ним:
 *
 *   1. ОТКАЗ             — currentApplicantState === "DISCARD";
 *   2. ВАКАНСИЯ В АРХИВЕ — у объекта вакансии есть ключ "archived".
 *
 * Оба признака лежат прямо в ответе списка чатов, поэтому расширение
 * использует только данные перехваченного ответа: никакого повторного
 * GET списка и никаких других сетевых вызовов, кроме самого покидания.
 *
 * Ничего больше не проверяется: ни даты последнего сообщения, ни того,
 * кто кому отвечал, ни «как давно молчат». Никакой оценочности.
 *
 * ── Правило, которому подчинено всё ────────────────────────────────────
 *
 * Нет полной уверенности, что чат можно покинуть, — чат НЕ покидается.
 * Чат с неопознанным признаком, непривычной формой ответа или
 * нечитаемым телом ответа остаётся как есть: пачка не обрабатывается,
 * и единственная плашка — зелёная «не найдено чатов для покидания».
 *
 * ── Когда срабатывает ──────────────────────────────────────────────────
 *
 * Когда сам сайт загружает страницу чатов — первую или очередную
 * подгрузку пачки (по 20 чатов, в том числе периодически, без нашего
 * участия): перехвачен xhr-ответ, расширение обрабатывает ровно его.
 * Вглубь курсорной пагинации оно не уходит и от простой прокрутки
 * ничего не делает.
 *
 * Загрузка страницы ловится перехватом запроса списка самим сайтом
 * (`GET /chatik/api/chats`): расширение перехватывает XHR/fetch и
 * читает тело самого ответа — без повторного запроса. Перехват работает
 * там, где браузер исполняет "world": "MAIN" (Chrome, Edge).
 *
 * Перехват ставится на document_start — до кода сайта, поэтому не
 * пропускается ни первый запрос списка, ни сам факт открытия страницы.
 * Если страница загружена, а первая пачка всё равно не перехватилась
 * (пришла через SSR, не XHR/fetch), расширение делает ровно один свой
 * fetch к списку — он же сам себя и перехватывает (через hookFetch),
 * это безопасно и не порождает петель.
 *
 * Повторные заходы безопасны: покинутый чат просто исчезает из списка,
 * а каждый следующий xhr-ответ страницы — самостоятельная пачка.
 * Никакого локального списка «уже покинутых» расширение не ведёт.
 *
 * Работает целиком на куках текущей сессии hh.ru: ни токенов, ни паролей
 * расширению не нужно — запросы уходят с теми же куками, что и у сайта.
 */
(function () {
  'use strict';

  var V = window.HhVerdicts;
  if (!V) {
    console.error('[hh] verdicts.js не загрузился — расширение не работает');
    return;
  }

  var API = 'https://chatik.hh.ru/chatik/api';
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

  /* ------------------------------------------------------------------ */
  /* сеть                                                                */
  /* ------------------------------------------------------------------ */

  function msg(e) {
    return e && e.message ? e.message : String(e);
  }

  function tag(url) {
    return url.replace(API, '/chatik/api');
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
    // Время видимости по типу: зелёный 'ok' исчезает раньше (1 с),
    // красный 'left' и все прочие — как раньше, TOAST_MS (5 с).
    var visibleMs = kind === 'ok' ? 1000 : TOAST_MS;
    setTimeout(function () {
      s.opacity = '0';
      s.transform = 'translateY(-6px)';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, TOAST_FADE_MS + 30);
    }, visibleMs);
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

  /* ------------------------------------------------------------------ */
  /* обработка пачки чатов из перехваченного ответа                      */
  /* ------------------------------------------------------------------ */

  // Единственная точка реакции: «сайт загрузил страницу чатов».
  // data — ответ /chatik/api/chats, прочитанный прямо из перехваченного
  // xhr (xhr.responseText) или fetch-ответа сайта (r.clone().json()) —
  // без повторного запроса; несёт флаг __hhOnChatPage: запрос ушёл со
  // страницы чатов (снят в момент СЕНД, в hookXHR/hookFetch — к ответу
  // SPA может уже подвинуть location.pathname, и живая проверка по пути
  // теряла первую пачку).
  // Счёт «покинуто» идёт по ответу /bulk/leave: applied — id чатов,
  // принятых API; расширением не верифицируется перечитыванием списка.
  // Если предыдущая пачка ещё обрабатывается, новая встаёт в очередь
  // pending и будет обработана, как только закончится текущая.
  function processBatch(data) {
    if (!data || !data.__hhOnChatPage) {
      // запрос не со страницы чатов (или тело не объект) — «не уверен»:
      // пачка не обрабатывается, ничего не сломано
      dbg('пропуск: запрос списка не со страницы чатов' +
        (data ? '': ', тело не объект; путь «' + location.pathname + '»'));
      return;
    }
    if (running) {
      // предыдущая пачка ещё обрабатывается (leaveChats идёт с паузами
      // между чанками) — эта не теряется: встаёт в очередь и будет
      // обработана одна за другой после окончания текущей
      pending.push(data);
      dbg('пачка уже в работе — в очередь (в очереди: ' + pending.length + ')');
      return;
    }
    runBatch(data);
  }

  // Обработка одной пачки: вердикты — по встроенному алгоритму
  // (verdicts.js), покидание — POST /chatik/api/bulk/leave, и ровно
  // одна плашка на пачку.
  function runBatch(data) {
    processedCount++;

    var scan = V.newScan();
    V.accumulatePage(scan, data);
    var items = (data && data.chats && data.chats.items) || [];
    var chats = V.buildChats(items, scan.resources, scan.displayInfo);

    var ids = [];
    chats.forEach(function (c) {
      if (c.reasons.length && c.canLeave) ids.push(c.id);
    });
    var found = (data && data.chats && data.chats.found) || 0;
    dbg('пачка: чатов в ответе ' + items.length +
      (found ? ' из ' + found : '') + ', к покиданию ' + ids.length);

    if (!ids.length) {
      // чатов для покидания нет — единственная допустимая здесь плашка
      toast(V.NO_CHATS_MESSAGE, 'ok');
      // если в очереди уже ждёт следующая пачка — забираем её: она
      // тоже обязана дойти до обработки
      if (pending.length) runBatch(pending.shift());
      return;
    }

    running = true;
    var done = function () {
      running = false;
      // текущая пачка окончена (плашка показана) — берём следующую из
      // очереди: пачки обрабатываются одна за другой, не параллельно
      if (pending.length) runBatch(pending.shift());
    };
    leaveChats(ids).then(function (res) {
      if (res.error) {
        // прерывание не значит «не покинуто ничего»: applied в ответе —
        // то, что ушло до обрыва
        console.warn(LOG + 'покидание прервано: ' + res.error +
          ' (принято ' + res.applied + ', отклонено ' + res.rejected + ')');
      }
      // единственная плашка после обработки пачки: красная — если хотя бы
      // один чат реально покинут, зелёная — если ни одного
      if (res.applied > 0) {
        console.log(LOG + 'Покинуто ' + res.applied + ' ' +
          V.plural(res.applied, 'чат', 'чата', 'чатов') +
          (res.rejected ? ' (отклонено сервером: ' + res.rejected + ')' : ''));
        toast(V.leftMessage(res.applied), 'left');
      } else {
        toast(V.NO_CHATS_MESSAGE, 'ok');
      }
      done();
    });
  }

  /* ------------------------------------------------------------------ */
  /* поводы: активность списка                                           */
  /* ------------------------------------------------------------------ */

  // Единственный свой запрос к списку — первичный fetch при загрузке
  // страницы (maybeMakeInitRequest), и он намеренно пропускается через
  // тот же hookFetch — его ответ обрабатывается как обычная пачка.
  // Поэтому любой GET к /chatik/api/chats обрабатывается одинаково.
  // Перехват работает только в "world": "MAIN".
  function isListRequest(url, method) {
    if (!url) return false;
    if ((method || 'GET').toUpperCase() !== 'GET') return false;
    return String(url).indexOf(LIST_PATH) !== -1;
  }

  function isChatPage() {
    return /^\/chat(\/|$)/.test(location.pathname);
  }

  // Состояние обработки пачек. pending — очередь перехваченных
  // ответов, пришедших, пока обработка текущей ещё шла (обрабатываются
  // одна за другой, по мере её окончания); running — прямо сейчас
  // идёт обработка очередной пачки.
  var pending = [];
  var running = false;

  /* ------------------------------------------------------------------ */
  /* первичная загрузка: если первая пачка не перехватилась               */
  /* ------------------------------------------------------------------ */

  // Счётчик обработанных пачек. Если после загрузки страницы он
  // нулевой — ни один хук не перехватил список, значит первая пачка
  // пришла не через XHR/fetch. Делаем один свой fetch.
  var processedCount = 0;
  var initRequestMade = false;

  function maybeMakeInitRequest() {
    if (initRequestMade) return;
    initRequestMade = true;
    if (!isChatPage() || processedCount > 0) return;
    // Делаем свой fetch — он пойдёт через обёрнутый hookFetch и будет
    // обработан как обычная пачка (processBatch → runBatch).
    dbg('первичная пачка: делаем свой fetch');
    window.fetch(API + '/chats', { credentials: 'include' })
      .catch(function () {});  // ошибка — не страшно, следующая XHR-пачка догонит
  }

  /* ------------------------------------------------------------------ */
  /* перехват запросов списка сайтом (main-world)                        */
  /* ------------------------------------------------------------------ */

  // Сайт ходит за списком через XMLHttpRequest. Ответ читаем прямо из
  // перехваченного XHR (xhr.responseText) — без повторного запроса;
  // нечитаемое тело — пропуск, как «не уверен».
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
        // Страницность берём сейчас, в момент send: к ответу путь
        // уже может смениться
        var onChatPage = isChatPage();
        xhr.addEventListener('load', function () {
          // диагностика: фиксируем КАЖДЫЙ перехваченный GET списка и его
          // статус — видно, пришёл ли первый запрос и с каким кодом
          dbg('xhr список: ' + tag(xhr.responseURL || '') +
            ', статус ' + xhr.status);
          if (xhr.status < 200 || xhr.status >= 300) {
            // не 2xx — «не уверен»: тело не читаем, пачка не
            // обрабатывается
            dbg('пропуск: статус ' + xhr.status + ' вне 200-299');
            return;
          }
          var data = null;
          try {
            data = JSON.parse(xhr.responseText);
          } catch (e) {
            // тело не читается как JSON — «не уверен»: пачка не
            // обрабатывается, ничего не сломано
            dbg('ответ списка не читается как JSON — пропуск');
            return;
          }
          // Страницность берётся из момента send: к ответу путь уже
          // мог смениться
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            data.__hhOnChatPage = onChatPage;
          }
          processBatch(data);
        });
      }
      return send.apply(this, arguments);
    };
    proto.__hhHooked = true;
  }

  // Перехват fetch — на случай, если сайт когда-нибудь сменит транспорт,
  // и для собственного первичного fetch (см. maybeMakeInitRequest).
  // Тело чужого ответа берём из памяти (r.clone().json()) — это не
  // сетевой вызов; оригинальный ответ возвращаем сайту как есть.
  // Свой fetch (первичная загрузка) намеренно пропускается через этот
  // же перехват — так он попадает в стандартную процедуру обработки.
  function hookFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__hhHooked) return;
    var orig = window.fetch;
    var wrapped = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      var method = (init && init.method) || (input && input.method) || 'GET';
      // Страницность берём в момент вызова: к ответу путь уже мог
      // смениться
      var onChatPage = isChatPage();
      var p = orig.apply(this, arguments);
      if (isListRequest(url, method)) {
        p.then(function (r) {
          // диагностика: фиксируем fetch-ответ списка и его статус
          dbg('fetch списка: ' + tag(url || '') +
            ', статус ' + (r && r.status));
          // не 2xx — «не уверен»
          if (!r || !r.ok) {
            dbg('пропуск (fetch): ' + (r ? 'статус ' + r.status : 'нет ответа'));
            return;
          }
          r.clone().json().then(function (data) {
            if (data && typeof data === 'object' && !Array.isArray(data)) {
              data.__hhOnChatPage = onChatPage;
            }
            processBatch(data);
          }, function () {
            // не читается как JSON — «не уверен»: пачка не
            // обрабатывается, ничего не сломано
            dbg('ответ списка не читается как JSON — пропуск');
          });
        }, function () {});
      }
      return p;
    };
    wrapped.__hhHooked = true;
    window.fetch = wrapped;
  }

  /* ------------------------------------------------------------------ */
  /* запуск перехвата                                                     */
  /* ------------------------------------------------------------------ */

  dbg('запуск: ' +
    (typeof window.chrome !== 'undefined' && window.chrome.runtime && window.chrome.runtime.id
      ? 'изолированный мир' : 'главный мир') +
    ', путь ' + location.pathname);
  hookXHR();
  hookFetch();

  // Если первая пачка загружается не через XHR/fetch, а через SSR или
  // иной механизм, хуки её не перехватят. Ставим отложенный fetch.
  if (isChatPage()) {
    dbg('на странице чатов — запланирован первичный fetch списка');
    var scheduleInit = function () {
      setTimeout(maybeMakeInitRequest, 500);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scheduleInit, { once: true });
    } else {
      scheduleInit();
    }
  } else {
    initRequestMade = true;  // не на странице чатов — запрос не нужен
  }
})();
