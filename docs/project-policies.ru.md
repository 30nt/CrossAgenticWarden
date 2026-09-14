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

Допустимые этапы: `planning`, `review`, `gate` и `commit`. API версии 1 сохраняет описанный ниже
однофазный контракт. API версии 2 добавляет двухфазное risk-aware планирование; форматы выхода
трёх остальных этапов остаются прежними. Неизвестные поля и этапы, симлинки, слишком большое
дерево policies, невалидные команды и превышение времени отклоняются.

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
- `gate` возвращает `{"action":"continue","reason":""}` или обоснованный `stop`. Policy не
  может превратить красный, не запустившийся или превысивший timeout gate ядра в зелёный.
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

Команды policies работают в отдельном временном каталоге с сокращённым окружением. CAW проверяет,
что не изменились дерево доставки, HEAD, файлы CAW, policies и очередь задач. Это проверка
побочного эффекта, а не граница безопасности ОС: policies являются доверенным кодом проекта,
как и настроенная команда gate.

## Проверка и записи

```bash
node caw.mjs verify-project
```

Команда выполняет каждый настроенный этап с проверочным входом и валидирует его результат. Для
API v2 planning проверяются обе фазы. Run record хранит digest манифеста и каждой policy,
длительность, этап и результат. Состояние задачи запоминает набор policies и сообщает о
расхождении после их изменения.
