pub use epoch_contract::PublicSurfaceContract;

pub fn crate_label() -> &'static str {
    "epoch-mcp"
}

#[cfg(test)]
mod tests {
    use super::crate_label;

    #[test]
    fn reports_crate_label() {
        assert_eq!(crate_label(), "epoch-mcp");
    }
}
