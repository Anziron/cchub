//! `hubd` 和桌面端共用的类型。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    pub version: String,
    pub protocol_version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_serializes_with_snake_case_fields() {
        let health = Health {
            version: "0.1.0".into(),
            protocol_version: PROTOCOL_VERSION,
        };
        let json = serde_json::to_value(&health).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"version": "0.1.0", "protocol_version": 0})
        );
    }
}
