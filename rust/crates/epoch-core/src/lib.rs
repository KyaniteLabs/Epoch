pub use epoch_contract::PublicSurfaceContract;

pub mod analytics;
pub mod calendar;
pub mod cocomo;
pub mod cost;
pub mod estimation;
pub mod feedback;
pub mod profiles;
pub mod risk;
pub mod temporal;

pub fn crate_label() -> &'static str {
    "epoch-core"
}

#[cfg(test)]
mod tests {
    use super::crate_label;

    #[test]
    fn reports_crate_label() {
        assert_eq!(crate_label(), "epoch-core");
    }
}
