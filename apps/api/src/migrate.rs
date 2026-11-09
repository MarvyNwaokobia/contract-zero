//! Startup migrations — apply pending schema changes automatically on boot.
//!
//! Design:
//!   • The .sql files are hand-written and IDEMPOTENT (every CREATE/ALTER/INDEX is guarded
//!     with IF NOT EXISTS, every seed has ON CONFLICT), so they are deliberately re-runnable.
//!     Applied files are tracked in `_schema_migrations` and each runs once, in a fixed
//!     order, inside a transaction.
//!   • Files are EMBEDDED in the binary with include_str!, so a deployed container needs no
//!     migrations/ directory on disk.
//!   • Order is chosen by DEPENDENCY, not alphabetically. Adding a migration = drop the file
//!     in migrations/ and add one line to MIGRATIONS below.

use sqlx::PgPool;

/// (filename, embedded SQL), in dependency order.
const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init.sql", include_str!("../migrations/0001_init.sql")),
    ("0002_settlement.sql", include_str!("../migrations/0002_settlement.sql")),
    ("0003_settlement_v2.sql", include_str!("../migrations/0003_settlement_v2.sql")),
    ("0004_exchange.sql", include_str!("../migrations/0004_exchange.sql")),
    ("0005_auth.sql", include_str!("../migrations/0005_auth.sql")),
    ("0006_profiles.sql", include_str!("../migrations/0006_profiles.sql")),
    ("0007_operations.sql", include_str!("../migrations/0007_operations.sql")),
    ("0008_superseded.sql", include_str!("../migrations/0008_superseded.sql")),
    ("0009_market_history.sql", include_str!("../migrations/0009_market_history.sql")),
    ("0010_mission_story.sql", include_str!("../migrations/0010_mission_story.sql")),
    ("0011_mission_field.sql", include_str!("../migrations/0011_mission_field.sql")),
];

/// Apply every migration not yet recorded, in order, each in its own transaction. Called
/// once at startup before the server binds. A failure here aborts boot on purpose — a box
/// serving requests against a half-migrated schema is worse than a box that won't start.
pub async fn run(db: &PgPool) -> anyhow::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _schema_migrations (
             name       TEXT PRIMARY KEY,
             applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )",
    )
    .execute(db)
    .await?;

    let applied: Vec<String> =
        sqlx::query_scalar("SELECT name FROM _schema_migrations").fetch_all(db).await?;

    let mut ran = 0;
    for (name, sql) in MIGRATIONS {
        if applied.iter().any(|a| a == name) {
            continue;
        }
        tracing::info!("migration: applying {}", name);
        let mut tx = db.begin().await?;
        // raw_sql uses the simple query protocol, so it runs the whole multi-statement
        // file (and handles $$-quoted function bodies) in one round trip.
        sqlx::raw_sql(sql)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow::anyhow!("migration {} failed: {}", name, e))?;
        sqlx::query("INSERT INTO _schema_migrations (name) VALUES ($1)")
            .bind(name)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        ran += 1;
    }

    if ran == 0 {
        tracing::info!("migrations: schema up to date ({} known)", MIGRATIONS.len());
    } else {
        tracing::info!("migrations: applied {} new, {} total", ran, MIGRATIONS.len());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MIGRATIONS;

    #[test]
    fn names_are_unique_and_files_are_not_empty() {
        let mut seen = std::collections::HashSet::new();
        for (name, sql) in MIGRATIONS {
            assert!(seen.insert(*name), "duplicate migration name: {}", name);
            assert!(!sql.trim().is_empty(), "{} is embedded empty", name);
        }
    }

    #[test]
    fn the_list_matches_the_migrations_directory() {
        // Catches both a file nobody registered and a registered file that was deleted.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .expect("migrations/ must be readable")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".sql"))
            .collect();
        on_disk.sort();

        let mut registered: Vec<String> = MIGRATIONS.iter().map(|(n, _)| n.to_string()).collect();
        registered.sort();

        assert_eq!(registered, on_disk, "MIGRATIONS must list exactly the .sql files in migrations/");
    }
}
