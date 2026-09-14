# Записи сертификации

[English version](certification.md)

Каждый task review записывает `certification-<task>-round-<n>.json` в текущий run record до того,
как CAW напечатает или применит verdict.

Запись содержит фактические runtime автора и reviewer (или подписанную identity человека), проверенный режим независимости, полный
criterion ledger, состояние population, baseline review-поверхности, digest дерева, состояние
weak verification, ID открытых findings, digest project policies, executor claims, acceptance
cases и engine-owned receipt fast gate.

Executor claims остаются недоверенными навигационными данными. Receipt создаёт сам CAW: он
связывает состояние команды, status, длительность, ограниченный output и digest проверенных
артефактов с digest доставки. Reviewer получает и claims, и receipt, но не должен считать claim
доказательством движка.

Автоматический task-раунд объединяет primary-проход и настроенные слепые challenger-проходы по
одному digest доставки. Certification сохраняет runtime каждого прохода. Новая находка challenger
получает `late-same-baseline`; спор по carried-пункту не может его одобрить.

Каждый disposition критерия и finding содержит стабильные evidence references. Finding также
связан с criterion, surface, transition и property key. CAW сохраняет наблюдение каждого прохода
и объединяет точные root-cause keys в work packages; сходство текста само по себе никогда не
является причиной для объединения.

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

Проект может сделать weak verification контролируемой, задав одновременно
`weak_source_probe_cmd` и `weak_positive_control_cmd`. Source probe сообщает абсолютные пути к
файлам, которые он действительно загрузил из изолированной review-поверхности. Positive control
меняет tracked-файл и обязан сделать `gate_fast` красным. Перед replay мутаций reviewer CAW
восстанавливает поверхность. Ошибка, timeout, неверный формат или изменение файлов source probe,
как и не пойманный positive control, делают weak evidence недоступной и сертификацию `limited`;
задача для executor из этого не создаётся.

`PLAN.md` переносит состояние, счётчики и digest population из планирования в последующий build.
Ручная задача и старый план получают `population: unknown`, поэтому обычная сертификация для них
невозможна. В коммите будет `accepted with LIMITED certification`.

Сейчас файлы сертификации живут столько же, сколько run records: не более 20 новых и 30 дней.
Перед task-коммитом CAW также записывает полный task contract в приватный Git-путь `caw/audit/`.
В публичном сообщении коммита остаются короткая сводка и SHA-256 записи. Сначала запись сохраняется
как `pending-<digest>.json`, затем переименовывается в `<commit>.json`; прерывание не уничтожает
единственную копию. Внутри остаются spec, notes, certification, snapshot policies, digest
проверенной доставки и точное staged tree. Это локальное приватное состояние Git, оно не
отправляется на remote автоматически.

Перед автоматическим или явным удалением старого run record CAW дописывает компактные счётчики
вызовов, usage state, длительности и certification в `caw/metrics/runs.jsonl`. Там отдельно
учитываются наблюдаемые input, cached input, вычисленный uncached input, output, reasoning, размер
исходного prompt и количество/объём provider events, с группировкой по задаче, раунду и роли.
Отсутствующие provider-поля остаются явно неизвестными. Prompts, ответы провайдеров и
диагностические payload туда не копируются.

Для `human-review` `.caw/CAW.md` указывает OpenSSH allowed-signers файл. `human-review prepare`
создаёт точный census плана или задачи, а `human-review accept` проверяет подпись `ssh-keygen -Y`
в namespace `caw-review`. Подписанные JSON и signature сохраняются в Git-приватном
`caw/human-reviews/`; любое изменение байтов плана или digest доставки инвалидирует аттестацию.
Task attestation имеет версию 2 и требует `evidence_refs` у каждого criterion и carried item.
