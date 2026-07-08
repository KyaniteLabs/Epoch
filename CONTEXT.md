# Epoch

Epoch is a local-first time-estimation context for agents and developers. Its language centers on estimates, actuals, calibration, and the public tool surface agents call when they need grounded time, cost, schedule, or risk answers.

## Language

**Estimate**:
A prediction of duration, schedule, cost, or delivery risk produced before or during work.
_Avoid_: Guess, promise, quote

**Actual**:
The observed effort or outcome recorded after work completes so an estimate can be evaluated.
_Avoid_: Result, status update

**Feedback Token**:
A stable reference returned with an estimate so a later actual can be connected to the original estimate.
_Avoid_: Tracking ID, opaque UUID

**Calibration**:
The process of comparing estimates with actuals to correct future estimates for observed bias.
_Avoid_: Tuning, vibes adjustment

**Reference Class**:
A cohort of historical work used as evidence for a new estimate.
_Avoid_: Dataset, sample pile

**Tool Surface**:
The named set of Epoch capabilities an agent or client can discover and call.
_Avoid_: Endpoint list, command list

**Telemetry Submission**:
An explicit opt-in sharing of anonymized estimate-and-actual pairs for improving shared calibration data.
_Avoid_: Phone-home event, usage tracking

**Receiver**:
The service role that accepts telemetry submissions and returns aggregate acceptance and deduplication results.
_Avoid_: Tracker, analytics backend
