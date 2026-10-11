// Объявления для вещей, которых нет в типах DOM, но которые есть в коде.
//
//   HhVerdicts        — вешается самим verdicts.js (строка 54: root.HhVerdicts = api).
//                       Тип берётся из UMD-экспорта verdicts.js, поэтому список
//                       методов не дублируется: переименуете метод — ошибка
//                       появится здесь же, а не в трёх местах.
//
//   globalServiceVars — приходит со стороны сайта hh.ru, расширением не создаётся.
//                       В cleaner.js читается defensively (строки 127-129),
//                       поэтому каждое поле — необязательное.
//
//   __hhHooked / __hhListRequest — метки расширения на прототипах. Их ставит
//                       hookXHR/hookFetch, чтобы не перехватить XHR дважды.
//                       Нативные объекты браузера таких полей не имеют —
//                       объявляем, иначе каждое обращение даёт ошибку TS2339.
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
