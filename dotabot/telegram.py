import httpx


class TelegramError(Exception):
    def __init__(self, code, retry_after=0):
        self.code, self.retry_after = code, retry_after
        super().__init__(f"Telegram error {code}")


class Telegram:
    def __init__(self, http: httpx.AsyncClient, token):
        self.http = http
        self.base = f"https://api.telegram.org/bot{token}/"
        self.username = ""

    async def call(self, method, **params):
        response = await self.http.post(self.base + method, json=params, timeout=45)
        try:
            data = response.json()
        except ValueError:
            raise TelegramError(response.status_code) from None
        if not data.get("ok"):
            raise TelegramError(data.get("error_code", response.status_code), data.get("parameters", {}).get("retry_after", 0))
        return data["result"]

    async def start(self):
        user = await self.call("getMe")
        self.username = user["username"].lower()
        info = await self.call("getWebhookInfo")
        if info.get("url"):
            raise RuntimeError("Для этого бота уже настроен webhook. Удалите его или используйте нового бота из BotFather.")
        await self.call("setMyCommands", commands=[
            {"command": "start", "description": "Подписаться на важные обновления"},
            {"command": "stop", "description": "Отключить рассылку"},
            {"command": "latest", "description": "Последнее важное обновление"},
            {"command": "status", "description": "Подписка и проверка источников"},
            {"command": "help", "description": "Как пользоваться ботом"},
        ])

    async def send(self, chat_id, text):
        return await self.call("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", link_preview_options={"is_disabled": True})

    async def is_admin(self, message):
        chat = message["chat"]
        if chat["type"] == "private":
            return True
        if message.get("sender_chat", {}).get("id") == chat["id"]:
            return True
        user_id = message.get("from", {}).get("id")
        if not user_id:
            return False
        member = await self.call("getChatMember", chat_id=chat["id"], user_id=user_id)
        return member["status"] in ("creator", "administrator")
