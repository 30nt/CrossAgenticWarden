# Проектные policies

[English version](project-policies.md)

Project policies настраивают CAW без правок `caw.mjs` и поставляемых ролей. Они находятся в
`.caw/project/`, принадлежат проекту и не входят в проверку установки и обновления CAW.

## Манифест

Создайте `.caw/project/manifest.json`:

```json
{
  "api_version": 1,
  "policies": {
    "planning": {
      "id": "product-boundaries",
      "command": ["node", ".caw/project/planning.mjs"],
      "timeout_ms": 5000
    }
  }
}
```

Допустимые этапы: `planning`, `review`, `gate`, `commit` и, для API v3, `acceptance`.
API версии 1 сохраняет описанный ниже
однофазный контракт. API версии 2 добавляет двухфазное risk-aware планирование и ограниченный
повтор flaky gate. API версии 3 сохраняет эти контракты и добавляет project acceptance matrix;
review и commit сохраняют формат API v1. Неизвестные поля и этапы, симлинки,
слишком большое дерево policies, невалидные команды и превышение времени отклоняются.

## Протокол

CAW запускает команду напрямую, без shell, и передаёт один JSON-объект в stdin:

```json
{"api_version":1,"stage":"planning","context":{}}
```

Policy должна вывести ровно один JSON-объект в stdout. Диагностику следует писать в stderr.
Вывод ограничен 256 КиБ, вход — 1 МиБ, файлы policies — 2 МиБ, timeout — 60 секундами.

- В API v1 `planning` возвращает `{"issues":[],"instructions":[]}`. Проблемы останавливают запуск до
  provider-вызовов; инструкции добавляются в профиль планирования.
- `review` возвращает `{"criteria":[],"instructions":[]}`. Критерии добавляются к ledger ядра
  под ID с namespace движка и не могут удалить критерии ядра.
- В API v1 `gate` возвращает `{"action":"continue","reason":""}` или обоснованный `stop`.
  Policy не может превратить красный, не запустившийся или превысивший timeout gate ядра в зелёный.
- `commit` возвращает `{"subject":""}`. Непустое значение меняет только заголовок коммита.
  Staging, audit-текст и сам commit остаются под управлением ядра.

## Risk-aware планирование (API v2)

Укажите в манифесте `api_version: 2`. CAW вызовет planning policy дважды.

Фаза `request` выполняется до enumerator. В context находятся `phase`, `request` и `profile`.
Ответ:

```json
{
  "issues": [],
  "instructions": [],
  "risk": {
    "class": "regulated",
    "population_requirement": "complete",
    "require_full_gate_baseline": true
  }
}
```

Risk class — локальный для проекта lowercase ID. Требование к population принимает значения
`none`, `sample` или `complete`.

Фаза `population` выполняется после независимой enumeration и до architect. В context находятся
первый risk-ответ, разрешённая population, счётчики, адреса источников и digest. Ответ:

```json
{
  "issues": [],
  "instructions": [],
  "attestation": {
    "state": "complete",
    "population_digest": "<точно скопировать context.population.digest>",
    "evidence": "project-specific проверка закрытого множества"
  }
}
```

CAW никогда не выводит `complete` из model sample. Это состояние принимается только от доверенной
project policy, для точного digest population и с непустым evidence. Аттестация слабее требования
из фазы request останавливает запуск до architect.

Если `require_full_gate_baseline` равен true, CAW сохраняет приватную risk-запись очереди.
`build --no-full` отклоняется, `gate_full` должен быть настроен и обязан быть зелёным на стартовом
коммите до первого вызова executor. Тогда финальный красный full gate относится именно к диапазону
этого build. Если задача остановилась для решения, baseline остаётся вместе с очередью. `round` и
`review` принимают его, только пока его commit остаётся предком HEAD и `gate_full` не изменился,
после чего запускают финальный full gate для продолженной задачи. Risk-запись удаляется вместе с
опустевшей очередью.

Переиспользование baseline включается явно. До полного gate policy v2 получает
`kind: "full-baseline-inputs"` и `known_inputs`. Чтобы разрешить кэш, она возвращает SHA-256 digest
всех дополнительных входов, которые может видеть gate:

```json
{"action":"continue","reason":"","baseline_inputs_digest":"<64 lowercase hex>"}
```

Обычно сюда входят ignored dependencies и cache, версии SDK или simulator, состояние сервисов и
значимые внешние настройки. CAW объединяет project digest с digest HEAD, delivery и очереди,
версией ядра, профилем, окружением gate, набором policies, risk attestation, командой gate и timeout. Прошлый
зелёный baseline используется только при точном совпадении общего digest. Если поля или gate
policy v2 нет, CAW снова запускает полный baseline. При cache miss CAW повторно получает project
digest после gate и отклоняет baseline, если входы изменились во время запуска.

## Классификация flaky gate (API v2)

Gate policy v2 может добавить `classification`: `defect`, `flaky`, `infrastructure` или `unknown`.
После красного результата она может вернуть:

```json
{"action":"retry","classification":"flaky","reason":"matched the project allowlist"}
```

CAW всё равно сначала выполняет собственное подтверждение. Policy retry разрешён только для
подтверждённого red и не более двух раз для одной delivery. Executor во время этих повторов не
запускается. Если gate остаётся красным, продолжается обычный ограниченный цикл executor/review.
Allowlist и правила классификации находятся в project policy; run record сохраняет каждое решение.

## Acceptance matrix (API v3)

Укажите `api_version: 3` и при необходимости настройте этап `acceptance`. CAW вызывает его один
раз для каждой задачи до executor. В context находятся ID задачи и разобранные движком
`criteria`, `surfaces` и `transitions`.

Policy возвращает `{"cases":[]}`. Каждый case содержит:

- стабильный lowercase `id` и один или несколько `criterion_ids`;
- известный `surface_id` и необязательный известный `transition_id`;
- `production_consumer`, `scenario`, `observable` и `mutation`;
- lowercase `evidence_kind` и стабильный `selector`.

Если этап настроен, matrix обязана покрывать каждый критерий и каждый объявленный transition.
Неизвестные и повторяющиеся ID, переходы от другой surface, пустые измерения и неполная matrix
отклоняются до executor.

Fast gate получает `CAW_GATE_EVIDENCE_OUT` и `CAW_GATE_ARTIFACTS_DIR`. В первый путь можно
записать JSON manifest версии 1:

```json
{
  "version": 1,
  "checks": [{
    "id": "language-switch",
    "criterion_ids": ["done-when-1"],
    "acceptance_case_ids": ["ui-language-switch"],
    "selector": "settings.language",
    "evidence_kind": "xcui-result",
    "state": "passed",
    "summary": "mounted consumer changed language",
    "artifacts": [{"id": "result-bundle", "path": "result.xcresult.zip"}]
  }]
}
```

Пути артефактов задаются относительно `CAW_GATE_ARTIFACTS_DIR`. CAW отклоняет traversal,
symlink, не-regular files, неизвестные ссылки, неверные evidence kinds или selectors, повторяющиеся ID и
превышение лимитов. Принятые артефакты хешируются и сохраняются приватно. При наличии acceptance
matrix зелёный gate обязан содержать passed check для каждого case, иначе evidence отклоняется до
reviewer.

Команды policies работают в отдельном временном каталоге с сокращённым окружением. CAW проверяет,
что не изменились дерево доставки, HEAD, файлы CAW, policies и очередь задач. Это проверка
побочного эффекта, а не граница безопасности ОС: policies являются доверенным кодом проекта,
как и настроенная команда gate.

## Проверка и записи

```bash
node caw.mjs verify-project
```

Команда выполняет каждый настроенный этап с проверочным входом и валидирует его результат. Для
API v2 проверяются обе фазы planning, а gate policy проверяется в обычной фазе и в фазе входов
baseline. Для API v3 также проверяются полнота matrix и ссылки. Run record хранит digest
манифеста и каждой policy, длительность, этап и результат.
Состояние задачи запоминает набор policies и сообщает о расхождении после их изменения.
