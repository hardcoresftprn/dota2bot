import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    token: str = ""
    database_url: str = ""
    db_path: str = "./data/bot.sqlite3"
    interval: int = 600
    openai_key: str = ""
    model: str = "gpt-4.1-mini"
    allowed_ids: frozenset[int] = frozenset()
    port: int = 8080

    @classmethod
    def load(cls):
        load_dotenv()
        config = cls(
            token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
            database_url=os.getenv("DATABASE_URL", "").strip(),
            db_path=os.getenv("DB_PATH", "./data/bot.sqlite3"),
            interval=int(os.getenv("CHECK_INTERVAL_SECONDS", "600")),
            openai_key=os.getenv("OPENAI_API_KEY", "").strip(),
            model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
            allowed_ids=frozenset(int(x.strip()) for x in os.getenv("ALLOWED_USER_IDS", "").split(",") if x.strip()),
            port=int(os.getenv("PORT", "8080")),
        )
        if config.interval < 60:
            raise ValueError("CHECK_INTERVAL_SECONDS должен быть не меньше 60")
        if not 1 <= config.port <= 65535:
            raise ValueError("Некорректный PORT")
        return config
