//! The injected clock.
//!
//! `World::today` is the one place a compile can observe the outside world, so
//! it is also the one thing that stops output from being reproducible. Making
//! it injectable lets tests pin it and lets callers ask for byte-identical PDFs.
//!
//! # Why there is no "local time"
//!
//! Typst asks for the *local* date when a document calls `datetime.today()`
//! with no offset. Resolving that properly needs a timezone database, which
//! would mean a dependency whose only job is to answer a question the host
//! already knows the answer to — Node reports the offset via
//! `Date.prototype.getTimezoneOffset()`. So the offset is passed in, and this
//! crate does plain arithmetic on it.

use typst::foundations::{Datetime, Duration};

/// The source of the current date for a compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clock {
    /// The system wall clock.
    ///
    /// `offset_minutes` is the timezone offset east of UTC applied when the
    /// document asks for the local date. Note the sign: JavaScript's
    /// `getTimezoneOffset()` returns the opposite, so negate it there.
    System { offset_minutes: i32 },

    /// A fixed instant. Use this for reproducible output and in tests.
    Fixed { unix_seconds: i64, offset_minutes: i32 },

    /// No date is available; `datetime.today()` raises an error in the
    /// document. Useful for proving a template does not depend on the clock.
    Unavailable,
}

impl Default for Clock {
    fn default() -> Self {
        Self::utc()
    }
}

impl Clock {
    /// System time, reported as UTC.
    pub fn utc() -> Self {
        Self::System { offset_minutes: 0 }
    }

    /// A fixed instant in UTC.
    pub fn fixed(unix_seconds: i64) -> Self {
        Self::Fixed { unix_seconds, offset_minutes: 0 }
    }

    /// The current instant as Unix seconds, or `None` if unavailable.
    pub fn now(&self) -> Option<i64> {
        match *self {
            Clock::System { .. } => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64),
            Clock::Fixed { unix_seconds, .. } => Some(unix_seconds),
            Clock::Unavailable => None,
        }
    }

    /// The offset applied when no explicit one is requested.
    pub fn offset_minutes(&self) -> i32 {
        match *self {
            Clock::System { offset_minutes } | Clock::Fixed { offset_minutes, .. } => {
                offset_minutes
            }
            Clock::Unavailable => 0,
        }
    }

    /// Implements `World::today`.
    pub fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        let minutes = match offset {
            Some(duration) => (total_seconds(duration) / 60) as i32,
            None => self.offset_minutes(),
        };
        datetime_at(self.now()? + i64::from(minutes) * 60)
    }

    /// The instant to stamp into PDF metadata, if any.
    pub(crate) fn pdf_timestamp(&self) -> Option<typst_pdf::Timestamp> {
        let minutes = self.offset_minutes();
        let datetime = datetime_at(self.now()? + i64::from(minutes) * 60)?;
        if minutes == 0 {
            Some(typst_pdf::Timestamp::new_utc(datetime))
        } else {
            typst_pdf::Timestamp::new_local(datetime, minutes)
        }
    }
}

fn total_seconds(duration: Duration) -> i64 {
    let [weeks, days, hours, minutes, seconds] = duration.decompose();
    (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds
}

/// Convert Unix seconds to a `Datetime`, treating the input as already offset
/// to the desired timezone.
fn datetime_at(unix_seconds: i64) -> Option<Datetime> {
    let days = unix_seconds.div_euclid(86_400);
    let secs = unix_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    Datetime::from_ymd_hms(
        year,
        month,
        day,
        (secs / 3600) as u8,
        ((secs % 3600) / 60) as u8,
        (secs % 60) as u8,
    )
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch to a
/// proleptic Gregorian date. Exact for the whole `i64` range we care about, and
/// avoids pulling in a date library for twenty lines of arithmetic.
fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], March-based
    let day = (doy - (153 * mp + 2) / 5 + 1) as u8; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year as i32, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_maps_to_1970_01_01() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn known_dates_round_trip() {
        // 2026-07-29T00:00:00Z
        assert_eq!(civil_from_days(20_663), (2026, 7, 29));
        // 2000-02-29 — the century leap year that catches naive implementations.
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        // 1900-03-01, one day after a century that is *not* a leap year.
        assert_eq!(civil_from_days(-25_508), (1900, 3, 1));
    }

    #[test]
    fn pre_epoch_dates_use_floor_division() {
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(datetime_at(-1), Datetime::from_ymd_hms(1969, 12, 31, 23, 59, 59));
    }

    #[test]
    fn a_fixed_clock_is_reproducible() {
        let clock = Clock::fixed(1_785_888_000); // 2026-08-05T00:00:00Z
        assert_eq!(clock.today(None), Datetime::from_ymd_hms(2026, 8, 5, 0, 0, 0));
        assert_eq!(clock.today(None), clock.today(None));
    }

    #[test]
    fn an_explicit_offset_overrides_the_clocks_own() {
        let clock = Clock::Fixed { unix_seconds: 1_785_887_999, offset_minutes: 0 };
        // 2026-08-04T23:59:59Z, so +2h lands on the next day.
        assert_eq!(clock.today(None), Datetime::from_ymd_hms(2026, 8, 4, 23, 59, 59));

        let two_hours = Duration::from(time::Duration::hours(2));
        assert_eq!(clock.today(Some(two_hours)), Datetime::from_ymd_hms(2026, 8, 5, 1, 59, 59));
    }

    #[test]
    fn the_clocks_offset_applies_when_none_is_requested() {
        let clock = Clock::Fixed { unix_seconds: 1_785_887_999, offset_minutes: 330 };
        assert_eq!(clock.today(None), Datetime::from_ymd_hms(2026, 8, 5, 5, 29, 59));
    }

    #[test]
    fn an_unavailable_clock_yields_nothing() {
        assert_eq!(Clock::Unavailable.today(None), None);
        assert!(Clock::Unavailable.pdf_timestamp().is_none());
    }
}
