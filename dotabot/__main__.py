import argparse
import asyncio
import logging
import signal
import sys

import httpx

from .config import Config
from .service import Service
from .sources import Sources
from .store import Store
from .summary import Summarizer
from .telegram import Telegram, TelegramError


async def health(reader, writer):
    try:
        await asyncio.wait_for(reader.read(4096), timeout=5)
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n")
        await writer.drain()
    except (TimeoutError, ConnectionError):
        pass
    finally:
        writer.close()
        await writer.wait_closed()


async def run(preview=False):
    config = Config.load()
    async with httpx.AsyncClient(headers={"User-Agent": "DotaPatchWatch/1.0"}, follow_redirects=True) as http:
        sources = Sources(http)
        summarizer = Summarizer(http, config.openai_key, config.model)
        if preview:
            patches = await sources.patches()
            event = await sources.patch(patches[-1])
            print(await summarizer.summarize(event))
            return
        if not config.token:
            raise RuntimeError("Заполните TELEGRAM_BOT_TOKEN в .env или переменных окружения. Пример: .env.example")
        store = Store(config.db_path, config.database_url)
        try:
            telegram = Telegram(http, config.token)
            await telegram.start()
            service = Service(config, store, sources, summarizer, telegram)
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(sig, service.stop.set)
            server = await asyncio.start_server(health, "0.0.0.0", config.port)
            logging.info("Бот @%s запущен; интервал %s сек.", telegram.username, config.interval)
            async with server:
                tasks = [asyncio.create_task(service.worker()), asyncio.create_task(service.poll()), asyncio.create_task(service.stop.wait())]
                try:
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            store.close()


def main():
    parser = argparse.ArgumentParser(description="Telegram-бот обновлений Dota 2")
    parser.add_argument("--preview", action="store_true", help="Показать разбор последнего патча без Telegram и базы данных")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # httpx INFO logs contain the Telegram token in request URLs.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    try:
        asyncio.run(run(args.preview))
    except (RuntimeError, ValueError, TelegramError) as error:
        logging.error("%s", error)
        sys.exit(1)
    except Exception as error:
        # Connection exceptions may contain credentials; don't print their repr.
        logging.error("Запуск прерван (%s). Проверьте сеть, конфигурацию и доступ к базе.", type(error).__name__)
        sys.exit(1)


if __name__ == "__main__":
    main()
