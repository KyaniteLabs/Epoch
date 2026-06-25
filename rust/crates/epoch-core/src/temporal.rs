use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use epoch_contract::{DateDiffResult, DurationResult, TemporalResult, ToolError};

pub fn get_current_time(timezone: &str) -> Result<TemporalResult, ToolError> {
    let tz = parse_timezone(timezone).map_err(|_| {
        ToolError::new(
            format!("Invalid timezone: \"{timezone}\". Use IANA identifiers like 'America/New_York'."),
            "Try a canonical IANA timezone such as 'UTC', 'America/Los_Angeles', or 'Europe/London'.",
        )
    })?;
    Ok(format_temporal(Utc::now(), tz, timezone))
}

pub fn convert_timezone(timestamp: &str, target_tz: &str) -> Result<TemporalResult, ToolError> {
    let parsed = parse_datetime(timestamp).map_err(|_| {
        ToolError::new(
            format!("Invalid timestamp: \"{timestamp}\". Use ISO-8601 format like \"2026-05-01T14:30:00Z\"."),
            "Provide a valid ISO-8601 date string.",
        )
    })?;
    let tz = parse_timezone(target_tz).map_err(|_| {
        ToolError::new(
            format!(
                "Invalid target timezone: \"{target_tz}\". Use IANA identifiers like 'Asia/Tokyo'."
            ),
            "Try a canonical IANA timezone such as 'UTC', 'America/Chicago', or 'Europe/Berlin'.",
        )
    })?;
    Ok(format_temporal(parsed, tz, target_tz))
}

pub fn parse_duration(duration_string: &str) -> Result<DurationResult, ToolError> {
    if duration_string.trim().is_empty() {
        return Err(ToolError::new(
            "Empty duration string.",
            "Provide a duration like '2h30m', '1d6h', '45m', or '1w2d'.",
        ));
    }

    let input = duration_string.trim();
    let compact = input.split_whitespace().collect::<String>();
    let mut cursor = 0;
    let mut parts: Vec<(f64, String)> = Vec::new();
    let bytes = compact.as_bytes();

    while cursor < bytes.len() {
        let number_start = cursor;
        let mut saw_digit = false;
        let mut saw_dot = false;
        while cursor < bytes.len() {
            let b = bytes[cursor];
            if b.is_ascii_digit() {
                saw_digit = true;
                cursor += 1;
            } else if b == b'.' && !saw_dot {
                saw_dot = true;
                cursor += 1;
            } else {
                break;
            }
        }

        if !saw_digit {
            return duration_parse_error(input);
        }

        let value = compact[number_start..cursor].parse::<f64>().map_err(|_| {
            ToolError::new(
                format!("Unrecognised tokens in duration: \"{input}\"."),
                "Use only y, mo, w, d, h, m, s — e.g. '2h30m', '1d', '3mo2w'.",
            )
        })?;

        let unit = if compact[cursor..].starts_with("mo") {
            cursor += 2;
            "mo"
        } else if cursor < bytes.len() {
            let unit = &compact[cursor..cursor + 1];
            if !matches!(unit, "y" | "w" | "d" | "h" | "m" | "s") {
                return duration_parse_error(input);
            }
            cursor += 1;
            unit
        } else {
            return duration_parse_error(input);
        };

        parts.push((value, unit.to_string()));
    }

    if parts.is_empty() {
        return Err(ToolError::new(
            format!("Could not parse duration: \"{input}\". No valid duration tokens found."),
            "Use combinations of y, mo, w, d, h, m, s — e.g. '2h30m' or '1w3d12h'.",
        ));
    }

    let reconstructed = parts
        .iter()
        .map(|(value, unit)| format!("{}{}", format_number(*value), unit))
        .collect::<String>();
    if reconstructed != compact {
        return Err(ToolError::new(
            format!("Unrecognised tokens in duration: \"{input}\"."),
            "Use only y, mo, w, d, h, m, s — e.g. '2h30m', '1d', '3mo2w'.",
        ));
    }

    let mut total_seconds = 0.0;
    let mut years = 0.0;
    let mut months = 0.0;
    let mut weeks = 0.0;
    let mut days = 0.0;
    let mut hours = 0.0;
    let mut minutes = 0.0;
    let mut seconds = 0.0;

    for (value, unit) in parts {
        match unit.as_str() {
            "y" => {
                years += value;
                total_seconds += value * 365.25 * 24.0 * 3600.0;
            }
            "mo" => {
                months += value;
                total_seconds += value * 30.44 * 24.0 * 3600.0;
            }
            "w" => {
                weeks += value;
                total_seconds += value * 7.0 * 24.0 * 3600.0;
            }
            "d" => {
                days += value;
                total_seconds += value * 24.0 * 3600.0;
            }
            "h" => {
                hours += value;
                total_seconds += value * 3600.0;
            }
            "m" => {
                minutes += value;
                total_seconds += value * 60.0;
            }
            "s" => {
                seconds += value;
                total_seconds += value;
            }
            _ => {}
        }
    }

    let mut segments = Vec::new();
    push_segment(&mut segments, years, "year");
    push_segment(&mut segments, months, "month");
    push_segment(&mut segments, weeks, "week");
    push_segment(&mut segments, days, "day");
    push_segment(&mut segments, hours, "hour");
    push_segment(&mut segments, minutes, "minute");
    push_segment(&mut segments, seconds, "second");

    Ok(DurationResult {
        input: input.to_string(),
        total_seconds: (total_seconds * 100.0).round() / 100.0,
        human_readable: if segments.is_empty() {
            "0 seconds".to_string()
        } else {
            segments.join(" ")
        },
    })
}

pub fn format_elapsed(ms: i64) -> String {
    let ms = ms.max(0);
    let total_seconds = ms / 1000;
    let days = total_seconds / 86400;
    let hours = (total_seconds % 86400) / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    let mut segments = Vec::new();
    if days > 0 {
        segments.push(format!("{days}d"));
    }
    if hours > 0 {
        segments.push(format!("{hours}h"));
    }
    if minutes > 0 {
        segments.push(format!("{minutes}m"));
    }
    if seconds > 0 || segments.is_empty() {
        segments.push(format!("{seconds}s"));
    }
    segments.join(" ")
}

pub fn add_days(date: &str, days: i64) -> String {
    let Ok(parsed) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return "Invalid Date".to_string();
    };
    (parsed + Duration::days(days))
        .format("%Y-%m-%d")
        .to_string()
}

pub fn diff_dates(start: &str, end: &str) -> DateDiffResult {
    let start_date = parse_datetime(start).unwrap_or_else(|_| Utc.timestamp_opt(0, 0).unwrap());
    let end_date = parse_datetime(end).unwrap_or_else(|_| Utc.timestamp_opt(0, 0).unwrap());
    let total_seconds = (end_date - start_date).num_seconds();
    let abs_seconds = total_seconds.abs();
    let sign = if total_seconds < 0 { -1 } else { 1 };

    DateDiffResult {
        days: sign * (abs_seconds / 86400),
        hours: sign * ((abs_seconds % 86400) / 3600),
        minutes: sign * ((abs_seconds % 3600) / 60),
        total_seconds,
    }
}

fn format_temporal(instant: DateTime<Utc>, tz: Tz, timezone: &str) -> TemporalResult {
    let zoned = instant.with_timezone(&tz);
    TemporalResult {
        iso: zoned.format("%Y-%m-%dT%H:%M:%S%:z").to_string(),
        human_readable: zoned.format("%A, %B %-d, %Y at %-I:%M %p (%Z)").to_string(),
        timezone: timezone.to_string(),
        utc_offset: zoned.format("%:z").to_string(),
    }
}

fn parse_timezone(timezone: &str) -> Result<Tz, ()> {
    timezone.parse::<Tz>().map_err(|_| ())
}

fn parse_datetime(input: &str) -> Result<DateTime<Utc>, ()> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(input) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(date) = NaiveDate::parse_from_str(input, "%Y-%m-%d") {
        return Ok(date.and_hms_opt(0, 0, 0).unwrap().and_utc());
    }
    Err(())
}

fn duration_parse_error(input: &str) -> Result<DurationResult, ToolError> {
    Err(ToolError::new(
        format!("Unrecognised tokens in duration: \"{input}\"."),
        "Use only y, mo, w, d, h, m, s — e.g. '2h30m', '1d', '3mo2w'.",
    ))
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

fn push_segment(segments: &mut Vec<String>, value: f64, singular: &str) {
    if value > 0.0 {
        let suffix = if value == 1.0 { "" } else { "s" };
        segments.push(format!("{} {singular}{suffix}", format_number(value)));
    }
}

#[cfg(test)]
mod tests {
    use super::{add_days, convert_timezone, diff_dates, format_elapsed, parse_duration};

    #[test]
    fn converts_utc_to_los_angeles() {
        let result = convert_timezone("2026-05-01T12:00:00Z", "America/Los_Angeles")
            .expect("timezone conversion succeeds");
        assert_eq!(result.timezone, "America/Los_Angeles");
        assert!(result.iso.contains("T05:00:00"));
        assert_eq!(result.utc_offset, "-07:00");
    }

    #[test]
    fn parses_duration_components() {
        let result = parse_duration("1w2d3h45m").expect("duration parses");
        assert_eq!(
            result.total_seconds,
            1.0 * 7.0 * 86400.0 + 2.0 * 86400.0 + 3.0 * 3600.0 + 45.0 * 60.0
        );
        assert!(result.human_readable.contains("1 week"));
        assert!(result.human_readable.contains("45 minutes"));
    }

    #[test]
    fn rejects_partial_duration_tokens() {
        let err = parse_duration("2hxyz").expect_err("partial tokens fail");
        assert!(err.message.contains("Unrecognised tokens"));
    }

    #[test]
    fn formats_elapsed_duration() {
        assert_eq!(format_elapsed(-1000), "0s");
        assert_eq!(format_elapsed(90_061_000), "1d 1h 1m 1s");
    }

    #[test]
    fn adds_calendar_days_and_reports_invalid_dates() {
        assert_eq!(add_days("2026-12-28", 5), "2027-01-02");
        assert_eq!(add_days("not-a-date", 5), "Invalid Date");
    }

    #[test]
    fn diffs_dates_with_signed_parts() {
        let result = diff_dates("2026-05-03", "2026-05-01");
        assert_eq!(result.days, -2);
        assert_eq!(result.total_seconds, -2 * 86400);

        let partial = diff_dates("2026-05-01T10:00:00Z", "2026-05-01T11:30:00Z");
        assert_eq!(partial.hours, 1);
        assert_eq!(partial.minutes, 30);
    }
}
