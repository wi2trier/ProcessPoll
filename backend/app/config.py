from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

DEMO_RETENTION_DAYS = 7


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PROCESSPOLL_", env_file=".env", extra="ignore")

    database_url: str = "sqlite+aiosqlite:///./processpoll.db"
    env: str = "dev"
    allowed_origins: str = ""
    public_url: str = ""
    trusted_proxy: bool = False
    demo_mode: bool = False

    tick_interval_seconds: float = 0.5
    heartbeat_seconds: float = 15.0

    session_create_per_hour: int = 30
    max_request_bytes: int = 64 * 1024
    join_per_minute_per_session: int = 3000
    unknown_code_per_minute: int = 300
    retention_sweep_seconds: int = 3600
    analytics_cache_size: int = 256
    analytics_cache_per_session: int = 32

    compute_concurrency: int = 3
    compute_queue_limit: int = 64

    compute_processes: int = 0
    compute_timeout_seconds: float = 60.0

    @property
    def is_prod(self) -> bool:
        return self.env.lower() == "prod"

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
