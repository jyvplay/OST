"""Generate UTC cron examples with croniter 6.0.0, implement_cron_bug=True.
Only schedules accepted by both engines are in this corpus. Month/day
impossibility with weekday OR is separately tested with explicit calendar facts,
as croniter rejects that input before evaluating the weekday branch.
"""
import json
from datetime import datetime, timezone
from importlib.metadata import version
from croniter import croniter

assert version('croniter') == '6.0.0'
start = datetime(2025, 1, 1, tzinfo=timezone.utc)
expressions = ['0 0 */2 * 1', '0 0 1,*/2 * 1', '0 0 */2 * */2',
               '0 12 1-31 * 2', '15 8 1 * 1', '30 6 * 2 MON-FRI']
cases = []
for expr in expressions:
    it = croniter(expr, start, implement_cron_bug=True)
    cases.append({'expression': expr, 'startMs': int(start.timestamp() * 1000),
                  'nextMs': [int(it.get_next(datetime).timestamp() * 1000) for _ in range(5)]})
print(json.dumps({'oracle': 'croniter 6.0.0 (MIT), implement_cron_bug=True', 'cases': cases}, indent=2))
