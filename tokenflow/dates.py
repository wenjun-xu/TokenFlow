import calendar
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


_TIME = re.compile(
    r"(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?"
    r"(Z|[+-]\d{2}:\d{2}|[+-]\d{4})?"
)


def parse_time(value):
    """Return exact UTC (whole seconds, fractional digits), or None."""
    if not isinstance(value, str) or not (match := _TIME.fullmatch(value)):
        return None
    day, clock, fraction, offset = match.groups()
    try:
        tz = timezone.utc
        if offset and offset != "Z":
            digits = offset[1:].replace(":", "")
            hours, minutes = int(digits[:2]), int(digits[2:])
            if hours > 23 or minutes > 59:
                return None
            delta = timedelta(hours=hours, minutes=minutes)
            tz = timezone(delta if offset[0] == "+" else -delta)
        instant = datetime.fromisoformat(day + "T" + clock).replace(tzinfo=tz)
        utc = instant.astimezone(timezone.utc)
        return calendar.timegm(utc.timetuple()), (fraction or "").rstrip("0")
    except (ValueError, OverflowError):
        return None


def local_date(key, zone):
    if key is None:
        return None
    try:
        return datetime.fromtimestamp(key[0], timezone.utc).astimezone(zone).date()
    except (OverflowError, OSError, ValueError):
        return None


def system_zone():
    path = Path("/etc/localtime")
    try:
        resolved = str(path.resolve(strict=True))
        if "/zoneinfo/" in resolved:
            name = resolved.split("/zoneinfo/", 1)[1]
            return ZoneInfo(name)
        with path.open("rb") as stream:
            return ZoneInfo.from_file(stream, key="OS localtime (/etc/localtime)")
    except (OSError, ValueError, KeyError) as error:
        raise ValueError("无法读取 OS 本地时区，请检查系统时区配置后重试") from error


class Period:
    def __init__(self, args, zone):
        self.zone = zone
        self.year = self.month = self.day = None
        previous = True
        for field in ("year", "month", "day"):
            raw = args.get(field, "")
            if raw in ("", None):
                previous = False
                continue
            if not previous or not isinstance(raw, str) or not re.fullmatch(r"[0-9]{1,4}", raw):
                raise ValueError("日期条件无效：请选择年、月及有效日期")
            setattr(self, field, int(raw))
        if self.year is not None:
            date(self.year, self.month if self.month is not None else 1, self.day if self.day is not None else 1)
        self.label = "全部时间" if self.year is None else (
            f"{self.year:04}" + (f"-{self.month:02}" if self.month else "")
            + (f"-{self.day:02}" if self.day else "")
        )

    def contains(self, key):
        if self.year is None:
            return True
        current = local_date(key, self.zone)
        # Civil-date membership also handles skipped/repeated historical midnights.
        return current is not None and current.year == self.year and (
            self.month is None or current.month == self.month
        ) and (self.day is None or current.day == self.day)
