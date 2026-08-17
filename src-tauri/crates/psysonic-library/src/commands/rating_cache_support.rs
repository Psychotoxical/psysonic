use rusqlite::{params, OptionalExtension};

use crate::dto::{EntityUserRatingDto, EntityUserRatingRefDto};
use crate::store::LibraryStore;

/// Shared cache callers can request or update at most 300 entity ratings per call.
pub(super) const ENTITY_USER_RATINGS_BATCH_LIMIT: usize = 300;

fn valid_entity_user_rating_key(server_id: &str, entity_kind: &str, entity_id: &str) -> bool {
    !server_id.is_empty()
        && !entity_id.is_empty()
        && matches!(entity_kind, "track" | "album" | "artist")
}

pub(super) fn get_entity_user_ratings(
    store: &LibraryStore,
    refs: &[EntityUserRatingRefDto],
) -> Result<Vec<EntityUserRatingDto>, String> {
    store.with_read_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT server_id, entity_kind, entity_id, rating, fetched_at
             FROM entity_user_rating
             WHERE server_id = ?1 AND entity_kind = ?2 AND entity_id = ?3",
        )?;
        let mut ratings = Vec::new();
        for reference in refs {
            let server_id = reference.server_id.trim();
            let entity_kind = reference.entity_kind.trim();
            let entity_id = reference.entity_id.trim();
            if !valid_entity_user_rating_key(server_id, entity_kind, entity_id) {
                continue;
            }
            if let Some(rating) = statement
                .query_row(params![server_id, entity_kind, entity_id], |row| {
                    Ok(EntityUserRatingDto {
                        server_id: row.get(0)?,
                        entity_kind: row.get(1)?,
                        entity_id: row.get(2)?,
                        rating: row.get(3)?,
                        fetched_at: row.get(4)?,
                    })
                })
                .optional()?
            {
                ratings.push(rating);
            }
        }
        Ok(ratings)
    })
}

pub(super) fn put_entity_user_ratings(
    store: &LibraryStore,
    ratings: &[EntityUserRatingDto],
    now: i64,
) -> Result<(), String> {
    store.with_conn_mut("entity_user_rating.upsert_batch", |conn| {
        let transaction = conn.transaction()?;
        let mut statement = transaction.prepare(
            "INSERT INTO entity_user_rating (server_id, entity_kind, entity_id, rating, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(server_id, entity_kind, entity_id) DO UPDATE SET
               rating = excluded.rating,
               fetched_at = excluded.fetched_at",
        )?;
        for rating in ratings {
            let server_id = rating.server_id.trim();
            let entity_kind = rating.entity_kind.trim();
            let entity_id = rating.entity_id.trim();
            if !valid_entity_user_rating_key(server_id, entity_kind, entity_id) {
                continue;
            }
            statement.execute(params![
                server_id,
                entity_kind,
                entity_id,
                rating.rating,
                rating.fetched_at.max(now),
            ])?;
        }
        drop(statement);
        transaction.commit()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_user_rating_cache_is_owner_scoped_and_ignores_malformed_keys() {
        let store = LibraryStore::open_in_memory();
        let ratings = vec![
            EntityUserRatingDto {
                server_id: "s1".into(),
                entity_kind: "track".into(),
                entity_id: "same-id".into(),
                rating: 4,
                fetched_at: 10,
            },
            EntityUserRatingDto {
                server_id: "s2".into(),
                entity_kind: "track".into(),
                entity_id: "same-id".into(),
                rating: 2,
                fetched_at: 11,
            },
            EntityUserRatingDto {
                server_id: "s1".into(),
                entity_kind: "invalid".into(),
                entity_id: "ignored".into(),
                rating: 5,
                fetched_at: 12,
            },
        ];
        put_entity_user_ratings(&store, &ratings, 100).unwrap();

        let found = get_entity_user_ratings(
            &store,
            &[
                EntityUserRatingRefDto {
                    server_id: "s2".into(),
                    entity_kind: "track".into(),
                    entity_id: "same-id".into(),
                },
                EntityUserRatingRefDto {
                    server_id: "s1".into(),
                    entity_kind: "track".into(),
                    entity_id: "same-id".into(),
                },
                EntityUserRatingRefDto {
                    server_id: "".into(),
                    entity_kind: "track".into(),
                    entity_id: "same-id".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].rating, 2);
        assert_eq!(found[1].rating, 4);
        assert!(found.iter().all(|rating| rating.fetched_at >= 100));
    }

    #[test]
    fn entity_user_rating_cache_upsert_replaces_existing_owner_key() {
        let store = LibraryStore::open_in_memory();
        let rating = EntityUserRatingDto {
            server_id: "s1".into(),
            entity_kind: "album".into(),
            entity_id: "a1".into(),
            rating: 3,
            fetched_at: 101,
        };
        put_entity_user_ratings(&store, std::slice::from_ref(&rating), 100).unwrap();
        let mut updated = rating;
        updated.rating = 5;
        updated.fetched_at = 200;
        put_entity_user_ratings(&store, &[updated], 100).unwrap();

        let found = get_entity_user_ratings(
            &store,
            &[EntityUserRatingRefDto {
                server_id: "s1".into(),
                entity_kind: "album".into(),
                entity_id: "a1".into(),
            }],
        )
        .unwrap();
        assert_eq!(found[0].rating, 5);
        assert_eq!(found[0].fetched_at, 200);
    }

    #[test]
    fn entity_user_rating_batch_limit_matches_spec_cap() {
        assert_eq!(ENTITY_USER_RATINGS_BATCH_LIMIT, 300);
    }
}
