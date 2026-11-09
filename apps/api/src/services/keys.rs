//! Signing keys for hosts with no key files (Railway and the like).
//!
//! Locally, actor keys live in `~/.contract-zero/keys/…` and never in the repository.
//! A host instead gets ONE secret variable, `CZ_KEYS_JSON`: an object mapping each
//! account id to its key file's JSON (`account_id`, `public_key`, `private_key`). At
//! startup these are written to a private directory (0700, files 0600) that the rest
//! of the server reads exactly like the local one. Values are never logged.

use std::path::PathBuf;

use serde_json::Value;

/// Write the keys out and return (directory, accounts written).
pub fn materialize(json: &str, dir: PathBuf) -> Result<(PathBuf, Vec<String>), String> {
    let v: Value = serde_json::from_str(json).map_err(|_| "CZ_KEYS_JSON is not valid JSON".to_string())?;
    let obj = v.as_object().ok_or("CZ_KEYS_JSON must be an object of account → key file")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("key dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("key dir: {e}"))?;
    }
    let mut written = Vec::new();
    for (account, key) in obj {
        let ok = key["account_id"].as_str() == Some(account.as_str()) && key["public_key"].as_str().is_some_and(|k| k.starts_with("ed25519:")) && key["private_key"].as_str().is_some_and(|k| k.starts_with("ed25519:"));
        if !ok || account.contains('/') || account.contains("..") {
            return Err(format!("CZ_KEYS_JSON: the entry for {account} is not a key file for that account"));
        }
        let file = dir.join(format!("{account}.json"));
        std::fs::write(&file, serde_json::to_vec_pretty(key).expect("json")).map_err(|e| format!("{account}: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("{account}: {e}"))?;
        }
        written.push(account.clone());
    }
    Ok((dir, written))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_written_privately_and_bad_entries_refused() {
        let dir = std::env::temp_dir().join(format!("cz-keys-test-{}", std::process::id()));
        let good = r#"{"a.testnet":{"account_id":"a.testnet","public_key":"ed25519:AAA","private_key":"ed25519:BBB"}}"#;
        let (d, w) = materialize(good, dir.clone()).unwrap();
        assert_eq!(w, vec!["a.testnet"]);
        let f = d.join("a.testnet.json");
        assert!(f.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        for bad in [
            r#"[1]"#,
            r#"{"a.testnet":{"account_id":"b.testnet","public_key":"ed25519:A","private_key":"ed25519:B"}}"#,
            r#"{"../x":{"account_id":"../x","public_key":"ed25519:A","private_key":"ed25519:B"}}"#,
            r#"{"a.testnet":{"account_id":"a.testnet","public_key":"ed25519:A"}}"#,
        ] {
            assert!(materialize(bad, dir.clone()).is_err(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
