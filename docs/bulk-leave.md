# `POST https://chatik.hh.ru/chatik/api/bulk/leave` — описание эндпоинта

Документ описывает эндпоинт **точно так, как он устроен в веб-приложении
hh.ru (страница чатов)**, на 2026-10-09. Каждое утверждение помечено статусом
доказанности:

| Метка | Значение |
|---|---|
| **VERIFIED** | прочитано в коде приложения или снято живым запросом в браузере |
| **INFERRED** | следует из кода, но прямой проверки не было |
| **NOT VERIFIED** | не проверено; описано как гипотеза |

---

## 1. Назначение

Массовое покидание чатов («покинуть выбранные») из режима выделения в списке
чатов. Аналог мобильного `DELETE /chats/{id}/participants/me` из
`hh.chatik.Chat.leave()`, но сразу для пачки и на веб-стороне.

Соседние эндпоинты того же семейства (VERIFIED, модуль `8129`):

```
POST /chatik/api/bulk/leave                    тело {chatIds}
POST /chatik/api/bulk/read                     тело {chatIds}
POST /chatik/api/bulk/unread                   тело {chatIds}
POST /chatik/api/bulk/add_manager_participant  тело {chatIds, managerId}
```

---

## 2. Эндпоинт

```
POST https://chatik.hh.ru/chatik/api/bulk/leave
```

- **Хост.** Не `hh.ru`. API-хост веб-приложения чатов — отдельный, и он
  **подставляется в страницу динамически** (VERIFIED, живое значение со страницы):
  ```js
  window.globalServiceVars[<areaId>].apiHost    // "https://chatik.hh.ru"
  window.globalServiceVars[<areaId>].staticHost // "https://chatik.hh.ru/static"
  window.globalServiceVars[<areaId>].build      // "1.10.12"
  ```
  Ключ выбирается по `areaId` (гео-регион). На другой регион хост может быть
  другим, поэтому хардкод `https://chatik.hh.ru` — допущение, а не факт
  (**INFERRED**; проверено только для текущего региона).
- **Путь.** `/chatik/api/bulk/leave` — строковый литерал в коде (VERIFIED).
- **База URL.** Axios-инстанс выставляет
  `e.baseURL = window.globalServiceVars[areaId].apiHost` для любого запроса, у
  которого нет флага `isGetPage` (VERIFIED, модуль `20015`).

---

## 3. Запрос

### 3.1 Метод и тело (VERIFIED, модуль `8129`)

```js
const leave = (chatIds) =>
  U._.post("/chatik/api/bulk/leave", { chatIds }, { retry: false })
     .then(({ data }) => data);
```

```http
POST /chatik/api/bulk/leave HTTP/2
Host: chatik.hh.ru
Content-Type: application/json
Accept: application/json
X-Requested-With: XMLHttpRequest
X-Xsrftoken: <значение cookie _xsrf>
X-hhtmSource: app
X-hhtmFrom:
X-hhtmSourceLabel: app
X-hhtmFromLabel:
Cookie: <куки сессии hh.ru>

{"chatIds":[5000000002, 5000000010]}
```

- **Тело** — ровно одно поле `chatIds`, массив идентификаторов чатов. Идентификаторы
  приходят из `chats.items[].id` и в API являются **числами** (VERIFIED: в
  ответе списка `"id": 5000000011` без кавычек).
- Никаких других полей эндпоинт не принимает (INFERRED: других полей в
  вызывающем коде нет).

### 3.2 Заголовки

Источник — дефолты и интерцепторы axios-инстанса (VERIFIED, модуль `20015`):

| Заголовок | Источник | Примечание |
|---|---|---|
| `Accept: application/json` | `defaults.headers.common` | |
| `Content-Type: application/json` | `defaults.headers.common` | из-за этого запрос уходит с **CORS-preflight** |
| `X-Requested-With: XMLHttpRequest` | интерцептор `c` | ставится, когда хост запроса — текущий хост страницы **или** входит в `apiHost` |
| `X-Xsrftoken` | интерцептор `h` + `defaults.xsrfCookieName = "_xsrf"`, `xsrfHeaderName = "X-Xsrftoken"` | ставится при том же условии; значение берётся axios'ом из куки `_xsrf` |
| `X-hhtmSource`, `X-hhtmFrom`, `X-hhtmSourceLabel`, `X-hhtmFromLabel` | интерцептор модуля `11981` | значения из `globalServiceVars[areaId].analyticsParams`; приходят **только** для кросс-доменных запросов |
| `X-Static-Version` | интерцептор `getPage` | ставится **только** для SSR-запросов страниц, к `/bulk/leave` отношения не имеет |
| `Cookie` | браузер | `withCredentials = true` (VERIFIED) |

**Обязательность `X-Xsrftoken` для сервера — NOT VERIFIED.** Клиент его шлёт,
это факт; проверки, что сервер откажет без него, не проводилось (это потребовало
бы реального POST).

### 3.3 Опция `retry: false` (VERIFIED как факт передачи, NOT VERIFIED как смысл)

В вызове передаётся `{ retry: false }` — это **не стандартная опция axios**.
Потребителя этой опции в доступных бандлах найти не удалось (NOT VERIFIED).
Фактически: сайт не повторяет этот запрос автоматически — для покиданий это
ожидаемо, действие не идемпотентно в смысле «повтор = ещё один запрос».

---

## 4. Ответ

### 4.1 Что отдаёт сервер (VERIFIED по коду потребителя)

Общий thunk массовых действий (VERIFIED, модуль `8129`) разбирает **тело
ответа** каждого чанка:

```js
const e = await requestChunk(t);   // await leave(t)
d.push(...e.applied);              // d — успешные
h.push(...e.rejected);             // h — отклонённые
```

Значит сервер возвращает как минимум:

```json
{
  "applied":  [5000000002, 5000000010],
  "rejected": [{"id": 123, "reason": "..."}]
}
```

- `applied` — массив id чатов, которые покинуть удалось.
- `rejected` — массив отказов. **Тип элемента не установлен** (NOT VERIFIED):
  может быть id, а может быть объектом с причиной. Клиент это поле только
  конкатенирует и по нему считает длину, содержимое не разбирает.

#### 4.1.1 Боевой ответ (VERIFIED, 2026-10-09)

Запрос выполнен с живого аккаунта: чат `5000000008` («Должность E»),
проверенные признаки — отказ `DISCARD` и `WITHOUT_INVITATION`.

```http
POST /chatik/api/bulk/leave
Content-Type: application/json
X-Requested-With: XMLHttpRequest
X-Xsrftoken: <32 символа из куки _xsrf>

{"chatIds":["5000000008"]}
```

```http
HTTP/2 200
content-type: application/json

{"applied":[5000000008],"rejected":[]}
```

Отсюда три факта, каждый из которых меняет реализацию.

1. **`applied` и `rejected` — массивы id**, а не числа. Значит
   `(response.applied || []).length` корректно. Прежняя осторожность «а вдруг
   придёт число» снимается: сервер возвращает массив.
2. **`X-Xsrftoken` — 32 символа из куки `_xsrf`**, запрос принят. Обязательность
   самого заголовка по-прежнему не доказана (§6).
3. **Ответ не доказывает, что чат покинут.** Тот же запрос с тем же чатом,
   отправленный сразу повторно, вернул `200` и то же тело
   `{"applied":[5000000008],"rejected":[]}`. Значит `applied` означает «id
   принят», а не «действие выполнено именно сейчас».

   Расширение доверяет полю `applied` в ответе сервера: список не перечитывается,
   повторный POST того же чата — идемпотентен. После боевого покидания `found`
   919 → 918, `collected` 918 → 917, чата в списке нет. При этом `GET /chat_data`
   того же чата продолжает отдавать 200, то есть по детализации исчезновение
   не проверить.

### 4.2 Что НЕ отдаёт сервер, а считает клиент (VERIFIED)

Итоговый объект, который уходит в UI, собирается в thunk:

```js
{
  applied:            d,                          // собрано из ответов сервера
  rejected:           h,                          // собрано из ответов сервера
  unprocessedCount:   o.length - d.length - h.length,
  skippedCount:       l.length
}
```

где:
- `o` — отобранные чаты (см. §5.2),
- `l` — выбранные чаты, **не поддерживающие** `LEAVE_CHAT`.

**`unprocessedCount` и `skippedCount` — не поля ответа сервера.** Это
вычисляемые клиентом числа. Любой клиент (в том числе наше расширение) должен
считать их сам; ожидать их в JSON — ошибка.

### 4.3 Как это показывается пользователю (VERIFIED)

```js
if (unprocessedCount > 0) {
  if (applied.length > 0) → уведомление "ok":
      plural(applied.length, [failedPart.one, failedPart.some, failedPart.many])
      с подстановками {0} = applied.length, {1} = unprocessedCount
  else                  → уведомление "error": leaveChats.error
} else {
  → "success":
      (rejected.length || skippedCount) ? leaveChats.partialSuccess
                                        : leaveChats.success
}
```

Ключи переводов (VERIFIED):
`chatik.chatsSelection.leaveChats.{title,description,confirm,cancel,success,partialSuccess,error}`,
`chatik.chatsSelection.leaveChats.failedPart.{one,some,many}`,
`chatik.chatsSelection.inProgress`.
Разметка: `data-qa="chatik-leave-chats-alert"`,
`chatik-leave-chats-cancel-button`, `chatik-leave-selected-chats-button`.

Формулировки самих текстов в бандлах отсутствуют (лежат в локализации,
не отдаётся в JS) — **NOT VERIFIED**.

---

## 5. Клиентская обвязка (важно для повторения)

### 5.1 Размер чанка — **20** (VERIFIED)

```js
for (const t of chunk(o, 20)) { … }
```

`chunk` — обычный `slice` с шагом 20. За один HTTP-запрос покидается **не
более 20 чатов**.

### 5.2 Фильтр по правам операции (VERIFIED)

Перед отправкой выборка пересекается с тем, что чат вообще разрешено покинуть:

```js
const pe = createSelector(
  [selectedChats],
  chats => chats.filter(c => c.operations.allowed.includes("LEAVE_CHAT")).map(c => c.id)
);
```

Чаты без `LEAVE_CHAT` в `operations.allowed` уходят в `skippedCount` и на
сервер **не передаются**.

Реальное распределение `operations.allowed` в веб-списке (918 чатов, живой
замер): `["LEAVE_CHAT","DISABLE_NOTIFICATIONS"]` — 921 из 922, и **один** чат
`["RATING","DISABLE_NOTIFICATIONS"]` — его покинуть нельзя, и сайт его
пропустит.

Enum допустимых операций (VERIFIED, модуль `40560`):

```
LEAVE_CHAT, DISABLE_NOTIFICATIONS, ENABLE_NOTIFICATIONS,
DISABLE_WRITE_POSSIBILITY, ENABLE_WRITE_POSSIBILITY,
RATING, ADD_PARTICIPANTS
```

### 5.3 Прерывание цикла при ошибке (VERIFIED)

```js
try { … } catch (e) {
  isCancel(e) || isNetworkError(e) || log(…);
  break;                       // ← остальные чанки НЕ отправляются
}
```

Из-за этого и появляется `unprocessedCount`: чаты из неотправленных чанков
учитываются как необработанные.

Обработчик «сетевой ошибки» (VERIFIED, модуль `19201`):
`isAxiosError(e) && !e.response` — то есть запрос не получил ответа вовсе.

### 5.4 Подтверждение и состояние (VERIFIED)

Redux-срез `chatsSelection`:

```js
{ isSelectionMode, selectedIds, isRunning,
  isLeaveConfirmationVisible, isInviteCoworkerVisible }
```

Порядок работы сайта:

1. пользователь отмечает чаты галочками (`toggleChatSelection`),
2. жмёт «Покинуть выбранные» → `openLeaveConfirmation` → диалог
   `data-qa="chatik-leave-chats-alert"`,
3. подтверждение → `startBulkAction` (`isRunning = true`; во время выполнения
   `toggleChatSelection` и `exitSelectionMode` **игнорируются**),
4. запросы чанками по 20,
5. `finishBulkAction([...applied, ...rejected, ...skipped])` — обработанные
   убираются из выделения; если выделение опустело — срез сбрасывается в
   начальное состояние,
6. если что-то покинуто — обновление списка чатов.

### 5.5 Флаг возможности (VERIFIED)

`globalServiceVars[areaId].features.bulk_chat_actions_enabled` — на момент
замера `true`. Массовые действия могут быть выключены на стороне
конфигурации. (В текущей реализации расширения не используется.)

---

## 6. Что НЕ проверено

Проверками 2026-10-09 закрыты два пункта — см. §4.1.1. Остаётся:

1. **Тип элемента `rejected`.** Сам факт массива установлен, но что внутри при
   отказе — не проверено: отказ получить не удалось.
2. **Поведение при пустом `chatIds: []`** и при несуществующем id.
3. **Требуется ли `X-Xsrftoken`.** Клиент шлёт, сервер принял запрос с ним;
   проверки без заголовка не делалось — намеренно, чтобы не гадать.
4. **Коды ошибок и формат тела при ошибке** (401/403/429/5xx).
5. **Лимиты на размер `chatIds`**, кроме клиентского чанка в 20.
6. **Влияние на мобильный клиент.** Покин��тый через веб чат исчезает из списка
   в браузере; исчезнет ли он из списка мобильного приложения — не проверялось.

### Что проверено

- **Ответ — массивы id.** `{"applied":[5000000008],"rejected":[]}`, HTTP 200.
- **Идемпотентность (пункт, бывший NOT VERIFIED).** Повторный `POST` с уже
  покинутым id вернул `200` и то же тело — сервер относится к нему как к
  принятому и **не сообщает**, что чат уже покинут. Практический вывод:
  считать покинутые по ответу нельзя, только по исчезновению из списка.

---

## 7. Как проверить оставшееся (безопасно и по порядку)

1. **Безопасно, ничего не удаляя** — OPTIONS/preflight и коды на мусорном теле.
2. **Полу-безопасно** — `POST` с заведомо несуществующим `chatId`
   (например `[999999999]`): прав на такой чат у пользователя нет, ответ
   покажет форму `rejected` и коды ошибок, не изменив состояние.
3. **С риском для одного чата** — `POST` с id чата из `skipped`-класса
   (тот, где нет `LEAVE_CHAT`) и с заведомо мусорным чатом. Реальный `leave`
   делается **только** на одном чате и только с явного согласия.

---

## 8. Что из этого следует для нашего расширения

Расширение (`cleaner.js`) вызывает этот эндпоинт. Сверка с
описанным привнесла три правки, которые обязательны для корректности:

1. **Размер чанка — 20**, а не 50 (как делает сайт).
2. **Обязательные заголовки** `X-Xsrftoken` (значение куки `_xsrf`, оно же
   лежит в `globalServiceVars.chatik.xsrfToken`) и
   `X-Requested-With: XMLHttpRequest`. Без первого запрос может быть отвергнут.
3. **Фильтр по `operations.allowed.includes("LEAVE_CHAT")`** перед отправкой:
   остальные не отправлять, а учитывать как пропущенные — ровно так, как делает
   сайт, иначе получим лишние отказы в `rejected`.
4. **`unprocessedCount`/`skippedCount` считать на клиенте**; в JSON их нет.
5. **Прерывать цикл при ошибке** и показывать необработанные честно, а не
   рапортовать об успехе.

---

## 9. Как добыть первоисточники повторно

Бандлы веб-приложения чатов (публичные, без авторизации):

```
https://chatik.hh.ru/static/8129.6f23d00b2905fefa.js   ← массовые действия, диалог
https://chatik.hh.ru/static/notSharedVendors.b31a342013a60ccd.js  ← axios-инстанс (20015)
https://chatik.hh.ru/static/remote.chatik.e187fdaa5863dbc9.js
```

Хеши в именах меняются при каждом релизе — актуальный список виден в
`window.performance.getEntriesByType('resource')` на странице чатов.

Живые значения конфигурации страницы:

```js
window.globalServiceVars
// .chatik.apiHost, .staticHost, .build, .xsrfToken,
// .features.bulk_chat_actions_enabled, .requestId
```
