"""Read-only diagnostic of windows belonging to one desktop pet process."""
import ctypes
import sys
from ctypes import wintypes

pid = int(sys.argv[1])
u = ctypes.windll.user32
callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

def inspect(hwnd, _):
    owner = wintypes.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    if owner.value != pid:
        return True
    title = ctypes.create_unicode_buffer(256)
    cls = ctypes.create_unicode_buffer(256)
    u.GetWindowTextW(hwnd, title, 256)
    u.GetClassNameW(hwnd, cls, 256)
    rect = wintypes.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(rect))
    print(f"handle={hwnd} class={cls.value!r} title={title.value!r} visible={u.IsWindowVisible(hwnd)} rect=({rect.left},{rect.top},{rect.right},{rect.bottom})")
    return True

u.EnumWindows(callback(inspect), 0)
