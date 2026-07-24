# Changelog

## 9.1.0-km.7 - 2026-07-24

### Added

- Added a `setPumpCircuitSpeed` rule action for changing a pump circuit's configured RPM from automation rules.

## 9.1.0-km.6 - 2026-07-22

### Added

- Added rule conditions for circuit/feature runtime and rule condition stable time.

## 9.1.0-km.5 - 2026-07-20

### Fixed

- Ensured rule action log events are still persisted when an equipment command reports an error.

## 9.1.0-km.4 - 2026-07-20

### Added

- Added rule engine lifecycle entries to the rule action log when the engine starts, stops, or is enabled/disabled.

## 9.1.0-km.3 - 2026-07-15

### Added

- Added configurable dew point smoothing to reject isolated bad observations before updating rules and history.

### Changed

- Documented METAR dew point configuration with smoothing options.

## 9.1.0-km.2 - 2026-07-08

### Added

- Added persistent rules action logging to `data/rule-actions.jsonl`.
- Added `GET /config/rules/log` for retrieving recent rule action events.
- Added configurable dew point providers with optional METAR station observations and Open-Meteo fallback.

## 9.1.0-km.1 - 2026-06-28

### Added

- Added local rules engine automation.
- Added rule group active windows.
- Added temperature history persistence and dew point support.
- Added configurable solar-source visibility and labeling for alternate temperature inputs such as Glacier.
