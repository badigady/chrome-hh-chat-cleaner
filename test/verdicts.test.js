/* Тесты признаков — на обезличенных выдержках из настоящих ответов hh.ru
 * (test/fixtures/live.json).
 *
 * Запуск:  node test/verdicts.test.js
 *
 * Данные в фикстурах сняты с живого аккаунта 2026-10-09; форма ответа
 * перенесена дословно, а идентификаторы и названия вакансий/компаний
 * заменены на синтетические той же формы (реальные данные аккаунта в
 * публичный репозиторий не попадают). Синтетика появляется только там, где
 * помечена явно: это случаи, которых на том аккаунте не случилось, и
 * подобрать их можно лишь конструированием вида ответа, а не записью.
 *
 * Расширение работает по двум признакам — отказ и вакансия в архиве — и
 * только по элементам списка с type === "NEGOTIATION". Оба правила здесь и
 * проверяются. Первый тест — регрессия на ошибку, из-за которой расширение
 * падало: reasons вычислялся в двух местах, и чат с признаком получал
 * undefined, на чём всё умирало (undefined.length).
 */
'use strict';

const assert = require('assert');
const path = require('path');

const V = require(path.join(__dirname, '..', 'src', 'verdicts.js'));
const FX = require(path.join(__dirname, 'fixtures', 'live.json'));

let passed = 0;
const failed = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed.push({ name, e });
    console.log('FAIL  ' + name + '\n        ' + (e && e.message));
  }
}

const items = Object.keys(FX.listItems).map(k => FX.listItems[k]);
const info = {};
Object.keys(FX.listItems).forEach(k => {
  if (FX.listItems[k]._display) info[k] = FX.listItems[k]._display;
});

function reasonsOf(id) {
  return V.buildChats([FX.listItems[id]], FX.resources, info)[0].reasons;
}

console.log('\nрегрессия');

test('у каждой записи reasons есть всегда — падение на undefined.length', () => {
  const chats = V.buildChats(items, FX.resources, info);
  for (const c of chats) {
    assert.ok(Array.isArray(c.reasons),
      'у чата ' + c.id + ' reasons не массив: ' + c.reasons);
  }
});

test('чатов с признаком ровно 3 — на них можно читать reasons.length', () => {
  const chats = V.buildChats(items, FX.resources, info);
  const found = chats.filter(c => c.reasons.length > 0);
  assert.strictEqual(found.length, 3, 'найдено ' + found.length + ', ожидалось 3');
});

console.log('\nрассматриваем только NEGOTIATION');

test('isNegotiation: NEGOTIATION — да, COMMON и SUPPORT — нет', () => {
  assert.strictEqual(V.isNegotiation({ type: 'NEGOTIATION' }), true);
  assert.strictEqual(V.isNegotiation({ type: 'COMMON' }), false);
  assert.strictEqual(V.isNegotiation({ type: 'SUPPORT' }), false);
  assert.strictEqual(V.isNegotiation({}), false, 'без type — не рассматриваем');
  assert.strictEqual(V.isNegotiation(null), false);
});

test('в сборку попадают только отклики: COMMON и SUPPORT отсеяны', () => {
  const chats = V.buildChats(items, FX.resources, info);
  const ids = chats.map(c => c.id);
  assert.strictEqual(chats.length, 5, 'записей: ' + chats.length + ', ожидалось 5');
  assert.ok(ids.indexOf('5000000006') === -1, 'COMMON попал в обработку');
  assert.ok(ids.indexOf('5000000007') === -1, 'SUPPORT попал в обработку');
  assert.ok(ids.indexOf('5000000002') !== -1, 'отклик потерялся');
});

test('COMMON с операцией LEAVE_CHAT всё равно не рассматривается', () => {
  // у COMMON 5000000006 LEAVE_CHAT есть — и всё равно не обрабатываем
  assert.strictEqual(V.canLeave(FX.listItems['5000000006']), true);
  assert.deepStrictEqual(
    V.buildChats([FX.listItems['5000000006']], FX.resources, info).length, 0);
});

console.log('\nпризнак 1 — отказ');

test('DISCARD определяется', () => {
  assert.deepStrictEqual(reasonsOf('5000000001'), ['отказ']);
  assert.deepStrictEqual(reasonsOf('5000000002'), ['отказ']);
});

test('RESPONSE отказом не считается', () => {
  assert.deepStrictEqual(reasonsOf('5000000004'), []);
  assert.deepStrictEqual(reasonsOf('5000000005'), []);
});

console.log('\nпризнак 2 — вакансия в архиве');

test('наличие ключа archived ловит архивный чат', () => {
  assert.deepStrictEqual(reasonsOf('5000000003'), ['вакансия в архиве']);
});

test('отказ и архив на одном чате дают оба признака', () => {
  // синтетика вида ответа: тот же элемент списка, но ссылки на обе темы
  // и обе вакансии. Форма — из фикстуры, значения — из фикстуры.
  const item = {
    id: 'X', type: 'NEGOTIATION', currentParticipantId: '10000001',
    resources: { NEGOTIATION_TOPIC: ['6000000001'], VACANCY: ['700000003'] },
    operations: { allowed: ['LEAVE_CHAT'] },
  };
  const r = V.listReasons(item, FX.resources);
  assert.deepStrictEqual(r.sort(), ['вакансия в архиве', 'отказ']);
});

test('closedForApplicants игнорируется — это прокси, давал 26 ложных', () => {
  // Наблюдалось на живых данных 2026-10-09: у 26 вакансий
  // closedForApplicants === true при этом ключа archived нет и по
  // мобильному archived === false. Строим ровно такую вакансию.
  const vac = Object.assign({}, FX.resources.vacancies['700000004'],
    { vacancyId: 999, closedForApplicants: true });
  const resources = { vacancies: { '999': vac } };
  const item = {
    id: 'Y', type: 'NEGOTIATION', currentParticipantId: '10000001',
    resources: { VACANCY: ['999'] },
    operations: { allowed: ['LEAVE_CHAT'] },
  };
  assert.deepStrictEqual(V.listReasons(item, resources), []);
});

test('незнакомая форма archived → «не уверен», чат не трогаем', () => {
  // Формы значения, отличной от наблюдённой, быть не должно: правило
  // ровно «ключ есть». Значение true вместо обёртки не проверено на живых.
  const vac = Object.assign({}, FX.resources.vacancies['700000003'],
    { vacancyId: 998, archived: true });
  const item = {
    id: 'Z', type: 'NEGOTIATION', currentParticipantId: '10000001',
    resources: { VACANCY: ['998'] },
    operations: { allowed: ['LEAVE_CHAT'] },
  };
  assert.deepStrictEqual(V.listReasons(item, { vacancies: { '998': vac } }), []);
});

console.log('\nпрочее');

test('LEAVE_CHAT есть у всех проверенных откликов', () => {
  V.buildChats(items, FX.resources, info).forEach(it =>
    assert.strictEqual(it.canLeave, true, 'чат ' + it.id));
});

test('без LEAVE_CHAT чат помечается непокидаемым', () => {
  assert.strictEqual(V.canLeave({ operations: { allowed: ['DISABLE_NOTIFICATIONS'] } }), false);
  // SUPPORT 5000000007: LEAVE_CHAT у него нет
  assert.strictEqual(V.canLeave(FX.listItems['5000000007']), false);
});

test('ответ /bulk/leave: applied — массив id (боевой POST 2026-10-09)', () => {
  const b = FX.bulkLeaveResponse.body;
  assert.ok(Array.isArray(b.applied), 'applied не массив');
  assert.ok(Array.isArray(b.rejected), 'rejected не массив');
});

console.log('\nрегрессия на слияние ресурсов по страницам');

test('признак находится, даже если его ресурсы лежали на первой странице', () => {
  // Дефект, найденный приёмкой 2026-10-09: ресурсы каждой страницы
  // перезаписывались следующей страницей, поэтому в решение попадали
  // ресурсы ТОЛЬКО последней страницы — около 15 записей из 915.
  // Признаки молчали, чистка ничего не находила.
  const scan = V.newScan();
  V.accumulatePage(scan, {
    resources: {
      negotiation_topics: { '6000000002': { currentApplicantState: 'DISCARD' } },
      vacancies: { '700000003': { archived: { '@hidden': false } } },
    },
    chatsDisplayInfo: { '5000000002': { title: 'Первый', subtitle: 'Компания' } },
  });
  // последняя страница обхода — пустая по смыслу
  V.accumulatePage(scan, {
    resources: { negotiation_topics: {}, vacancies: {} },
    chatsDisplayInfo: {},
  });

  const item = {
    id: '5000000002', type: 'NEGOTIATION', currentParticipantId: '10000001',
    resources: { NEGOTIATION_TOPIC: ['6000000002'], VACANCY: ['700000003'] },
    operations: { allowed: ['LEAVE_CHAT'] },
  };
  const chats = V.buildChats([item], scan.resources, scan.displayInfo);
  assert.deepStrictEqual(chats[0].reasons.sort(), ['вакансия в архиве', 'отказ']);
  assert.strictEqual(chats[0].title, 'Первый', 'заголовок потерялся при слиянии');
});

test('без слияния признаки не находятся — это и был наблюдавшийся провал', () => {
  // Проверка самого предположения: если бы ресурсы брались только с
  // последней страницы, находок не было бы. Объясняет, зачем нужен тест
  // выше, а не «страховка на всякий случай».
  const lastPageOnly = { negotiation_topics: {}, vacancies: {} };
  V.accumulatePage(
    { resources: lastPageOnly, displayInfo: {} },
    { resources: { negotiation_topics: {}, vacancies: {} }, chatsDisplayInfo: {} });

  const item = {
    id: '5000000002', type: 'NEGOTIATION',
    resources: { NEGOTIATION_TOPIC: ['6000000002'], VACANCY: ['700000003'] },
    operations: { allowed: ['LEAVE_CHAT'] },
  };
  assert.deepStrictEqual(V.listReasons(item, lastPageOnly), []);
});

console.log('\nтексты плашки');

test('сообщение «чатов для покидания не нашлось» — фиксированный текст', () => {
  assert.strictEqual(V.NO_CHATS_MESSAGE, 'не найдено чатов для покидания');
});

test('склонение по числу: 1 чат, 3 чата, 5 чатов, 21 чат', () => {
  assert.strictEqual(V.plural(1, 'чат', 'чата', 'чатов'), 'чат');
  assert.strictEqual(V.plural(3, 'чат', 'чата', 'чатов'), 'чата');
  assert.strictEqual(V.plural(5, 'чат', 'чата', 'чатов'), 'чатов');
  assert.strictEqual(V.plural(11, 'чат', 'чата', 'чатов'), 'чатов');
  assert.strictEqual(V.plural(21, 'чат', 'чата', 'чатов'), 'чат');
  assert.strictEqual(V.plural(22, 'чат', 'чата', 'чатов'), 'чата');
});

test('сообщение о покидании согласует число', () => {
  assert.strictEqual(V.leftMessage(1), 'Покинуто 1 чат');
  assert.strictEqual(V.leftMessage(3), 'Покинуто 3 чата');
  assert.strictEqual(V.leftMessage(5), 'Покинуто 5 чатов');
  assert.strictEqual(V.leftMessage(21), 'Покинуто 21 чат');
});

console.log('\nитог');
if (failed.length) {
  console.log(failed.length + ' провалено, ' + passed + ' пройдено\n');
  process.exit(1);
}
console.log(passed + ' пройдено\n');
