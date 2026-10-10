#!/usr/bin/env python3
"""Dismiss Android Chrome first-run screens using accessible UI labels."""
import re
import subprocess
import time
import xml.etree.ElementTree as ET

SKIP = (
    'use without an account',
    'continue without an account',
    'no thanks',
    'not now',
    'skip',
    'maybe later',
    'got it',
    'no, thanks',
    'decline',
    'accept & continue',
    'accept and continue',
)
BOUNDS = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')


def adb(*args, timeout=15):
    return subprocess.run(['adb', *args], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, timeout=timeout, check=False)


def find_choice(text):
    try:
        nodes = ET.fromstring(text).iter()
    except ET.ParseError:
        return None
    choices = []
    for node in nodes:
        label = (node.attrib.get('text', '') + ' ' + node.attrib.get('content-desc', '')).strip().lower()
        if not label:
            continue
        bounds = BOUNDS.search(node.attrib.get('bounds', ''))
        if not bounds:
            continue
        for rank, keyword in enumerate(SKIP):
            if keyword in label:
                left, top, right, bottom = map(int, bounds.groups())
                if right > left and bottom > top:
                    choices.append((rank, (left + right) // 2, (top + bottom) // 2, keyword))
                break
    return min(choices) if choices else None


for attempt in range(8):
    adb('shell', 'uiautomator', 'dump', '/sdcard/mpv2-ci-window.xml', timeout=25)
    result = adb('shell', 'cat', '/sdcard/mpv2-ci-window.xml')
    choice = find_choice(result.stdout)
    if not choice:
        print('[chrome-onboarding] No first-run prompt detected')
        break
    _, x, y, keyword = choice
    print(f'[chrome-onboarding] Tap {keyword} at {x},{y}')
    adb('shell', 'input', 'tap', str(x), str(y))
    time.sleep(2.5)
else:
    print('[chrome-onboarding] Maximum welcome steps reached')
