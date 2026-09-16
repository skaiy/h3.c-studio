"""Read-only persistence decoding. Never repair, rename or rewrite the source."""
import json
import math
import os
from pathlib import Path
import stat


class BoardStorageError(ValueError):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BoardStorageError("invalid_json")
        result[key] = value
    return result


def _finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise BoardStorageError("invalid_json")
    return result


def _reject_constant(value):
    raise BoardStorageError("invalid_json")


def read_board_object(path: Path) -> dict:
    try:
        path.lstat()
    except FileNotFoundError:
        # A missing leaf in an accessible directory is a first-run database;
        # a broken/missing parent or dangling symlink is not an empty project.
        if path.parent.is_dir():
            return {}
        raise BoardStorageError("io_error") from None
    except OSError:
        raise BoardStorageError("io_error") from None
    try:
        # Do not block startup on FIFOs or follow a substituted symlink.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise BoardStorageError("io_error")
            stream = os.fdopen(fd, "r", encoding="utf-8")
        except BaseException:
            os.close(fd)
            raise
        with stream:
            result = json.load(stream, object_pairs_hook=_unique_object,
                               parse_float=_finite_float, parse_constant=_reject_constant)
    except OSError:
        raise BoardStorageError("io_error") from None
    except (ValueError, UnicodeError, RecursionError) as exc:
        if isinstance(exc, BoardStorageError):
            raise
        raise BoardStorageError("invalid_json") from None
    if not isinstance(result, dict):
        raise BoardStorageError("invalid_schema")
    return result