# services/

Background & compute services. Added in later increments:

- **crawler/** — NestJS worker. Source-adapter framework, BullMQ consumers,
  dedupe + verify pipeline. Compliant adapters: Google News RSS, Reddit JSON,
  YouTube Data API, generic RSS. (Risky scrapers are intentionally excluded.)
- **ml/** — FastAPI + Python. Poisson/xG goal model, XGBoost ensemble,
  Monte Carlo simulation, EV + Kelly calculators, probability calibration.
