# Записи сертификации

[English version](certification.md)

Каждый task review записывает `certification-<task>-round-<n>.json` в текущий run record до того,
как CAW напечатает или применит verdict.

Запись содержит фактические runtime автора и reviewer, проверенный режим независимости, полный
criterion ledger, состояние population, baseline review-поверхности, digest дерева, состояние
weak verification, ID открытых findings и digest project policies.

Состояния записи:

- `approved` — открытых пунктов нет, независимо перечисленная population сохранилась, runtime
  автора известен;
- `limited` — код принят, но нет population или происхождения автора либо weak verification
  недоступна;
- `rejected` — остались блокирующие пункты.

Weak-эксперимент, который поймал gate, записывается как `refuted`. Если baseline, mutation gate
или replay не удалось завершить, результат считается `unavailable`: CAW сохраняет evidence и
ограничивает сертификацию, но не превращает такой результат в требование к коду для executor.
Если `where` указывает существующий файл репозитория, captured mutation должна менять именно этот
файл. Изменение другого компонента считается unavailable evidence, а не подтверждённым weak test.
Captured mutation patches сохраняются как приватные артефакты run record. Строки verification и
certification содержат имя файла, размер и SHA-256, а не встраивают patch в JSON.

`PLAN.md` переносит состояние, счётчики и digest population из планирования в последующий build.
Ручная задача и старый план получают `population: unknown`, поэтому обычная сертификация для них
невозможна. В коммите будет `accepted with LIMITED certification`.

Сейчас файлы сертификации живут столько же, сколько run records: не более 20 новых и 30 дней.
Task contract остаётся навсегда в сообщении коммита; долговременное audit-хранилище — отдельный
контракт.
