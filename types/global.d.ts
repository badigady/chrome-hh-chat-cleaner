// Объявления для вещей, которых нет в типах DOM, но которые есть в коде.
//
//   HhVerdicts        — вешается самим verdicts.js (строка 54: root.HhVerdicts = api).
//                       Тип берётся из UMD-экспорта verdicts.js, поэтому список
//                       методов не дублируется: переименуете метод — ошибка
//                       появится здесь же, а не в трёх местах. Текущий API:
//                       NO_CHATS_MESSAGE, plural, leftMessage, isNegotiation,
//                       listReasons, canLeave, buildChats, newScan,
//                       accumulatePage.
//
//   globalServiceVars — приходит со стороны сайта hh.ru, расширением не создаётся.
//                       В cleaner.js читается defensively (getXsrf),
//                       поэтому каждое поле — необязательное.
//
//   __hhHooked / __hhListRequest — метки расширения на прототипах.
//                       Их ставит hookXHR/hookFetch: не перехватить XHR/fetch
//                       дважды, помнить, что запрос — загрузка списка. Нативные
//                       объекты браузера таких полей не имеют — объявляем,
//                       иначе каждое обращение даёт ошибку TS2339.
//
//   chrome.runtime      — есть только у content script в изолированном мире;
//                       в главном мире страницы chrome.runtime отсутствует.
//                       cleaner.js по этому признаку определяет мир запуска.

import type * as Verdicts from '../verdicts.js';

type FetchFn = typeof fetch;

declare global {
  interface Window {
    HhVerdicts: typeof Verdicts;
    globalServiceVars?: { chatik?: { xsrfToken?: string } };
    fetch: FetchFn & { __hhHooked?: boolean };
    // chrome.runtime есть только у content script в изолированном мире;
    // cleaner.js по нему определяет мир запуска (главный/изолированный)
    chrome?: { runtime?: { id?: string } };
  }

  interface XMLHttpRequest {
    __hhHooked?: boolean;
    __hhListRequest?: boolean;
  }
}

export {};
