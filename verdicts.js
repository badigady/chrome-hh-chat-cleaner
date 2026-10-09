/* hh — решения о чатах.
 *
 * Только признаки и правила. Ни сети, ни DOM, ни таймеров: всё, что
 * здесь есть, можно прогнать в node по настоящим ответам сервера
 * (test/verdicts.test.js). Всё, что ходит в сеть, — в cleaner.js.
 *
 * Правило, которому подчинено всё остальное: если нет полной уверенности,
 * что чат можно покинуть, — чат не покидается. Чат с неопознанным
 * признаком или непривычной формой ответа остаётся нетронутым.
 *
 * ── Про признаки ────────────────────────────────────────────────────────
 *
 * 1. ОТКАЗ
 *    negotiation_topics[topicId].currentApplicantState === "DISCARD".
 *    Проверено на живом аккаунте: в полном обходе встречаются только
 *    RESPONSE, INTERVIEW и DISCARD, других значений нет — значит признак
 *    не пропускает отказы.
 *
 * 2. ВАКАНСИЯ В АРХИВЕ
 *    Присутствие ключа "archived" у объекта вакансии. Не значение, а сам
 *    факт ключа: значение приходит как {"@hidden": false} и как булево не
 *    читается.
 *    Проверено пересечением с серверной правдой на 914 вакансиях: ключ
 *    есть ровно у одной вакансии, и это ровно та вакансия, которую
 *    мобильный API помечает archived: true. Расхождений — ноль.
 *    Прежний прокси closedForApplicants давал 26 ложных срабатываний и
 *    ноль точных, поэтому не используется.
 *    Формы значения, отличные от проверенной, дают «не уверен».
 *
 * ── Какие элементы списка вообще рассматриваются ───────────────────────
 *
 * Только элементы с type === "NEGOTIATION" — переписка по отклику на
 * вакансию. В списке встречаются и другие типы, и их не трогаем никогда:
 *
 *   COMMON  — переписка без вакансии (подтип WITHOUT_VACANCY);
 *   SUPPORT — обращение в поддержку.
 *
 * Живая проверка 2026-10-09: из 915 элементов — NEGOTIATION 912,
 * COMMON 2, SUPPORT 1. У COMMON, как и у отклика, есть операция
 * LEAVE_CHAT, поэтому фильтр по типу — не формальность: без него
 * «обычная» переписка могла бы попасть под правило.
 *
 * Элемент с неизвестным или отсутствующим type не рассматривается:
 * незнакомое — значит «не уверен».
 *
 * Оба признака лежат прямо в ответе списка чатов. Поэтому расширению
 * нужен ровно один запрос на страницу списка и ни одного запроса сверх
 * этого: никакой детализации по каждому чату оно не делает.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HhVerdicts = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REFUSAL_STATE = 'DISCARD';
  var ARCHIVED_KEY = 'archived';
  var ARCHIVED_WRAPPER = '@hidden';
  var LEAVE_OP = 'LEAVE_CHAT';
  var CHAT_TYPE = 'NEGOTIATION';

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /* рассматриваем только отклики по вакансиям -------------------------- */
  function isNegotiation(item) {
    return ((item || {}).type) === CHAT_TYPE;
  }

  /* тексты всплывающей плашки -----------------------------------------
   *
   * Плашки — единственный видимый отклик расширения: кнопки и панели у
   * него нет. Тексты держим здесь, среди чистых функций, чтобы их можно
   * было проверить в node (test/verdicts.test.js), без DOM и таймеров.
   */
  var START_MESSAGE = 'hh: работает автоматическая очистка чатов';

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return few;
    return many;
  }

  function leftMessage(n) {
    return 'hh: покинуто ' + n + ' ' + plural(n, 'чат', 'чата', 'чатов');
  }

  function assign(target, source) {
    if (!target || !source || typeof source !== 'object') return target;
    for (var k in source) {
      if (Object.prototype.hasOwnProperty.call(source, k)) target[k] = source[k];
    }
    return target;
  }

  function ids(item, kind) {
    return ((item || {}).resources || {})[kind] || [];
  }

  /* признак 1 — отказ ------------------------------------------------- */
  function refusalReason(item, resources) {
    var topics = (resources || {}).negotiation_topics || {};
    var list = ids(item, 'NEGOTIATION_TOPIC');
    for (var i = 0; i < list.length; i++) {
      var t = topics[list[i]];
      if (t && t.currentApplicantState === REFUSAL_STATE) return 'отказ';
    }
    return null;
  }

  /* признак 2 — вакансия в архиве ------------------------------------- */
  function archivedReason(item, resources) {
    var vacs = (resources || {}).vacancies || {};
    var list = ids(item, 'VACANCY');
    for (var i = 0; i < list.length; i++) {
      var v = vacs[list[i]];
      if (!has(v, ARCHIVED_KEY)) continue;
      // форма значения не та — не решаем, чат останется нетронутым
      if (v[ARCHIVED_KEY] && typeof v[ARCHIVED_KEY] === 'object' &&
          has(v[ARCHIVED_KEY], ARCHIVED_WRAPPER)) {
        return 'вакансия в архиве';
      }
      return null;
    }
    return null;
  }

  /* признаки, которые видны прямо в ответе списка --------------------- */
  function listReasons(item, resources) {
    var out = [];
    var r1 = refusalReason(item, resources);
    var r2 = archivedReason(item, resources);
    if (r1) out.push(r1);
    if (r2) out.push(r2);
    return out;
  }

  /* сервер разрешает покидать не каждый чат ---------------------------- */
  function canLeave(item) {
    var allowed = ((item || {}).operations || {}).allowed || [];
    return allowed.indexOf(LEAVE_OP) !== -1;
  }

  /* Сборка записей о чатах — здесь и рождается reasons.
   *
   * Инвариант: у каждой записи reasons есть всегда, даже когда это пустой
   * массив. Именно его не было: признаки считались в двух разных местах,
   * и чат с признаком получал reasons === undefined, на чём падало
   * расширение (undefined.length). Считаем один раз, здесь, при рождении
   * записи.
   */
  function buildChats(items, resources, displayInfo) {
    var info = displayInfo || {};
    // только отклики: COMMON и SUPPORT (и любой незнакомый тип) отсеиваются
    return (items || []).filter(isNegotiation).map(function (item) {
      var d = info[item.id] || {};
      return {
        id: String(item.id),
        title: d.title || null,
        employer: d.subtitle || null,
        canLeave: canLeave(item),
        reasons: listReasons(item, resources)
      };
    });
  }

  /* Накопление ответов страниц.
   *
   * Сервер отдаёт ресурсы вместе с той страницей чатов, на которые они
   * ссылаются, поэтому ключ чата может оказаться на любой из ~46 страниц.
   * Накапливать нужно по всему обходу: если оставить содержимое только
   * последней страницы, признаки не найдут ничего — на последней странице
   * около 15 записей из 915, и ключа archived среди них может не быть.
   */
  function newScan() {
    return { resources: { negotiation_topics: {}, vacancies: {} }, displayInfo: {} };
  }

  function accumulatePage(scan, page) {
    var res = (page || {}).resources || {};
    assign(scan.resources.negotiation_topics, res.negotiation_topics);
    assign(scan.resources.vacancies, res.vacancies);
    assign(scan.displayInfo, (page || {}).chatsDisplayInfo);
    return scan;
  }

  return {
    REFUSAL_STATE: REFUSAL_STATE,
    CHAT_TYPE: CHAT_TYPE,
    START_MESSAGE: START_MESSAGE,
    plural: plural,
    leftMessage: leftMessage,
    isNegotiation: isNegotiation,
    refusalReason: refusalReason,
    archivedReason: archivedReason,
    listReasons: listReasons,
    canLeave: canLeave,
    buildChats: buildChats,
    newScan: newScan,
    accumulatePage: accumulatePage
  };
});
