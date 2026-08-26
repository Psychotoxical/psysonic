use std::sync::atomic::{AtomicU64, Ordering};

tokio::task_local! {
    static MIGRATION_WRITE_GENERATION: u64;
}

thread_local! {
    static SYNC_MIGRATION_WRITE_GENERATION: std::cell::Cell<u64> = const {
        std::cell::Cell::new(0)
    };
}

/// Shared stop-the-world token for native stores that persist server-owned IDs.
#[derive(Debug, Default)]
pub struct MigrationWriteBarrier {
    active_generation: AtomicU64,
}

impl MigrationWriteBarrier {
    pub fn activate(&self, generation: u64) -> Result<(), String> {
        if generation == 0 {
            return Err("migration write generation must be non-zero".to_string());
        }
        match self.active_generation.compare_exchange(
            0,
            generation,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => Ok(()),
            Err(active) if active == generation => Ok(()),
            Err(active) => Err(format!(
                "native writers are already blocked by migration generation {active}"
            )),
        }
    }

    pub fn deactivate(&self, generation: u64) -> Result<(), String> {
        self.active_generation
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|active| {
                format!(
                    "cannot release migration generation {generation}; active writer generation is {active}"
                )
            })
    }

    pub fn active_generation(&self) -> u64 {
        self.active_generation.load(Ordering::Acquire)
    }

    pub fn ensure_write_allowed(&self) -> Result<(), String> {
        let active = self.active_generation();
        if active == 0
            || MIGRATION_WRITE_GENERATION
                .try_with(|generation| *generation == active)
                .unwrap_or(false)
            || SYNC_MIGRATION_WRITE_GENERATION.with(|generation| generation.get() == active)
        {
            return Ok(());
        }
        Err(format!(
            "migration generation {active} blocks ordinary native writes"
        ))
    }

    pub async fn scope<F>(generation: u64, future: F) -> F::Output
    where
        F: std::future::Future,
    {
        MIGRATION_WRITE_GENERATION.scope(generation, future).await
    }

    pub fn scope_sync<R>(generation: u64, operation: impl FnOnce() -> R) -> R {
        SYNC_MIGRATION_WRITE_GENERATION.with(|current| {
            let previous = current.replace(generation);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation));
            current.set(previous);
            match result {
                Ok(value) => value,
                Err(payload) => std::panic::resume_unwind(payload),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_scope_allows_only_the_active_generation() {
        let barrier = MigrationWriteBarrier::default();
        barrier.activate(4).unwrap();
        assert!(barrier.ensure_write_allowed().is_err());
        MigrationWriteBarrier::scope_sync(3, || {
            assert!(barrier.ensure_write_allowed().is_err());
        });
        MigrationWriteBarrier::scope_sync(4, || {
            barrier.ensure_write_allowed().unwrap();
        });
        barrier.deactivate(4).unwrap();
        barrier.ensure_write_allowed().unwrap();
    }
}
