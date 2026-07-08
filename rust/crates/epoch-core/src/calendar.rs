use chrono::{DateTime, Datelike, Duration, NaiveDate, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use epoch_contract::{BusinessDayResult, ToolError};

pub fn supported_countries() -> Vec<&'static str> {
    vec!["US", "UK", "FR", "DE", "JP"]
}

pub fn add_business_days(
    start_date: &str,
    days: i64,
    country_code: &str,
) -> Result<BusinessDayResult, ToolError> {
    let parsed = parse_date(start_date)?;
    let code = country_code.to_uppercase();
    let known_country = has_country(&code);
    let direction = if days >= 0 { 1 } else { -1 };
    let target_count = days.abs();
    let mut added = 0;
    let mut current = parsed;

    while added < target_count {
        current += Duration::days(direction);
        if is_weekend(current) {
            continue;
        }
        if known_country && holiday_date_keys(&code, current.year()).contains(&date_key(current)) {
            continue;
        }
        added += 1;
    }

    Ok(BusinessDayResult {
        start_date: date_key(parsed),
        end_date: date_key(current),
        business_days: target_count,
        country_code: code.clone(),
        human_readable: format!(
            "{} business days from {} to {} ({}).",
            target_count,
            date_key(parsed),
            date_key(current),
            code,
        ),
    })
}

pub fn count_business_days(
    start_date: &str,
    end_date: &str,
    country_code: &str,
) -> Result<BusinessDayResult, ToolError> {
    let start = parse_date(start_date)?;
    let end = parse_date(end_date)?;
    let code = country_code.to_uppercase();
    let known_country = has_country(&code);
    let mut current = start + Duration::days(1);
    let mut business_days = 0;

    while current <= end {
        let holidays = if known_country {
            holiday_date_keys(&code, current.year())
        } else {
            Vec::new()
        };
        if !is_weekend(current) && !holidays.contains(&date_key(current)) {
            business_days += 1;
        }
        current += Duration::days(1);
    }

    Ok(BusinessDayResult {
        start_date: date_key(start),
        end_date: date_key(end),
        business_days,
        country_code: code.clone(),
        human_readable: format!(
            "{} business days between {} and {} ({}).",
            business_days,
            date_key(start),
            date_key(end),
            code,
        ),
    })
}

pub fn is_business_day(date: &str, country_code: &str) -> bool {
    let Ok(parsed) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return false;
    };
    if is_weekend(parsed) {
        return false;
    }
    let code = country_code.to_uppercase();
    !holiday_date_keys(&code, parsed.year()).contains(&date_key(parsed))
}

pub fn is_within_working_hours(date: &str, timezone: &str, start_hour: u32, end_hour: u32) -> bool {
    let Ok(parsed) = parse_datetime(date) else {
        return false;
    };
    let Ok(tz) = timezone.parse::<Tz>() else {
        return false;
    };
    let hour = parsed.with_timezone(&tz).hour();

    if start_hour <= end_hour {
        hour >= start_hour && hour < end_hour
    } else {
        hour >= start_hour || hour < end_hour
    }
}

pub fn get_urgency_category(hours: f64) -> &'static str {
    if hours < 2.0 {
        "short"
    } else if hours <= 48.0 {
        "medium"
    } else {
        "long"
    }
}

fn parse_date(date: &str) -> Result<NaiveDate, ToolError> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| {
        ToolError::new(
            format!("Invalid date: \"{date}\". Use ISO-8601 format like \"2026-05-01\"."),
            "Provide a valid ISO-8601 date string.",
        )
    })
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

fn has_country(country: &str) -> bool {
    matches!(country, "US" | "UK" | "FR" | "DE" | "JP")
}

fn holiday_date_keys(country: &str, year: i32) -> Vec<String> {
    holidays(country, year).into_iter().map(date_key).collect()
}

fn holidays(country: &str, year: i32) -> Vec<NaiveDate> {
    match country {
        "US" => us_holidays(year),
        "UK" => uk_holidays(year),
        "FR" => fr_holidays(year),
        "DE" => de_holidays(year),
        "JP" => jp_holidays(year),
        _ => Vec::new(),
    }
}

fn us_holidays(year: i32) -> Vec<NaiveDate> {
    let easter = easter_sunday(year);
    vec![
        date(year, 1, 1),
        nth_weekday_of_month(year, 1, Weekday::Mon, 3),
        nth_weekday_of_month(year, 2, Weekday::Mon, 3),
        easter - Duration::days(2),
        last_weekday_of_month(year, 5, Weekday::Mon),
        date(year, 6, 19),
        date(year, 7, 4),
        nth_weekday_of_month(year, 9, Weekday::Mon, 1),
        nth_weekday_of_month(year, 10, Weekday::Mon, 2),
        date(year, 11, 11),
        nth_weekday_of_month(year, 11, Weekday::Thu, 4),
        date(year, 12, 25),
    ]
}

fn uk_holidays(year: i32) -> Vec<NaiveDate> {
    let easter = easter_sunday(year);
    vec![
        date(year, 1, 1),
        easter - Duration::days(2),
        easter + Duration::days(1),
        nth_weekday_of_month(year, 5, Weekday::Mon, 1),
        last_weekday_of_month(year, 5, Weekday::Mon),
        last_weekday_of_month(year, 8, Weekday::Mon),
        date(year, 12, 25),
        date(year, 12, 26),
    ]
}

fn fr_holidays(year: i32) -> Vec<NaiveDate> {
    let easter = easter_sunday(year);
    vec![
        date(year, 1, 1),
        easter + Duration::days(1),
        date(year, 5, 1),
        date(year, 5, 8),
        easter + Duration::days(39),
        easter + Duration::days(50),
        date(year, 7, 14),
        date(year, 8, 15),
        date(year, 11, 1),
        date(year, 11, 11),
        date(year, 12, 25),
    ]
}

fn de_holidays(year: i32) -> Vec<NaiveDate> {
    let easter = easter_sunday(year);
    vec![
        date(year, 1, 1),
        easter - Duration::days(2),
        easter + Duration::days(1),
        date(year, 5, 1),
        easter + Duration::days(39),
        easter + Duration::days(50),
        date(year, 10, 3),
        date(year, 12, 25),
        date(year, 12, 26),
    ]
}

fn jp_holidays(year: i32) -> Vec<NaiveDate> {
    vec![
        date(year, 1, 1),
        nth_weekday_of_month(year, 1, Weekday::Mon, 2),
        date(year, 2, 11),
        date(year, 3, if year <= 2026 { 21 } else { 20 }),
        date(year, 4, 29),
        date(year, 5, 3),
        date(year, 5, 4),
        date(year, 5, 5),
        nth_weekday_of_month(year, 7, Weekday::Mon, 3),
        date(year, 8, 11),
        nth_weekday_of_month(year, 9, Weekday::Mon, 3),
        date(year, 9, if year <= 2026 { 23 } else { 22 }),
        nth_weekday_of_month(year, 10, Weekday::Mon, 2),
        date(year, 11, 3),
        date(year, 11, 23),
    ]
}

fn easter_sunday(year: i32) -> NaiveDate {
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = ((h + l - 7 * m + 114) % 31) + 1;
    date(year, month as u32, day as u32)
}

fn nth_weekday_of_month(year: i32, month: u32, weekday: Weekday, n: i64) -> NaiveDate {
    let mut current = date(year, month, 1);
    while current.weekday() != weekday {
        current += Duration::days(1);
    }
    current + Duration::days((n - 1) * 7)
}

fn last_weekday_of_month(year: i32, month: u32, weekday: Weekday) -> NaiveDate {
    let next_month = if month == 12 {
        date(year + 1, 1, 1)
    } else {
        date(year, month + 1, 1)
    };
    let mut current = next_month - Duration::days(1);
    while current.weekday() != weekday {
        current -= Duration::days(1);
    }
    current
}

fn is_weekend(date: NaiveDate) -> bool {
    matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

fn date_key(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn date(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("valid fixed holiday")
}

#[cfg(test)]
mod tests {
    use super::{
        add_business_days, count_business_days, get_urgency_category, is_business_day,
        is_within_working_hours, supported_countries,
    };

    #[test]
    fn recognises_supported_countries() {
        let countries = supported_countries();
        assert!(countries.contains(&"US"));
        assert!(countries.contains(&"UK"));
        assert!(countries.contains(&"FR"));
        assert!(countries.contains(&"DE"));
        assert!(countries.contains(&"JP"));
    }

    #[test]
    fn checks_business_days() {
        assert!(is_business_day("2026-05-04", "US"));
        assert!(!is_business_day("2026-05-02", "US"));
        assert!(!is_business_day("2026-12-25", "US"));
        assert!(!is_business_day("not-a-date", "US"));
    }

    #[test]
    fn adds_business_days_over_weekends_and_holidays() {
        let weekend = add_business_days("2026-05-01", 1, "US").expect("business day add succeeds");
        assert_eq!(weekend.end_date, "2026-05-04");

        let holiday = add_business_days("2026-12-24", 1, "US").expect("holiday skip succeeds");
        assert_eq!(holiday.business_days, 1);
        assert_eq!(holiday.end_date, "2026-12-28");
    }

    #[test]
    fn counts_business_days_exclusive_start_inclusive_end() {
        let week = count_business_days("2026-05-04", "2026-05-08", "US")
            .expect("business day count succeeds");
        assert_eq!(week.business_days, 4);

        let weekend =
            count_business_days("2026-05-01", "2026-05-04", "US").expect("weekend skip succeeds");
        assert_eq!(weekend.business_days, 1);
    }

    #[test]
    fn checks_working_hours_and_urgency() {
        assert!(is_within_working_hours(
            "2026-05-04T10:00:00Z",
            "UTC",
            9,
            17
        ));
        assert!(!is_within_working_hours(
            "2026-05-04T08:00:00Z",
            "UTC",
            9,
            17
        ));
        assert!(!is_within_working_hours("bad-date", "UTC", 9, 17));

        assert_eq!(get_urgency_category(1.0), "short");
        assert_eq!(get_urgency_category(48.0), "medium");
        assert_eq!(get_urgency_category(49.0), "long");
    }
}
